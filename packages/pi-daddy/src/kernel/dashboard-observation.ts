/** Terminal-only producer observations. None of these fields confer authority or become tool input. */
export const DASHBOARD_SOURCE_EVENT = "pi-daddy:dashboard-source:v1";
export const DASHBOARD_SOURCE_LIMIT = 8;
export const DASHBOARD_SOURCE_BYTES = 4096;
export const DASHBOARD_INVENTORY_BYTES = 8192;
export const DASHBOARD_INVENTORY_ENTRIES = 12;
export const DASHBOARD_RESPONSE_BYTES = 64 * 1024 + DASHBOARD_SOURCE_LIMIT * DASHBOARD_INVENTORY_BYTES;
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
/** Saved choices are project memory. Their display permission ends when Bookie closes its source. */
export const isBookieChoice = (producer: string, item: DashboardContribution) =>
  producer === "bookie-memory" && item.id.startsWith("open-choice-");

export interface DashboardInventoryEntry {
  id: string;
  title: string;
  summary: string;
  details?: string[];
  /** Exact display reference only; opening inventory never dereferences it or grants access. */
  reference?: string;
}
export interface DashboardInventory {
  scope: string;
  state: "available" | "empty" | "unavailable" | "unknown";
  summary: string;
  /** Exact visible total only when known. Omit it for an incomplete or unauthorized scan. */
  count?: number;
  /** The displayed/enumerated entries are a bounded selection; count may still be exact. */
  limited: boolean;
  entries: DashboardInventoryEntry[];
}
interface DashboardTaskObservation {
  owner: string;
  state: string;
  label: string;
  recordedAt: string;
}
export interface DashboardTaskHistory {
  taskId: string;
  title: string;
  observations: number;
  lastObservation?: DashboardTaskObservation;
  /** Additional bounded observations only when taskProgress was negotiated. */
  recentProgress?: DashboardTaskObservation[];
  lastCheckpoint?: {
    state: "captured" | "published";
    capturedAt: string;
    files: number;
    missing: number;
    excluded: number;
  };
}
export interface DashboardSourceUpdate {
  sequence: number;
  items: DashboardContribution[];
  /** Send only after the registration reply advertises capabilities.inventory === 1. */
  inventory?: DashboardInventory;
  /** Bookie can withdraw this selection independently of the source lease. */
  taskHistory?: DashboardTaskHistory;
}
export interface DashboardSourceRefresh {
  state: "idle" | "checking" | "failed";
  attemptedAt?: string;
  nextAttemptAt?: string;
}
/** Return a fresh bounded observation; never publish from inside the refresh callback. */
export type DashboardSourceRefreshCallback = (request: {
  signal: AbortSignal;
}) => DashboardSourceUpdate | undefined | Promise<DashboardSourceUpdate | undefined>;
/** Trusted in-process registration. Callbacks are never serialized to a model or terminal client. */
export type DashboardSourceRegistrationReply =
  | { version: 1; ok: false; reason: string }
  | {
      version: 1;
      ok: true;
      generation: string;
      capabilities?: { inventory: 1; refresh: 1; taskHistory?: 1; taskProgress?: 1 };
      publish(update: DashboardSourceUpdate): boolean;
      close(): void;
    };
export interface DashboardSourceRegistration {
  version: 1;
  sessionId: string;
  cwd: string;
  producer: string;
  producerVersion: string;
  capabilities?: { taskHistory?: 1; taskProgress?: 1 };
  /** Authorized metadata reads only, with cancellation; no automatic work or model calls. */
  refresh?: DashboardSourceRefreshCallback;
  reply(value: DashboardSourceRegistrationReply): void;
}
export interface DashboardSourceSnapshot extends DashboardSourceUpdate {
  producer: string;
  producerVersion: string;
  generation: string;
  observedAt: string;
  staleAfterMs: number;
  availability: "observed" | "closed";
  refresh?: DashboardSourceRefresh;
}
/** Session-local display metadata from the same elected child that published the reference. */
export interface DashboardResultDescription {
  agent?: string;
  summary?: string;
  content: "answer" | "partial" | "record";
  state: "not-started" | "uncertain" | "failed" | "settled" | "unknown";
  observedAt: string;
}
export interface DashboardSavedEvidence {
  operationId: string;
  executionId: string;
  sha256: string;
  description?: DashboardResultDescription;
}
export interface DashboardInputPrompt {
  id: string;
  kind: "select" | "confirm" | "input" | "editor";
  label: string;
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
  inputPrompt?: DashboardInputPrompt;
  turn?: DashboardContribution;
  activity?: DashboardContribution[];
  artifacts?: DashboardSavedEvidence[];
  resources: { scope: "owner-process"; sampledAt: string; rssBytes: number; hostHealth: "unknown" };
  capture: { transcripts: boolean; diagnostics: boolean };
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const bounded = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
export function validDashboardInventory(value: unknown): value is DashboardInventory {
  if (
    !object(value) ||
    Object.keys(value).some((k) => !["scope", "state", "summary", "count", "limited", "entries"].includes(k)) ||
    !bounded(value.scope, 160) ||
    !bounded(value.summary, 480) ||
    !["available", "empty", "unavailable", "unknown"].includes(String(value.state)) ||
    typeof value.limited !== "boolean" ||
    !Array.isArray(value.entries) ||
    value.entries.length > DASHBOARD_INVENTORY_ENTRIES ||
    (value.count !== undefined && (!Number.isSafeInteger(value.count) || Number(value.count) < value.entries.length)) ||
    (value.state === "empty" && (value.entries.length > 0 || value.limited || value.count !== 0)) ||
    (["unavailable", "unknown"].includes(String(value.state)) &&
      (value.entries.length > 0 || value.count !== undefined))
  )
    return false;
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (
      !object(entry) ||
      Object.keys(entry).some((k) => !["id", "title", "summary", "details", "reference"].includes(k)) ||
      !bounded(entry.id, 160) ||
      ids.has(entry.id) ||
      !bounded(entry.title, 160) ||
      !bounded(entry.summary, 480) ||
      (entry.reference !== undefined && !bounded(entry.reference, 512)) ||
      (entry.details !== undefined &&
        (!Array.isArray(entry.details) || entry.details.length > 6 || !entry.details.every((x) => bounded(x, 480))))
    )
      return false;
    ids.add(entry.id);
  }
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= DASHBOARD_INVENTORY_BYTES;
  } catch {
    return false;
  }
}
export function validDashboardTaskHistory(value: unknown): value is DashboardTaskHistory {
  const keys = (data: Record<string, unknown>, allowed: string[]) =>
    Object.keys(data).every((k) => allowed.includes(k));
  if (
    !object(value) ||
    !keys(value, ["taskId", "title", "observations", "lastObservation", "recentProgress", "lastCheckpoint"]) ||
    !bounded(value.taskId, 160) ||
    !bounded(value.title, 160) ||
    !Number.isSafeInteger(value.observations) ||
    Number(value.observations) < 0
  )
    return false;
  const instant = (s: unknown) => bounded(s, 32) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
  const observation = (row: unknown) =>
    object(row) &&
    keys(row, ["owner", "state", "label", "recordedAt"]) &&
    ["bookie", "pi-daddy", "principal", "scout", "harness"].includes(String(row.owner)) &&
    bounded(row.state, 64) &&
    bounded(row.label, 240) &&
    instant(row.recordedAt);
  const { lastObservation, recentProgress, lastCheckpoint } = value;
  if (lastObservation !== undefined && (!value.observations || !observation(lastObservation))) return false;
  if (
    recentProgress !== undefined &&
    (!Array.isArray(recentProgress) ||
      recentProgress.length > Math.min(4, Number(value.observations)) ||
      !recentProgress.every(observation))
  )
    return false;
  return (
    lastCheckpoint === undefined ||
    (object(lastCheckpoint) &&
      keys(lastCheckpoint, ["state", "capturedAt", "files", "missing", "excluded"]) &&
      (lastCheckpoint.state === "captured" || lastCheckpoint.state === "published") &&
      instant(lastCheckpoint.capturedAt) &&
      [lastCheckpoint.files, lastCheckpoint.missing, lastCheckpoint.excluded].every(
        (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
      ))
  );
}
export function validDashboardSourceUpdate(value: unknown): value is DashboardSourceUpdate {
  if (
    !object(value) ||
    Object.keys(value).some((k) => !["sequence", "items", "inventory", "taskHistory"].includes(k)) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    !Array.isArray(value.items) ||
    value.items.length > 8 ||
    (value.taskHistory !== undefined && !validDashboardTaskHistory(value.taskHistory)) ||
    (value.inventory !== undefined && !validDashboardInventory(value.inventory))
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
    if (Buffer.byteLength(JSON.stringify({ sequence: value.sequence, items: value.items })) > DASHBOARD_SOURCE_BYTES)
      return false;
  } catch {
    return false;
  }
  return true;
}
