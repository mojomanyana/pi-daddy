/** Model-visible projection of runtime facts. UI-only details never reach provider tool output.
 * Keep authored final text and raw result objects unchanged. This is process settlement evidence,
 * not task acceptance or a claim that a disposable workspace was removed.
 *
 * Two forms of one allowlist (owner decision 2026-11-17). Version 1 (`executionEvidence`) is the complete
 * projection: final identity, process receipt, paths. Opt-in public capture records it as `runtimeEvidence`.
 * The model receives version 2, a summary computed from version 1 alone: it cannot carry a field version 1 did
 * not allow, and every value keeps its version 1 path. The complete receipt stays outside model context: in the
 * tool result details (kept in the Pi session file when the session is persisted) and in opt-in public capture.
 * The runtime settlement journal keeps only its identity and SHA-256, a stable operation's record keeps its
 * `receiptPath` and `executionId`, and the receipt file itself is in the OS temporary directory.
 */
import type { DelegationOutcome } from "./execute-child.ts";
import type { CapturedWorkerIdentity } from "../src/kernel/captured-worker-contract.ts";

function identity(value: CapturedWorkerIdentity) {
  return {
    revision: value.revision,
    executionId: value.executionId,
    nonce: value.nonce,
    root: value.root,
    rootDevice: value.rootDevice,
    rootInode: value.rootInode,
    bootId: value.bootId,
    pidNamespace: value.pidNamespace,
    helperPid: value.helperPid,
    helperStartTicks: value.helperStartTicks,
    helperSha256: value.helperSha256,
    workerPid: value.workerPid,
    ownershipPath: value.ownershipPath,
    receiptPath: value.receiptPath,
  };
}
function cleanup(value: DelegationOutcome["cleanup"]) {
  if (!value) return null;
  if (value.state === "not-started") return { state: value.state, reason: value.reason };
  if (value.state === "unknown")
    return {
      state: value.state,
      ...(value.identity ? { identity: identity(value.identity) } : {}),
      reason: value.reason,
    };
  return {
    state: value.state,
    identity: identity(value.identity),
    receipt: {
      state: value.receipt.state,
      identity: identity(value.receipt.identity),
      workerCode: value.receipt.workerCode,
      workerSignal: value.receipt.workerSignal,
      reason: value.receipt.reason,
      reapedAll: value.receipt.reapedAll,
    },
  };
}
function outcomeEvidence(outcome: DelegationOutcome, index: number): AttemptEvidence & { retry?: RetryEvidence } {
  return {
    ...attemptEvidence(outcome, index),
    // 2026-11-17: an automatic retry of a replay-safe child. The first attempt stays complete here, never merged.
    ...(outcome.retry
      ? {
          retry: {
            attempts: outcome.retry.attempts,
            firstFailure: outcome.retry.firstFailure,
            first: attemptEvidence(outcome.retry.first, index),
          },
        }
      : {}),
  };
}
type AttemptEvidence = ReturnType<typeof attemptEvidence>;
interface RetryEvidence {
  attempts: number;
  firstFailure: string;
  first: AttemptEvidence;
}
function attemptEvidence(outcome: DelegationOutcome, index: number) {
  const final = outcome.final;
  return {
    ordinal: index + 1,
    cwd: outcome.cwd ?? outcome.operation?.cwd ?? null,
    workspaceId: outcome.workspaceId ?? outcome.operation?.workspaceId ?? null,
    operation: outcome.operation ?? null,
    ok: outcome.ok,
    work: outcome.work ?? null,
    control: outcome.control ?? null,
    reason: outcome.reason ?? null,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut ?? null,
    aborted: outcome.aborted ?? null,
    truncated: outcome.truncated ?? null,
    spawnFailed: outcome.spawnFailed ?? null,
    final: !final
      ? null
      : final.state === "unavailable"
        ? { state: final.state, reason: final.reason }
        : {
            state: final.state,
            sessionId: final.sessionId,
            messageId: final.messageId,
            leafId: final.leafId,
            sha256: final.sha256,
          },
    cleanup: cleanup(outcome.cleanup),
    observation: outcome.observation
      ? { state: outcome.observation.state, reasons: [...outcome.observation.reasons] }
      : null,
    retention: outcome.retention ? { status: outcome.retention.status } : null,
  };
}

type CompleteEvidence = ReturnType<typeof executionEvidence>;
type CompleteOutcome = CompleteEvidence["outcomes"][number];

/** Prose is bounded. A failed result states its complete reason in the authored text; details keep every value. */
const REASON_CHARACTERS = 160;
function brief(text: string) {
  const characters = Array.from(text);
  if (characters.length <= REASON_CHARACTERS) return text;
  return characters.slice(0, REASON_CHARACTERS - 1).join("") + "…";
}
/** A duplicate dispatch returns a reference, not a result: keep how the original ended, without its paths. */
function operationSummary(value: NonNullable<CompleteOutcome["operation"]>) {
  const runtime = value.reused ? value.runtime : undefined;
  return {
    operationId: value.operationId,
    state: value.state,
    ...(value.reused ? { reused: true } : {}),
    ...(runtime
      ? {
          runtime: {
            ...(runtime.work ? { work: runtime.work } : {}),
            ...(runtime.control ? { control: runtime.control } : {}),
            ...(runtime.final ? { final: { state: runtime.final.state } } : {}),
            ...(runtime.cleanup ? { cleanup: { state: runtime.cleanup.state } } : {}),
          },
        }
      : {}),
  };
}
/**
 * How a settled worker stopped, only when it was not an ordinary exit (review of 2026-11-17): the receipt's cause
 * unless it is `worker-exit`, and a non-zero signal, at their version 1 paths. Without them a helper interrupted by
 * a signal, a worker that exited without a final, a SIGKILLed worker and a Herdr worker reaped on owner loss read
 * alike. Both are fixed values from Daddy's verified receipt, never child text.
 */
function receiptSummary(value: CompleteOutcome["cleanup"]) {
  const receipt = value && "receipt" in value ? value.receipt : undefined;
  if (!receipt) return {};
  const abnormal = {
    ...(receipt.reason !== "worker-exit" ? { reason: receipt.reason } : {}),
    ...(receipt.workerSignal ? { workerSignal: receipt.workerSignal } : {}),
  };
  return Object.keys(abnormal).length > 0 ? { receipt: abnormal } : {};
}
/** One citable identity per outcome: the operation ID when there is one, else the execution its cleanup names. */
function cleanupSummary(value: CompleteOutcome["cleanup"], cite: boolean) {
  if (!value) return null;
  return {
    state: value.state,
    ...(cite && value.identity ? { identity: { executionId: value.identity.executionId } } : {}),
    ...(value.reason !== undefined ? { reason: brief(value.reason) } : {}),
    ...receiptSummary(value),
  };
}
/**
 * `ok`, `work`, `final` and `cleanup` are always stated, null when the runtime reported none. Every other key is
 * omitted only in its one unremarkable state: no control failure, no reason, exit code 0 or none, a stop flag that
 * is not true, a complete observation, retention that is not lost.
 */
function outcomeSummary(complete: CompleteOutcome) {
  const { operation, final, observation } = complete;
  return {
    ordinal: complete.ordinal,
    ...(operation ? { operation: operationSummary(operation) } : {}),
    ok: complete.ok,
    work: complete.work,
    ...(complete.control ? { control: complete.control } : {}),
    ...(complete.reason ? { reason: brief(complete.reason) } : {}),
    ...(complete.exitCode ? { exitCode: complete.exitCode } : {}),
    ...(complete.timedOut ? { timedOut: true } : {}),
    ...(complete.aborted ? { aborted: true } : {}),
    ...(complete.truncated ? { truncated: true } : {}),
    ...(complete.spawnFailed ? { spawnFailed: true } : {}),
    // A retry is said, with why the first attempt failed in one fixed phrase; the first receipt stays in details.
    ...(complete.retry
      ? { retry: { attempts: complete.retry.attempts, firstFailure: complete.retry.firstFailure } }
      : {}),
    final: !final
      ? null
      : final.reason !== undefined
        ? { state: final.state, reason: brief(final.reason) }
        : { state: final.state },
    cleanup: cleanupSummary(complete.cleanup, !operation),
    ...(observation?.state === "complete" ? {} : { observation: observation ? { state: observation.state } : null }),
    ...(complete.retention?.status === "lost" ? { retention: { status: complete.retention.status } } : {}),
  };
}
/** Version 2: a pure function of the complete version 1 projection, never of the raw outcome. */
export function executionEvidenceSummary(complete: CompleteEvidence) {
  return {
    version: 2,
    tool: complete.tool,
    requested: complete.requested,
    outcomes: complete.outcomes.map(outcomeSummary),
  };
}

/** Absent dimensions remain null, never inferred as success. Only actual returned outcomes appear. */
export function executionEvidenceContent(
  tool: "delegate" | "delegate_all" | "delegate_chain",
  outcomes: readonly DelegationOutcome[],
  requested: number,
) {
  const evidence = executionEvidenceSummary(executionEvidence(tool, outcomes, requested));
  return {
    type: "text" as const,
    text:
      "Runtime execution evidence summary (process settlement; not workspace cleanup or task acceptance; " +
      "a settled cleanup has a verified identity-bound receipt; complete receipts stay in tool details, " +
      "outside model context):\n```json\n" +
      JSON.stringify(evidence) +
      "\n```",
  };
}

/** Complete allowlisted projection: exact local capture, and the source of the model-visible summary. */
export function executionEvidence(
  tool: "delegate" | "delegate_all" | "delegate_chain",
  outcomes: readonly DelegationOutcome[],
  requested: number,
) {
  return { version: 1, tool, requested, outcomes: outcomes.map(outcomeEvidence) };
}
