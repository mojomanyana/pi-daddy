/** Exact producer evidence. Retention is neither live authority nor semantic acceptance. */
import type { OperationReference, OperationRequest } from "./dispatch-operation.ts";
export const OPERATION_ARTIFACT_VERSION = 1;
export const MAX_OPERATION_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const MAX_OPERATION_MANIFEST_BYTES = 64 * 1024;
export interface OperationArtifactOwner {
  sessionId: string;
  cwd: string;
}
export interface OperationArtifactContent {
  path: string;
  sha256: string;
  bytes: number;
}
export interface OperationArtifactRef {
  version: 1;
  producer: "pi-daddy";
  owner: OperationArtifactOwner;
  operationId: string;
  executionId: string;
  manifest: OperationArtifactContent;
}
export interface RetainedOperationFinal {
  state: "complete";
  text: string;
  sessionId: string;
  messageId: string;
  leafId: string;
  sha256: string;
}
export interface OperationArtifactManifest {
  version: 1;
  producer: "pi-daddy";
  owner: OperationArtifactOwner;
  request: OperationRequest;
  operation: Omit<OperationReference, "artifact">;
  observedAt: string;
  final?: Omit<RetainedOperationFinal, "text"> & { content: OperationArtifactContent };
  partial?: OperationArtifactContent;
}
export interface OperationArtifactOutcome {
  operation: Omit<OperationReference, "artifact">;
  final?: RetainedOperationFinal;
  /** Available visible output only; never promoted to an exact native final. */
  partial?: string;
}
