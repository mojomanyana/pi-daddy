/** UNTESTED (per request). Versioned cache history on the existing control envelope; never live state. */
import { isTimestamp } from "./ledger-v3-validation.ts";
export interface CacheHistory {
  cacheVersion: 1;
  event: "execution_cache";
  epoch: string;
  rootSessionId: string;
  requester: string;
  workspace: string;
  requestId: string;
  toolCallId: string;
  decision: "execute" | "join" | "reuse" | "bypass" | "reject" | "cancelled" | "timed-out" | "clear" | "disable";
  reason: string;
  invocationFingerprint: string | null;
  inputFingerprint: string | null;
  profileId: string | null;
  executionId: string | null;
  originalExecutionId: string | null;
  requestedAt: string;
  deliveredAt: string;
  executionStartedAt: string | null;
  executionEndedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  cancelled: boolean | null;
  timedOut: boolean | null;
  published: boolean;
  outputDigest: string | null;
  coverage: "personal-best-effort-v1" | "ordinary-native-unobserved";
  requestElapsedMs: number;
}
const fields = new Set([
  "cacheVersion",
  "event",
  "epoch",
  "rootSessionId",
  "requester",
  "workspace",
  "requestId",
  "toolCallId",
  "decision",
  "reason",
  "invocationFingerprint",
  "inputFingerprint",
  "profileId",
  "executionId",
  "originalExecutionId",
  "requestedAt",
  "deliveredAt",
  "executionStartedAt",
  "executionEndedAt",
  "exitCode",
  "signal",
  "cancelled",
  "timedOut",
  "published",
  "outputDigest",
  "coverage",
  "requestElapsedMs",
]);
export function validateCacheHistory(value: unknown): value is CacheHistory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== fields.size ||
    Object.keys(row).some((name) => !fields.has(name)) ||
    row.cacheVersion !== 1 ||
    row.event !== "execution_cache"
  )
    return false;
  for (const name of ["epoch", "rootSessionId", "requester", "workspace", "requestId", "toolCallId", "reason"])
    if (typeof row[name] !== "string" || (row[name] as string).length > 4096) return false;
  for (const name of ["profileId", "executionId", "originalExecutionId", "signal"])
    if (row[name] !== null && (typeof row[name] !== "string" || (row[name] as string).length > 4096)) return false;
  for (const name of ["invocationFingerprint", "inputFingerprint", "outputDigest"])
    if (row[name] !== null && (typeof row[name] !== "string" || !/^[a-f0-9]{64}$/.test(row[name] as string)))
      return false;
  for (const name of ["requestedAt", "deliveredAt"]) if (!isTimestamp(row[name])) return false;
  for (const name of ["executionStartedAt", "executionEndedAt"])
    if (row[name] !== null && !isTimestamp(row[name])) return false;
  return (
    ["execute", "join", "reuse", "bypass", "reject", "cancelled", "timed-out", "clear", "disable"].includes(
      String(row.decision),
    ) &&
    ["personal-best-effort-v1", "ordinary-native-unobserved"].includes(String(row.coverage)) &&
    (row.exitCode === null || Number.isInteger(row.exitCode)) &&
    [null, true, false].includes(row.cancelled as null | boolean) &&
    [null, true, false].includes(row.timedOut as null | boolean) &&
    typeof row.published === "boolean" &&
    typeof row.requestElapsedMs === "number" &&
    Number.isFinite(row.requestElapsedMs) &&
    row.requestElapsedMs >= 0
  );
}
