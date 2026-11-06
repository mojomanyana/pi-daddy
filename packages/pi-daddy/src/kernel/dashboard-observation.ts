/** Terminal-only producer observations. None of these fields confer authority or become tool input. */
export const DASHBOARD_SOURCE_EVENT = "pi-daddy:dashboard-source:v1";
export const DASHBOARD_SOURCE_LIMIT = 8;
export const DASHBOARD_SOURCE_BYTES = 4096;
export type DashboardContributionKind = "goal" | "next" | "work" | "review" | "evidence" | "status";
export type DashboardObservedState =
  | "observed"
  | "running"
  | "dependency-wait"
  | "approval-wait"
  | "cancel-requested"
  | "settled"
  | "failed"
  | "unknown"
  | "unavailable";
export interface DashboardContribution {
  id: string;
  kind: DashboardContributionKind;
  label: string;
  state: DashboardObservedState;
  details?: string[];
  /** Display identity only. The terminal never dereferences or executes it. */
  reference?: string;
}
export interface DashboardSourceUpdate {
  sequence: number;
  items: DashboardContribution[];
}
/** Trusted in-process registration. Callbacks are never serialized to a model or terminal client. */
export type DashboardSourceRegistrationReply =
  | { version: 1; ok: false; reason: string }
  | { version: 1; ok: true; generation: string; publish(update: DashboardSourceUpdate): boolean; close(): void };
export interface DashboardSourceRegistration {
  version: 1;
  sessionId: string;
  cwd: string;
  producer: string;
  producerVersion: string;
  reply(value: DashboardSourceRegistrationReply): void;
}
export interface DashboardSourceSnapshot extends DashboardSourceUpdate {
  producer: string;
  producerVersion: string;
  generation: string;
  observedAt: string;
  staleAfterMs: number;
  availability: "observed" | "closed";
}
export interface DashboardOwnerObservation {
  version: 1;
  sessionId: string;
  cwd: string;
  generation: string;
  sequence: number;
  observedAt: string;
  sources: DashboardSourceSnapshot[];
  logicalOwnerId?: string;
  turn?: DashboardContribution;
  activity?: DashboardContribution[];
  artifacts?: Array<{ operationId: string; executionId: string; sha256: string }>;
  resources: { scope: "owner-process"; sampledAt: string; rssBytes: number; hostHealth: "unknown" };
  capture: { transcripts: boolean; diagnostics: boolean };
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const bounded = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
export function validDashboardSourceUpdate(value: unknown): value is DashboardSourceUpdate {
  if (
    !object(value) ||
    Object.keys(value).some((k) => !["sequence", "items"].includes(k)) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    !Array.isArray(value.items) ||
    value.items.length > 8
  )
    return false;
  const ids = new Set<string>();
  for (const row of value.items) {
    if (
      !object(row) ||
      Object.keys(row).some((k) => !["id", "kind", "label", "state", "details", "reference"].includes(k)) ||
      !bounded(row.id, 160) ||
      ids.has(row.id) ||
      !bounded(row.label, 240) ||
      !["goal", "next", "work", "review", "evidence", "status"].includes(String(row.kind)) ||
      ![
        "observed",
        "running",
        "dependency-wait",
        "approval-wait",
        "cancel-requested",
        "settled",
        "failed",
        "unknown",
        "unavailable",
      ].includes(String(row.state)) ||
      (row.reference !== undefined && !bounded(row.reference, 512)) ||
      (row.details !== undefined &&
        (!Array.isArray(row.details) || row.details.length > 6 || !row.details.every((x) => bounded(x, 240))))
    )
      return false;
    ids.add(row.id);
  }
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > DASHBOARD_SOURCE_BYTES) return false;
  } catch {
    return false;
  }
  return true;
}
