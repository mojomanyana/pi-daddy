/** Model-visible projection of runtime facts. UI-only details never reach provider tool output.
 * Keep authored final text and raw result objects unchanged. This is process settlement evidence,
 * not task acceptance or a claim that a disposable workspace was removed.
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
function outcomeEvidence(outcome: DelegationOutcome, index: number) {
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

/** Absent dimensions remain null, never inferred as success. Only actual returned outcomes appear. */
export function executionEvidenceContent(
  tool: "delegate" | "delegate_all" | "delegate_chain",
  outcomes: readonly DelegationOutcome[],
  requested: number,
) {
  const evidence = executionEvidence(tool, outcomes, requested);
  return {
    type: "text" as const,
    text:
      "Runtime execution evidence (process settlement; not workspace cleanup or task acceptance):\n```json\n" +
      JSON.stringify(evidence) +
      "\n```",
  };
}

/** Shared allowlisted projection for the model-visible text and exact local capture. */
export function executionEvidence(
  tool: "delegate" | "delegate_all" | "delegate_chain",
  outcomes: readonly DelegationOutcome[],
  requested: number,
) {
  return { version: 1, tool, requested, outcomes: outcomes.map(outcomeEvidence) };
}
