/** Historical producer facts only. No owner adoption, admission, retry or execution authority. */
import type { OperationArtifactOwner } from "../kernel/operation-artifact.ts";
import { readOperationHistory, type OperationArtifactHistory } from "./operation-artifacts.ts";
import { readRuntimeExecutionSettlement } from "./runtime-settlement.ts";

export interface OperationRecoverySource {
  owner: OperationArtifactOwner;
  operationId: string;
}
export interface OperationRecoveryObservation extends Partial<OperationArtifactHistory> {
  admission: "present" | "absent";
  result: "present" | "absent";
  cleanup: { state: "settled" | "not-started" | "unknown" };
  /** Positive immutable terminal evidence for this exact attempt, never permission for another attempt. */
  noStartProven: boolean;
}
export async function readOperationRecovery(
  agentDirectory: string,
  source: OperationRecoverySource,
): Promise<OperationRecoveryObservation> {
  const retained = readOperationHistory(agentDirectory, source.owner, source.operationId);
  if (!retained)
    return {
      admission: "absent",
      result: "absent",
      cleanup: { state: "unknown" },
      noStartProven: false,
      reason: "No retained admission for this exact owner and operation; absence is not no-start proof.",
    };
  const before = JSON.stringify(retained);
  const { operation, artifact, final, partial } = retained;
  const runtime = operation.runtime;
  const terminalNoStart =
    !!artifact &&
    operation.state === "not-started" &&
    runtime?.cleanup?.state === "not-started" &&
    (runtime.cleanup.executionId === undefined || runtime.cleanup.executionId === operation.executionId) &&
    runtime.cleanup.receiptPath === undefined &&
    (runtime.work === undefined || runtime.work === "unknown") &&
    runtime.final === undefined &&
    !final &&
    !partial;
  let settlement: "settled" | "not-started" | "unknown" = "unknown";
  try {
    settlement = await readRuntimeExecutionSettlement(
      agentDirectory,
      source.owner.sessionId,
      source.owner.cwd,
      operation.executionId,
    );
  } catch {
    // A missing or invalid journal cannot strengthen the immutable result or prove no execution.
  }
  if (JSON.stringify(readOperationHistory(agentDirectory, source.owner, source.operationId)) !== before)
    throw Error("operation recovery evidence changed during read");
  const contradictory = operation.state === "not-started" && (!terminalNoStart || settlement === "settled");
  const noStartProven = terminalNoStart && !contradictory;
  return {
    ...retained,
    admission: "present",
    result: artifact ? "present" : "absent",
    cleanup: { state: contradictory ? "unknown" : noStartProven ? "not-started" : settlement },
    noStartProven,
    ...(contradictory
      ? { reason: "The retained no-start record contains conflicting or incomplete execution evidence." }
      : {}),
  };
}
