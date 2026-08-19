import type { Delegation } from "../src/delegate.ts";
import { appendLedgerEvent, buildChildLifecycleEvent } from "../src/ledger.ts";
import { mergeChildEnv } from "../src/propagation.ts";
import type { Capability } from "../src/resolve.ts";
import { ENV_CHILD_TIMEOUT, runChild, timeoutFromEnv } from "../src/run-child.ts";
import { resolveWorkspace } from "../src/herdr-cli.ts";
import { HerdrWriterCloseError, runHerdrPane } from "../src/run-herdr.ts";
import type { StructuredRefusal } from "../src/refusals.ts";
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
}

export function isCriticalAssuranceBlock(outcome: Pick<DelegationOutcome, "ok" | "text">): boolean {
  return !outcome.ok && outcome.text.trimStart().startsWith("BLOCKED_CRITICAL_ASSURANCE");
}

export interface ChildProgressUpdate {
  chunk?: string;
  snapshot?: string[];
  paneId?: string;
  agentName?: string;
  state?: "running" | "completed" | "failed";
}

/** Execute one already-approved plan, record lifecycle, and release any workspace lease on every path. */
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
  writerLease?.lost.then(() => leaseAbort.abort());
  const executionSignal = signal
    ? AbortSignal.any([signal, leaseAbort.signal])
    : writerLease ? leaseAbort.signal : undefined;
  let releaseReason = "failed";
  let retainWriterLease = false;
  let terminalAttempted = false;
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
        { path: session.ledgerPath, strict: true },
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

    if (childFailed) {
      const why = output.spawnError
        ? `could not be started: ${output.spawnError}`
        : output.aborted
          ? "was cancelled"
          : output.timedOut
            ? "exceeded its time limit and was killed"
            : `exited with code ${output.code}`;
      return {
        ok: false,
        text: output.text.trim(),
        reason: `the sub-agent ${why}`,
        granted: plan.effective,
        depth: plan.childDepth,
        exitCode: output.code,
      };
    }

    return {
      ok: true,
      text: output.text.trim(),
      granted: plan.effective,
      depth: plan.childDepth,
      exitCode: output.code,
    };
  } catch (error) {
    retainWriterLease = Boolean(writerLease && error instanceof HerdrWriterCloseError);
    if (session.ledgerPath && !terminalAttempted) {
      await appendLedgerEvent(
        { path: session.ledgerPath, strict: true },
        buildChildLifecycleEvent({
          childId, state: "failed", executor: session.executor.kind,
          reason: error instanceof Error ? error.name : "unknown executor error",
          correlation: plan.correlation, now: new Date(),
        }),
      );
    }
    throw error;
  } finally {
    if (!retainWriterLease) {
      await releaseDelegationWorkspace({
        prepared: preparedWorkspace,
        childId,
        ledgerPath: session.ledgerPath,
        reason: releaseReason,
      });
    }
  }
}
