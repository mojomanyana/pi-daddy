/** Optional private owner evidence. Older runtimes and ledger readers need not know this file exists. */
import { join } from "node:path";
import { readBoundedTextSync } from "../kernel/bounded-read-sync.ts";
import type { AutomaticRetryEligibility, OperationReference, OperationRequest } from "../kernel/dispatch-operation.ts";
import type { OperationArtifactOwner } from "../kernel/operation-artifact.ts";
import { artifactJson, publishArtifact } from "./operation-artifact-io.ts";

function eligible(proof: AutomaticRetryEligibility, request: OperationRequest, operation: OperationReference): boolean {
  const runtime = operation.runtime;
  return (
    !!proof &&
    proof.version === 1 &&
    proof.eligible === true &&
    proof.operationId === request.operationId &&
    proof.executionId === request.executionId &&
    operation.operationId === request.operationId &&
    operation.executionId === request.executionId &&
    typeof proof.definitionId === "string" &&
    /^[a-f0-9]{64}$/.test(proof.definitionId) &&
    Object.keys(proof).sort().join(",") === "definitionId,eligible,executionId,operationId,version" &&
    runtime?.work !== "succeeded" &&
    runtime?.control !== "failed" &&
    runtime?.final?.state !== "complete" &&
    ((operation.state === "settled" &&
      runtime?.cleanup?.state === "settled" &&
      runtime.cleanup.executionId === operation.executionId) ||
      (operation.state === "not-started" && runtime?.cleanup?.state === "not-started"))
  );
}

/** Called only after the owner has successfully settled and retained this exact failed execution. */
export function retainAutomaticRetryEligibility(
  path: string,
  owner: OperationArtifactOwner,
  request: OperationRequest,
  operation: OperationReference,
  proof: AutomaticRetryEligibility,
): void {
  if (!eligible(proof, request, operation)) throw Error("automatic retry evidence does not match its terminal owner");
  publishArtifact(
    path,
    "automatic-retry.json",
    artifactJson({ version: 1, owner, requestDigest: request.requestDigest, eligibility: proof }),
  );
}

/** Missing or unusable optional evidence disables automatic replay, without hiding the original result. */
export function readAutomaticRetryEligibility(
  path: string,
  owner: OperationArtifactOwner,
  request: OperationRequest,
  operation: OperationReference,
): AutomaticRetryEligibility | undefined {
  try {
    const record = JSON.parse(
      readBoundedTextSync(join(path, "automatic-retry.json"), { maxBytes: 4096, confinedRoot: path }).text,
    );
    if (
      record.version !== 1 ||
      record.owner?.sessionId !== owner.sessionId ||
      record.owner?.cwd !== owner.cwd ||
      record.requestDigest !== request.requestDigest ||
      !eligible(record.eligibility, request, operation)
    )
      return undefined;
    return record.eligibility;
  } catch {
    return undefined;
  }
}
