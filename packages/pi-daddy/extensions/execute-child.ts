import { BoundedReadCleanupError } from "../src/kernel/bounded-read.ts";
import { retainDiscoveryCleanupFailure } from "./session.ts";
import type { CapacityReservation } from "../src/kernel/capacity.ts";
import { runHerdrOwned } from "../src/executors/herdr-owned.ts";
import { runCapturedExecution } from "../src/executors/captured-execution.ts";
import type { ChildFinal } from "../src/executors/child-final.ts";
import type { CapturedWorkerCleanup } from "../src/kernel/captured-worker-contract.ts";
import type { Delegation } from "../src/kernel/delegate.ts";
import {
  beginExecutionRetention,
  retentionConfigurationDigest,
  type RetentionStatus,
} from "../src/governance/execution-retention.ts";
import { appendLedgerEvent, buildChildLifecycleEvent } from "../src/governance/ledger.ts";
import { hasFinalizerError } from "../src/governance/finalization.ts";
import { mergeChildEnv } from "../src/kernel/propagation.ts";
import type { Capability } from "../src/kernel/resolve.ts";
import {
  DEFAULT_KILL_GRACE_MS,
  ENV_CHILD_IDLE_TIMEOUT,
  ENV_CHILD_TIMEOUT,
  idleTimeoutFromEnv,
  timeoutFromEnv,
} from "../src/kernel/run-child.ts";
import { activitySessionFor } from "../src/executors/activity-session.ts";
import { processTreeActivity } from "../src/executors/process-activity.ts";
import { resolveWorkspace } from "../src/executors/herdr-cli.ts";
import { HerdrWriterCloseError } from "../src/executors/run-herdr.ts";
import { GovernanceRefusal, refusal, type StructuredRefusal } from "../src/kernel/refusals.ts";
import { ENV_HERDR_KEEP_PANE, type GrantsSession } from "./session.ts";
import { CHILD_ATTRIBUTION_ENV_KEYS, ENV_EPISODE_ID } from "../src/kernel/env-names.ts";
import { releaseDelegationWorkspace, type PreparedWorkspace } from "./workspace-runtime.ts";
import { ActivityTimelineRecorder, ENV_ACTIVITY_PARENT_TASK } from "../src/products/activity-timeline.ts";
import { resolvedModelOf, type ResolvedDefinitionRuntime } from "./definition-runtime.ts";
export interface DelegationOutcome {
  ok: boolean;
  text: string;
  reason?: string;
  granted: Capability[];
  depth: number;
  exitCode: number | null;
  refusal?: StructuredRefusal;
  /** Why the child stopped. Load-bearing for `isCriticalAssuranceBlock`, which must not trust text alone. */
  timedOut?: boolean;
  aborted?: boolean;
  truncated?: boolean;
  spawnFailed?: boolean;
  retention?: RetentionStatus;
  /** A loud best-effort post-execution observation failure; execution ownership is still settled. */
  control?: "failed";
  work?: "succeeded" | "failed" | "unknown";
  final?: ChildFinal;
  cleanup?: CapturedWorkerCleanup;
  observation?: { state: "complete" | "incomplete"; reasons: string[] };
  diagnostics?: string;
  diagnosticsTruncated?: boolean;
}
/**
 * The upstream controller's token, honoured ONLY when the child otherwise exited cleanly non-zero.
 *
 * `text` is the child's own captured output, and under ADR-0012 it can carry content the child merely
 * *read* from a repository. Matching on text alone let a timeout, a cancellation, a lost writer lease or
 * a truncated answer all be reported as a clean upstream veto — with the governance-authored reason and
 * refusal code discarded on the way (R-106). A child that is killed mid-sentence has not been assessed
 * by anybody's gate, so the token cannot be taken at its word there.
 */
export function isCriticalAssuranceBlock(
  outcome: Pick<
    DelegationOutcome,
    "ok" | "text" | "exitCode" | "timedOut" | "aborted" | "truncated" | "spawnFailed" | "control" | "cleanup"
  >,
): boolean {
  // `truncated` is deliberately NOT here. The process executor keeps the HEAD of the output
  // (`run-child.ts` slices to the cap and stops appending) and the token is matched at byte 0, so a
  // genuine veto with a rationale over the output cap is still a genuine veto — rejecting it broke the
  // pass-through ADR-0034 pins, in the fix that was supposed to protect it. What must be rejected is a
  // child that never finished speaking: killed, cancelled, or never started.
  if (
    outcome.ok ||
    outcome.timedOut ||
    outcome.aborted ||
    outcome.spawnFailed ||
    outcome.control === "failed" ||
    outcome.cleanup?.state === "unknown" ||
    !(outcome.exitCode !== null && outcome.exitCode > 0)
  )
    return false;
  return outcome.text.trimStart().startsWith("BLOCKED_CRITICAL_ASSURANCE");
}

export async function appendAfterRuntimeRecord<T>(
  runtimeRecord: Promise<void> | undefined,
  appendTerminal: () => Promise<T>,
): Promise<T> {
  if (runtimeRecord) await runtimeRecord;
  return appendTerminal();
}

/** A failed writer-tab close may be secondary to the executor error that triggered cleanup. */
export function isHerdrWriterCloseFailure(error: unknown): boolean {
  return (
    error instanceof HerdrWriterCloseError ||
    hasFinalizerError(error, (value) => value instanceof HerdrWriterCloseError)
  );
}
export interface ChildProgressUpdate {
  chunk?: string;
  snapshot?: string[];
  paneId?: string;
  agentName?: string;
  state?: "starting" | "running" | "completed" | "failed";
}
/**
 * Execute one already-approved plan, record lifecycle, and release any workspace lease on every path
 * EXCEPT a failed herdr writer-tab close, which deliberately retains the lease because the pane may
 * still be live and promptable — that retention is recorded as `retained` rather than left as a silent
 * gap in the trail (R-104).
 *
 * Teardown never destroys the result. A terminal ledger append is an OBSERVATION written after the child
 * has already run, so failing closed there prevents nothing and used to discard completed work while
 * blaming "ledger" (R-99). The failure is reported alongside the outcome instead of replacing it.
 */
export interface ChildExecutionInput {
  session: GrantsSession;
  capacityReservation?: CapacityReservation;
  plan: Delegation;
  agent?: string;
  childId: string;
  executionId: string;
  parentExecutionId: string | null;
  toolCallId?: string;
  cwd: string;
  preparedWorkspace?: PreparedWorkspace;
  resolvedRuntime?: ResolvedDefinitionRuntime;
  signal?: AbortSignal;
  onProgress?: (update: ChildProgressUpdate) => void;
}
export async function executePlannedChild(input: ChildExecutionInput): Promise<DelegationOutcome> {
  let executorEntered = false;
  const runtime = input.session.reloadLifecycle?.runtimeSettlement;
  let registered = false;
  try {
    runtime?.begin(input.executionId);
    registered = Boolean(runtime);
    const result = await executePreparedChild(
      input,
      () => {
        executorEntered = true;
      },
      runtime,
    );
    try {
      await runtime?.finish(
        input.executionId,
        result.cleanup ?? { state: "unknown", reason: "executor omitted cleanup" },
        result.control === "failed" ? (result.reason ?? "runtime control failed") : undefined,
      );
    } catch (error) {
      return {
        ...result,
        control: "failed",
        reason: [result.reason, `runtime settlement record failed: ${String(error)}`].filter(Boolean).join("; "),
      };
    }
    return result;
  } catch (error) {
    const failures: unknown[] = [error];
    if (registered)
      try {
        await runtime?.finish(input.executionId, {
          state: executorEntered ? "unknown" : "not-started",
          reason: String(error),
        });
      } catch (recordError) {
        failures.push(recordError);
      }
    if (executorEntered) {
      if (failures.length > 1) throw new AggregateError(failures, failures.map(String).join("; "));
      throw error;
    }
    // Setup failures prove no worker started, even if recording that fact also failed.
    input.capacityReservation?.finalize({ state: "not-started", reason: "child setup failed before executor entry" });
    try {
      const released = await releaseDelegationWorkspace({
        prepared: input.preparedWorkspace,
        childId: input.childId,
        episodeId: input.session.episodeId,
        executionId: input.executionId,
        parentExecutionId: input.parentExecutionId,
        ledgerPath: input.session.ledgerPath,
        reason: "setup-failed",
      });
      if (released === "lost" || released === "retained")
        failures.push(new Error(`workspace setup release is ${released}`));
    } catch (releaseError) {
      failures.push(releaseError);
    }
    try {
      input.plan.disposeHandoff?.();
    } catch (disposeError) {
      failures.push(disposeError);
    }
    if (failures.length > 1) throw new AggregateError(failures, failures.map(String).join("; "));
    throw error;
  }
}
async function executePreparedChild(
  input: ChildExecutionInput,
  onExecutorEntry: () => void,
  runtime?: import("../src/governance/runtime-settlement.ts").RuntimeSettlement,
): Promise<DelegationOutcome> {
  const { session, plan, childId, executionId, parentExecutionId, preparedWorkspace, signal, onProgress } = input;
  const ledgerPath = session.ledgerPath;
  let executorEntered = false;
  const teardownFailures: string[] = [];
  const controlFailures: string[] = [];
  const lifecycle = session.reloadLifecycle;
  const onReadCleanup = (error: BoundedReadCleanupError): void => {
    if (lifecycle) retainDiscoveryCleanupFailure(session, error, lifecycle);
    controlFailures.push(`session read cleanup unresolved: ${error.message}`);
  };
  const runtimeAttribution = (observed?: {
    resolvedModel?: { provider: string; modelId: string };
    thinking?: string;
  }) => ({
    resolvedModel: observed?.resolvedModel ?? resolvedModelOf(input.resolvedRuntime?.model) ?? undefined,
    modelSource: input.resolvedRuntime?.modelSource ?? ("pi" as const),
    effectiveThinkingLevel: observed?.thinking ?? input.resolvedRuntime?.thinking,
    thinkingSource: input.resolvedRuntime?.thinkingSource ?? ("pi" as const),
  });
  let activityParent: string | undefined,
    activity = new ActivityTimelineRecorder(input.cwd),
    activityStarted = false,
    activityFinished = false;
  try {
    const env = { ...process.env };
    for (const name of [
      "PI_DADDY_ACTIVITY_PATH",
      "PI_DADDY_ACTIVITY_ROOT",
      "PI_DADDY_ACTIVITY_TASK",
      ENV_ACTIVITY_PARENT_TASK,
      ENV_EPISODE_ID,
    ]) {
      const value = plan.env[name];
      if (value) env[name] = value;
    }
    activity = new ActivityTimelineRecorder(input.cwd, env);
    activityParent = plan.env[ENV_ACTIVITY_PARENT_TASK];
  } catch {}
  try {
    await activity.childStarted(
      executionId,
      activityParent,
      input.agent ?? "governed child",
      (plan.args.at(-1) ?? "").trimStart(),
    );
    activityStarted = true;
  } catch {}
  const configuredTimeoutMs = timeoutFromEnv(process.env[ENV_CHILD_TIMEOUT]);
  // PR 3e: the working bound is inactivity; `deadlineAt` below is the runaway ceiling. Every child gets a pi session
  // file so the parent can see it working when its stdout is quiet (pi appends each message and tool result to it).
  const configuredIdleMs = idleTimeoutFromEnv(process.env[ENV_CHILD_IDLE_TIMEOUT]);
  const activitySession = await activitySessionFor(plan.args, executionId);
  // Disposed on every path (review finding: it leaked on every throw), except when the operator keeps a Herdr pane,
  // where the interactive pi in that pane is still alive and still appending to this file.
  const keepPaneRequested = false; // The qualified pane launcher exits; retained panes contain no live Pi writer.
  try {
    return await executeWithActivitySession();
  } finally {
    if (!keepPaneRequested) await activitySession.dispose();
    // ADR-0078: a fork wrote a COPY of the parent's whole session to disk. PR 3e deletes its own temp session on
    // every path and this must too, or every forked child leaves a full transcript behind for good.
    if (!keepPaneRequested)
      try {
        plan.disposeHandoff?.();
      } catch {
        /* teardown must not replace the child's outcome */
      }
  }

  async function observeUsage(): Promise<import("../src/executors/activity-session.ts").ChildUsageObservation> {
    try {
      return await activitySession.usage();
    } catch (error) {
      if (error instanceof BoundedReadCleanupError) onReadCleanup(error);
      teardownFailures.push(`usage observation unavailable: ${String(error)}`);
      return { unavailable: "session-invalid" };
    }
  }
  async function executeWithActivitySession(): Promise<DelegationOutcome> {
    const args = activitySession.args;
    // The process executor adds a second signal that is live during a tool call: the child tree's CPU time and
    // descendants (`process-activity.ts`). Herdr children are started by the daemon, so their pid is not known here.
    let childPid: number | undefined;
    const probe = async () => {
      const [file, tree] = await Promise.all([
        activitySession.probe(),
        childPid === undefined ? undefined : processTreeActivity(childPid),
      ]);
      return file === undefined && tree === undefined ? undefined : `${file ?? "-"}|${tree ?? "-"}`;
    };
    const startedAt = new Date();
    const deadlineAt = new Date(startedAt.getTime() + configuredTimeoutMs).toISOString();
    if (ledgerPath) {
      try {
        await appendLedgerEvent(
          {
            path: ledgerPath,
            strict: false,
            onFailure: (cause) => teardownFailures.push(`starting observation failed: ${String(cause)}`),
          },
          buildChildLifecycleEvent({
            episodeId: session.episodeId,
            executionId,
            parentExecutionId,
            childId,
            state: "starting",
            executor: session.executor.kind,
            deadlineAt,
            idleTimeoutMs: configuredIdleMs,
            exportedEnvironment: CHILD_ATTRIBUTION_ENV_KEYS,
            ...runtimeAttribution(),
            definitionHash: plan.definitionHash,
            definitionPackageVersion: plan.definitionPackageVersion,
            correlation: plan.correlation,
            now: startedAt,
          }),
        );
      } catch (error) {
        throw error;
      }
    }
    // The recorded deadline and executor timer are one fact. Waiting for the strict starting append consumes
    // the budget; handing the child a fresh full timeout would leave it live after the dashboard truthfully
    // marked that deadline incomplete.
    const remainingTimeoutMs = Math.max(1, Date.parse(deadlineAt) - Date.now());
    const terminationGraceMs = Math.min(DEFAULT_KILL_GRACE_MS, Math.max(1, Math.floor(remainingTimeoutMs / 10)));
    const cwd = preparedWorkspace?.workspace.root ?? input.cwd;
    const leaseAbort = new AbortController();
    const writerLease = preparedWorkspace?.lease.access === "write" ? preparedWorkspace.lease : undefined;
    // Tracked as a FACT, not only as an abort: "the kernel lock protecting this workspace evaporated under
    // a live governed writer" and "the operator pressed stop" produced byte-identical reasons before, and a
    // count of lost leases is exactly the number an operator auditing this feature needs (R-103).
    let leaseLost = false;
    writerLease?.lost.then(() => {
      leaseLost = true;
      leaseAbort.abort();
    });
    const executionSignals = [...(signal ? [signal] : []), ...(writerLease ? [leaseAbort.signal] : [])];
    const executionSignal = AbortSignal.any(executionSignals);
    const retention = beginExecutionRetention({
      executionId,
      parentExecutionId,
      childId,
      toolCallId: input.toolCallId ?? null,
      executor: session.executor.kind,
      taskDigest: plan.taskDigest,
      definitionDigest: plan.definitionDigest?.sha256 ?? null,
      configurationDigest: retentionConfigurationDigest({
        args: plan.args,
        effective: plan.effective,
        timeoutMs: configuredTimeoutMs,
      }),
      workspaceId: preparedWorkspace?.workspace.workspaceId ?? null,
    });
    const sessionFlag = plan.args.indexOf("--session");
    if (sessionFlag >= 0) retention.observeSession({ source: "pi-session-file", value: plan.args[sessionFlag + 1] });
    let releaseReason = "failed";
    let retainWriterLease = false;
    let terminalAttempted = false;

    let runtimeRecord: Promise<void> | undefined;
    const recordRunning = (executor: "process" | "herdr", pane?: { id: string; agentName: string }): void => {
      if (!ledgerPath) return;
      try {
        runtimeRecord = appendLedgerEvent(
          {
            path: ledgerPath,
            strict: false,
            onFailure: (cause) => teardownFailures.push(`child runtime identity record failed: ${String(cause)}`),
          },
          buildChildLifecycleEvent({
            episodeId: session.episodeId,
            executionId,
            parentExecutionId,
            childId,
            state: "running",
            executor,
            deadlineAt,
            idleTimeoutMs: configuredIdleMs,
            ...(pane ? { herdrPaneId: pane.id, herdrAgentName: pane.agentName } : {}),
            exportedEnvironment: CHILD_ATTRIBUTION_ENV_KEYS,
            ...runtimeAttribution(),
            definitionHash: plan.definitionHash,
            definitionPackageVersion: plan.definitionPackageVersion,
            correlation: plan.correlation,
            now: new Date(),
          }),
        );
      } catch (error) {
        teardownFailures.push(`child runtime identity record failed: ${String(error)}`);
      }
    };
    try {
      if (session.executor.refusal)
        throw new GovernanceRefusal(refusal("EXECUTOR_UNAVAILABLE", session.executor.refusal));
      executorEntered = true;
      onExecutorEntry();
      let displayHerdr: ((text: string) => void) | undefined;
      const output = await runCapturedExecution(
        {
          executionId,
          sessionPath: activitySession.path,
          onReadCleanup,
          onOwnership: async (identity) => {
            runtime?.bind(identity);
            input.capacityReservation?.bindOwnership(identity);
            await preparedWorkspace?.lease.attachCapturedWorker(identity);
          },
          command: "pi",
          args,
          env: mergeChildEnv(process.env, plan.env),
          cwd,
          signal: executionSignal,
          // SIGTERM gets only grace that fits INSIDE the recorded deadline. The independent hard timer
          // prevents a delayed soft-timeout callback from starting a fresh grace period beyond that bound.
          timeoutMs: Math.max(1, remainingTimeoutMs - terminationGraceMs),
          hardDeadlineAt: Date.parse(deadlineAt),
          idleTimeoutMs: configuredIdleMs,
          activityProbe: probe,
          onOutput: (chunk) => {
            displayHerdr?.(chunk);
            onProgress?.({ chunk });
          },
          onObservation: (stream, bytes) => retention.capture(stream, bytes),
          onSpawn: (pid) => {
            childPid = pid;
            // Lease attachment is a security hook and may fail the spawn. The shared reporters isolate
            // display exceptions before they reach this callback; runChild deliberately kills on any error
            // here, so presentation must never be added directly without that reporter boundary.

            retention.native({ pid });
            recordRunning(session.executor.kind);
            onProgress?.({ state: "running" });
          },
        },
        session.executor.kind === "herdr"
          ? (request) =>
              runHerdrOwned(request, {
                onDisplay: (display) => {
                  displayHerdr = display;
                },
                workspace: resolveWorkspace(process.env),
                keepPane: process.env[ENV_HERDR_KEEP_PANE] === "1",
                onPane: (paneId, tabId) => {
                  retention.native({ paneId, tabId });
                  onProgress?.({ paneId, state: "starting" });
                },
              })
          : undefined,
      );

      if (sessionFlag >= 0) retention.observeSession({ source: "pi-session-file", value: plan.args[sessionFlag + 1] });
      retention.capture("result", Buffer.from(output.text), true);
      if ("diagnosticsTruncated" in output && output.diagnosticsTruncated)
        teardownFailures.push("diagnostic output truncated");
      const final = "final" in output ? (output.final as ChildFinal) : undefined;
      const cleanup = "cleanup" in output ? (output.cleanup as CapturedWorkerCleanup) : undefined;
      input.capacityReservation?.finalize(
        cleanup ?? { state: "unknown", reason: "executor supplied no qualified cleanup" },
      );
      const workFailed = Boolean(output.spawnError || output.aborted || output.timedOut || output.code !== 0);
      const finalUnavailable = final?.state === "unavailable";
      const cleanupUnknown = cleanup?.state === "unknown";
      retainWriterLease = Boolean(writerLease && cleanupUnknown);
      const childFailed = workFailed || finalUnavailable || cleanupUnknown;
      retention.finish({
        code: output.code,
        signal: output.signal ?? null,
        timedOut: output.timedOut,
        aborted: output.aborted,
        truncated: output.truncated,
        failed: childFailed,
      });
      const usageObservation = await observeUsage();

      releaseReason = output.timedOut ? "timeout" : output.aborted ? "cancelled" : childFailed ? "failed" : "completed";
      if (activityStarted)
        try {
          await activity.childFinished(
            executionId,
            activityParent,
            input.agent ?? "governed child",
            output.text,
            childFailed ? (output.aborted ? "cancelled" : "failed") : "completed",
          );
          activityFinished = true;
        } catch {
          /* observation does not control execution */
        }
      if (ledgerPath) {
        terminalAttempted = true;
        await appendAfterRuntimeRecord(runtimeRecord, () =>
          appendLedgerEvent(
            {
              path: ledgerPath,
              // NOT strict, and this line is the whole point of R-99. The child has already run: failing
              // closed here prevents nothing and used to discard a completed child's entire output while
              // blaming "ledger" — under `delegate_all` it discarded every sibling's work too. The docstring
              // above, the README and the ADR-0034 amendment all promised this; only the comment changed.
              // `capability_decision`, which PROVISIONS, still fails closed.
              strict: false,
              onFailure: (cause) => teardownFailures.push(`child lifecycle record failed: ${String(cause)}`),
            },
            buildChildLifecycleEvent({
              episodeId: session.episodeId,
              executionId,
              parentExecutionId,
              childId,
              state: childFailed ? "failed" : "completed",
              executor: session.executor.kind,
              exitCode: output.code,
              signal: output.signal ?? null,
              timedOut: output.timedOut,
              aborted: output.aborted,
              truncated: output.truncated,
              idleTimeoutMs: configuredIdleMs,
              reason:
                output.spawnError ?? (output.timedOut ? (output.idle ? "idle-timeout" : "wall-clock") : undefined),
              exportedEnvironment: CHILD_ATTRIBUTION_ENV_KEYS,
              definitionHash: plan.definitionHash,
              definitionPackageVersion: plan.definitionPackageVersion,
              ...runtimeAttribution({
                ...(usageObservation.resolvedModel ? { resolvedModel: usageObservation.resolvedModel } : {}),
                ...(usageObservation.effectiveThinkingLevel
                  ? { thinking: usageObservation.effectiveThinkingLevel }
                  : {}),
              }),
              ...(usageObservation.tokenDetail ? { tokenDetail: usageObservation.tokenDetail } : {}),
              ...(usageObservation.usage
                ? { usage: usageObservation.usage }
                : { usageUnavailable: usageObservation.unavailable! }),
              ...(usageObservation.compactionCount !== undefined
                ? { compactionCount: usageObservation.compactionCount }
                : {}),
              correlation: plan.correlation,
              now: new Date(),
            }),
          ),
        );
      }

      const leaseWasLost = writerLease ? leaseLost : false;
      if (childFailed) {
        const why = output.spawnError
          ? `could not be started: ${output.spawnError}`
          : output.aborted
            ? leaseWasLost
              ? "lost the exclusive writer lease protecting its workspace and was stopped"
              : "was cancelled"
            : output.timedOut
              ? output.idle
                ? `showed no activity for ${describeBound(configuredIdleMs)} and was killed ` +
                  `(${ENV_CHILD_IDLE_TIMEOUT} sets the bound in seconds)`
                : `ran past its ${describeBound(configuredTimeoutMs)} ceiling and was killed ` +
                  `(${ENV_CHILD_TIMEOUT} sets it in seconds)`
              : finalUnavailable
                ? `has no attributable complete final: ${final.reason}`
                : cleanupUnknown
                  ? `has unverified subtree cleanup: ${cleanup.reason}`
                  : `exited with code ${output.code}`;
        // A stable code for every execution failure. Without these an external controller could tell a
        // policy refusal from an internal error, but not a lost writer lease from a user pressing stop
        // (R-103), and not a missing `setpriv` from an ordinary crash (R-107).
        const code = output.spawnError
          ? "EXECUTOR_UNAVAILABLE"
          : leaseWasLost
            ? "WORKSPACE_LEASE_STALE"
            : output.timedOut
              ? "CHILD_TIMED_OUT"
              : output.aborted
                ? "CHILD_CANCELLED"
                : output.code === 0 && (finalUnavailable || cleanupUnknown)
                  ? "EXECUTOR_UNAVAILABLE"
                  : "CHILD_EXIT_NONZERO";
        const failed: DelegationOutcome = {
          ok: false,
          work: workFailed ? "failed" : final?.state === "complete" ? "succeeded" : "unknown",
          ...(final ? { final } : {}),
          ...(cleanup ? { cleanup } : {}),
          ...("diagnostics" in output ? { diagnostics: String(output.diagnostics) } : {}),
          ...("diagnosticsTruncated" in output ? { diagnosticsTruncated: Boolean(output.diagnosticsTruncated) } : {}),
          ...(cleanupUnknown ? { control: "failed" as const } : {}),
          text: output.text,
          reason: `the sub-agent ${why}`,
          granted: plan.effective,
          depth: plan.childDepth,
          exitCode: output.code,
          refusal: refusal(code, `the sub-agent ${why}`, { child_id: childId }),
          timedOut: output.timedOut,
          aborted: output.aborted,
          truncated: output.truncated,
          spawnFailed: Boolean(output.spawnError),
        };
        await teardown();
        return withTeardownNotes(failed);
      }

      const succeeded: DelegationOutcome = {
        ok: true,
        work: "succeeded",
        ...(final ? { final } : {}),
        ...(cleanup ? { cleanup } : {}),
        ...("diagnostics" in output ? { diagnostics: String(output.diagnostics) } : {}),
        ...("diagnosticsTruncated" in output ? { diagnosticsTruncated: Boolean(output.diagnosticsTruncated) } : {}),
        text: output.text,
        granted: plan.effective,
        depth: plan.childDepth,
        exitCode: output.code,
        truncated: output.truncated,
      };
      await teardown();
      return withTeardownNotes(succeeded);
    } catch (error) {
      if (!executorEntered) throw error;
      if (activityStarted && !activityFinished)
        try {
          await activity.childFinished(
            executionId,
            activityParent,
            input.agent ?? "governed child",
            "",
            signal?.aborted ? "cancelled" : "failed",
          );
        } catch {
          /* observation does not control execution */
        }
      retention.finish({
        code: null,
        signal: null,
        timedOut: false,
        aborted: Boolean(signal?.aborted),
        truncated: false,
        failed: true,
      });
      retainWriterLease ||= Boolean(writerLease && isHerdrWriterCloseFailure(error));
      const usageObservation = await observeUsage();
      if (ledgerPath && !terminalAttempted) {
        // Best-effort: this records the failure, so it must not REPLACE the failure. A strict append that
        // throws here would discard the original error — including HerdrWriterCloseError, whose whole
        // meaning is "a lease is deliberately retained" (R-108).
        await appendAfterRuntimeRecord(runtimeRecord, () =>
          appendLedgerEvent(
            {
              path: ledgerPath,
              strict: false,
              onFailure: (cause) => teardownFailures.push(`child lifecycle record failed: ${String(cause)}`),
            },
            buildChildLifecycleEvent({
              episodeId: session.episodeId,
              executionId,
              parentExecutionId,
              childId,
              state: "failed",
              executor: session.executor.kind,
              idleTimeoutMs: configuredIdleMs,
              reason:
                error instanceof GovernanceRefusal
                  ? error.code
                  : error instanceof Error
                    ? error.name
                    : "unknown executor error",
              exportedEnvironment: CHILD_ATTRIBUTION_ENV_KEYS,
              definitionHash: plan.definitionHash,
              definitionPackageVersion: plan.definitionPackageVersion,
              ...runtimeAttribution({
                ...(usageObservation.resolvedModel ? { resolvedModel: usageObservation.resolvedModel } : {}),
                ...(usageObservation.effectiveThinkingLevel
                  ? { thinking: usageObservation.effectiveThinkingLevel }
                  : {}),
              }),
              ...(usageObservation.tokenDetail ? { tokenDetail: usageObservation.tokenDetail } : {}),
              ...(usageObservation.usage
                ? { usage: usageObservation.usage }
                : { usageUnavailable: usageObservation.unavailable! }),
              ...(usageObservation.compactionCount !== undefined
                ? { compactionCount: usageObservation.compactionCount }
                : {}),
              correlation: plan.correlation,
              now: new Date(),
            }),
          ),
        );
      }
      await teardown();
      // Attached, not dropped. `withTeardownNotes` was applied on both return paths and neither throw path,
      // so a failed lease-release record — the thing that makes the NEXT owner report a phantom crash — was
      // collected into an array nothing read.
      throw errorWithTeardownNotes(error, [...controlFailures, ...teardownFailures]);
    }
    /**
     * Surfaces a teardown failure WITHOUT discarding the result. The child already ran; telling the
     * orchestrator "ledger write failed" and nothing else made a completed delegation indistinguishable
     * from one that never happened, which is the one confusion this package must never create (R-99).
     */
    /**
     * Surfaces a failed best-effort RECORD without displacing the failure it was recording. A
     * `GovernanceRefusal` keeps its `code`, so a controller switching on it still sees the real refusal
     * rather than a ledger complaint. pi renders only `error.message` (its `createErrorToolResult` drops
     * everything else), so the notes go INTO the message — an `AggregateError.errors` array would be invisible.
     */
    function errorWithTeardownNotes(error: unknown, notes: readonly string[]): unknown {
      if (notes.length === 0) return error;
      if (error instanceof GovernanceRefusal) {
        return new GovernanceRefusal({
          code: error.code,
          message: [error.message, ...notes].join("; "),
          ...(error.details ? { details: error.details } : {}),
        });
      }
      if (error instanceof Error) return new Error([error.message, ...notes].join("; "), { cause: error });
      return error;
    }
    function withTeardownNotes(outcome: DelegationOutcome): DelegationOutcome {
      const observed = {
        ...outcome,
        retention: retention.status(),
        observation: {
          state: teardownFailures.length ? ("incomplete" as const) : ("complete" as const),
          reasons: [...teardownFailures],
        },
      };
      if (teardownFailures.length === 0 && controlFailures.length === 0) return observed;
      return {
        ...observed,
        ...(controlFailures.length ? { control: "failed" as const } : {}),
        reason: [outcome.reason, ...controlFailures, ...teardownFailures].filter(Boolean).join("; "),
      };
    }

    async function teardown(): Promise<void> {
      try {
        const outcome = await releaseDelegationWorkspace({
          prepared: preparedWorkspace,
          childId,
          episodeId: session.episodeId,
          executionId,
          parentExecutionId,
          ledgerPath,
          reason: releaseReason,
          retain: retainWriterLease,
          onObservationFailure: (error) =>
            teardownFailures.push(`workspace release observation failed: ${String(error)}`),
        });
        if (outcome === "lost" || (outcome === "retained" && !retainWriterLease))
          controlFailures.push(`workspace release is ${outcome}`);
      } catch (error) {
        controlFailures.push(`workspace release failed: ${String(error)}`);
      }
    }
  }
}

function describeBound(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} second(s)` : `${Math.round(ms / 60_000)} minute(s)`;
}
