/** Explicit operation identity prevents duplicate dispatch, never authorizes work or caches results. */
export interface OperationReference {
  operationId: string;
  executionId: string;
  state: "admitting" | "running" | "settled" | "not-started" | "uncertain";
  cwd: string;
  workspaceId: string | null;
  startedAt: string;
  updatedAt: string;
  runtime?: {
    control?: "failed";
    work?: "succeeded" | "failed" | "unknown";
    final?: { state: string; sessionId?: string; messageId?: string; leafId?: string; sha256?: string };
    cleanup?: { state: string; receiptPath?: string; executionId?: string };
  };
}
export interface OperationRequest {
  operationId: string;
  requestDigest: string;
  executionId: string;
  cwd: string;
  workspaceId: string | null;
}
export interface OperationClaim {
  operation: OperationReference;
  reused: boolean;
  /** Only the elected caller receives these methods. Neither grants execution authority. */
  started?(cwd: string, workspaceId: string | null): Promise<void>;
  finish?(state: "settled" | "not-started" | "uncertain", runtime?: OperationReference["runtime"]): Promise<void>;
}
export interface OperationAccess {
  claim(request: OperationRequest, signal?: AbortSignal): Promise<OperationClaim>;
  read(operationId: string): Promise<OperationReference | null>;
  close(): void;
}
export function validOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value);
}
