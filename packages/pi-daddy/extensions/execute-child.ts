import type { Delegation } from "../src/delegate.ts";
import { appendLedgerEvent, buildChildLifecycleEvent } from "../src/ledger.ts";
import { mergeChildEnv } from "../src/propagation.ts";
import type { Capability } from "../src/resolve.ts";
import { ENV_CHILD_TIMEOUT, runChild, timeoutFromEnv } from "../src/run-child.ts";
import { resolveWorkspace } from "../src/herdr-cli.ts";
import { HerdrWriterCloseError, runHerdrPane } from "../src/run-herdr.ts";
import { GovernanceRefusal, refusal, type StructuredRefusal } from "../src/refusals.ts";
import { ENV_HERDR_KEEP_PANE, type GrantsSession } from "./session.ts";
import { releaseDelegationWorkspace, type PreparedWorkspace } from "./workspace-runtime.ts";

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
  outcome: Pick<DelegationOutcome, "ok" | "text" | "timedOut" | "aborted" | "truncated" | "spawnFailed">,
): boolean {
  // `truncated` is deliberately NOT here. The process executor keeps the HEAD of the output
  // (`run-child.ts` slices to the cap and stops appending) and the token is matched at byte 0, so a
  // genuine veto with a rationale over the output cap is still a genuine veto — rejecting it broke the
  // pass-through ADR-0034 pins, in the fix that was supposed to protect it. What must be rejected is a
  // child that never finished speaking: killed, cancelled, or never started.
  if (outcome.ok || outcome.timedOut || outcome.aborted || outcome.spawnFailed) return false;
  return outcome.text.trimStart().startsWith("BLOCKED_CRITICAL_ASSURANCE");
}

export interface ChildProgressUpdate {
  chunk?: string;
  snapshot?: string[];
  paneId?: string;
  agentName?: string;
  state?: "running" | "completed" | "failed";
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
export async function executePlannedChild(input: {
  session: GrantsSession;
  plan: Delegation;
  agent?: string;
  childId: string;
  cwd: string;
  preparedWorkspace?: PreparedWorkspace;
  signal?: AbortSignal;
  onProgress?: (update: ChildProgressUpdate) => void;
}): Promise<DelegationOutcome> {
  const { session, plan, childId, preparedWorkspace, signal, onProgress } = input;
  if (session.ledgerPath) {
    try {
      await appendLedgerEvent(
        { path: session.ledgerPath, strict: true },
        buildChildLifecycleEvent({
          childId,
          state: "starting",
          executor: session.executor.kind,
          correlation: plan.correlation,
          now: new Date(),
        }),
      );
    } catch (error) {
      await releaseDelegationWorkspace({ prepared: preparedWorkspace, childId, reason: "ledger-failed" });
      throw error;
    }
  }

  const cwd = preparedWorkspace?.workspace.root ?? input.cwd;
  const leaseAbort = new AbortController();
  const writerLease = preparedWorkspace?.lease.access === "write" ? preparedWorkspace.lease : undefined;
  // Tracked as a FACT, not only as an abort: "the kernel lock protecting this workspace evaporated under
  // a live governed writer" and "the operator pressed stop" produced byte-identical reasons before, and a
  // count of lost leases is exactly the number an operator auditing this feature needs (R-103).
  let leaseLost = false;
  writerLease?.lost.then(() => { leaseLost = true; leaseAbort.abort(); });
  const executionSignal = signal
    ? AbortSignal.any([signal, leaseAbort.signal])
    : writerLease ? leaseAbort.signal : undefined;
  let releaseReason = "failed";
  let retainWriterLease = false;
  let terminalAttempted = false;
  const teardownFailures: string[] = [];
  try {
    const output = session.executor.kind === "herdr"
      ? await runHerdrPane({
          args: plan.args.slice(0, -1),
          prompt: plan.args[plan.args.length - 1].trimStart(),
          env: plan.env,
          cwd,
          name: `${input.agent ?? "delegate"}-${childId}`,
          workspace: resolveWorkspace(process.env),
          signal: executionSignal,
          timeoutMs: timeoutFromEnv(process.env[ENV_CHILD_TIMEOUT]),
          keepPane: writerLease ? false : process.env[ENV_HERDR_KEEP_PANE] === "1",
          closeOnSettle: Boolean(writerLease),
          onPane: onProgress ? (paneId, agentName) => onProgress({ paneId, agentName, state: "running" }) : undefined,
          onTab: preparedWorkspace ? (tabId) => preparedWorkspace.lease.attachHerdrTab(tabId) : undefined,
          onSnapshot: onProgress ? (snapshot) => onProgress({ snapshot }) : undefined,
        })
      : await runChild({
          command: writerLease ? "setpriv" : "pi",
          args: writerLease ? ["--pdeathsig", "KILL", "--", "pi", ...plan.args] : plan.args,
          env: mergeChildEnv(process.env, plan.env),
          cwd,
          signal: executionSignal,
          timeoutMs: timeoutFromEnv(process.env[ENV_CHILD_TIMEOUT]),
          onOutput: onProgress ? (chunk) => onProgress({ chunk }) : undefined,
          onSpawn: preparedWorkspace ? (pid) => preparedWorkspace.lease.attachProcess(pid) : undefined,
        });

    const childFailed = Boolean(output.spawnError || output.aborted || output.timedOut || output.code !== 0);
    releaseReason = output.timedOut ? "timeout" : output.aborted ? "cancelled" : childFailed ? "failed" : "completed";
    if (session.ledgerPath) {
      terminalAttempted = true;
      await appendLedgerEvent(
        {
          path: session.ledgerPath,
          // NOT strict, and this line is the whole point of R-99. The child has already run: failing
          // closed here prevents nothing and used to discard a completed child's entire output while
          // blaming "ledger" — under `delegate_all` it discarded every sibling's work too. The docstring
          // above, `docs/SPEC.md` and the ADR-0034 amendment all promised this; only the comment changed.
          // `capability_decision`, which PROVISIONS, still fails closed.
          strict: false,
          onFailure: (cause) => teardownFailures.push(`child lifecycle record failed: ${String(cause)}`),
        },
        buildChildLifecycleEvent({
          childId,
          state: childFailed ? "failed" : "completed",
          executor: session.executor.kind,
          exitCode: output.code,
          signal: output.signal ?? null,
          timedOut: output.timedOut,
          aborted: output.aborted,
          truncated: output.truncated,
          reason: output.spawnError,
          correlation: plan.correlation,
          now: new Date(),
        }),
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
            ? "exceeded its time limit and was killed"
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
              : "CHILD_EXIT_NONZERO";
      const failed: DelegationOutcome = {
        ok: false,
        text: output.text.trim(),
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
      text: output.text.trim(),
      granted: plan.effective,
      depth: plan.childDepth,
      exitCode: output.code,
      truncated: output.truncated,
    };
    await teardown();
    return withTeardownNotes(succeeded);
  } catch (error) {
    retainWriterLease = Boolean(writerLease && error instanceof HerdrWriterCloseError);
    if (session.ledgerPath && !terminalAttempted) {
      // Best-effort: this records the failure, so it must not REPLACE the failure. A strict append that
      // throws here would discard the original error — including HerdrWriterCloseError, whose whole
      // meaning is "a lease is deliberately retained" (R-108).
      await appendLedgerEvent(
        {
          path: session.ledgerPath,
          strict: false,
          onFailure: (cause) => teardownFailures.push(`child lifecycle record failed: ${String(cause)}`),
        },
        buildChildLifecycleEvent({
          childId, state: "failed", executor: session.executor.kind,
          reason: error instanceof GovernanceRefusal
            ? error.code
            : error instanceof Error ? error.name : "unknown executor error",
          correlation: plan.correlation, now: new Date(),
        }),
      );
    }
    await teardown();
    // Attached, not dropped. `withTeardownNotes` was applied on both return paths and neither throw path,
    // so a failed lease-release record — the thing that makes the NEXT owner report a phantom crash — was
    // collected into an array nothing read.
    throw errorWithTeardownNotes(error, teardownFailures);
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
    if (teardownFailures.length === 0) return outcome;
    return { ...outcome, reason: [outcome.reason, ...teardownFailures].filter(Boolean).join("; ") };
  }

  async function teardown(): Promise<void> {
    try {
      await releaseDelegationWorkspace({
        prepared: preparedWorkspace,
        childId,
        ledgerPath: session.ledgerPath,
        reason: releaseReason,
        retain: retainWriterLease,
      });
    } catch (error) {
      teardownFailures.push(`workspace lease record failed: ${String(error)}`);
    }
  }
}
