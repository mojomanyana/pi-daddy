/** Live session permission policy. This does not widen a grant or convey stored approval. */
export type AutoModeSource = "default" | "environment" | "session";
export interface PendingApproval {
  id: string;
  subject: string;
  capability: string;
}
export interface AutoModeSnapshot {
  enabled: boolean;
  source: AutoModeSource;
  ownerId: string;
  revision: number;
  pendingApprovals: PendingApproval[];
}
export interface AutoModeRef {
  socketPath: string;
  token: string;
  ownerId: string;
}
export interface AutoModeReader {
  readonly reference: AutoModeRef;
  read(): Promise<AutoModeSnapshot>;
  /** Linearization point: only a current ON answer admits new work. No approval is banked. */
  admit(signal?: AbortSignal): Promise<boolean>;
  /** Notification only. A waiter must read again and later admit its own operation. */
  waitEnabled(signal: AbortSignal): Promise<void>;
  trackPending(approval: PendingApproval): () => void;
  close(): Promise<void>;
}
export function parseAutoModeDefault(raw: string | undefined): { enabled: boolean; source: AutoModeSource } {
  if (raw === undefined) return { enabled: false, source: "default" };
  if (raw === "0" || raw === "1") return { enabled: raw === "1", source: "environment" };
  throw new Error("PI_DADDY_AUTO_MODE must be literal 1 or 0 (unset defaults to OFF)");
}
export function parseAutoModeRef(raw: string): AutoModeRef {
  let ref: AutoModeRef;
  try {
    ref = JSON.parse(raw);
  } catch {
    throw new Error("PI_DADDY_AUTO_MODE_REF is malformed");
  }
  if (
    !ref ||
    typeof ref !== "object" ||
    Object.keys(ref).sort().join(",") !== "ownerId,socketPath,token" ||
    typeof ref.socketPath !== "string" ||
    !ref.socketPath.startsWith("/") ||
    ref.socketPath.length > 107 ||
    typeof ref.token !== "string" ||
    !/^[a-f0-9]{48}$/.test(ref.token) ||
    typeof ref.ownerId !== "string" ||
    !/^[a-f0-9]{32}$/.test(ref.ownerId)
  )
    throw new Error("PI_DADDY_AUTO_MODE_REF is malformed");
  return ref;
}
