import { normaliseCorrelation, type CorrelationMetadata } from "./correlation.ts";
import { isExecutionId } from "./execution-id.ts";
import { REFUSAL_CODES } from "./refusals.ts";
import { isWorkflowFactId, isWorkflowIdentifier, workflowFactStateMatches } from "./workflow-fact-id.ts";
import { isLedgerCapabilityIdentifier, isLedgerDisplayIdentifier } from "./ledger-identifiers.ts";

export type LedgerV3Object = Record<string, unknown>;

const SHA256_RE = /^[a-f0-9]{64}$/i;
const EXECUTORS = new Set(["process", "herdr"]);
const APPROVAL_SOURCES = new Set(["prompt", "session", "persisted", "inherited"]);
const APPROVAL_SCOPES = new Set(["once", "session", "always"]);
const GATE_OUTCOMES = new Set(["declined", "dismissed", "no-ui", "error"]);
const LEASE_OUTCOMES = new Set([
  "acquired", "uncontended", "refused", "released", "released-unrecorded", "lost", "retained", "timeout", "recovered",
]);
const PROCESS_SIGNALS = new Set([
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGIO",
  "SIGIOT", "SIGKILL", "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV", "SIGSTKFLT",
  "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGUNUSED", "SIGURG",
  "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ", "SIGBREAK", "SIGLOST", "SIGINFO",
]);

const FIELDS = {
  capability_decision: new Set([
    "ledgerVersion", "event", "ts", "executionId", "parentExecutionId", "parentId", "childId", "depth",
    "agentType", "requested", "parentGrant", "effective", "denied", "clipped", "gatedBlocked", "blocked",
    "reason", "approved", "approvalSource", "approvalSources", "approvalScopes", "approvalExpiresAt",
    "approvalUses", "approvalScope", "humanDenied", "gateOutcome", "definitionDigest", "executor", "taskFrom",
    "taskFromExecutionId", "taskDigest", "correlation", "refusal",
  ]),
  workspace_lease: new Set([
    "ledgerVersion", "event", "ts", "executionId", "parentExecutionId", "childId", "workspaceId", "root",
    "access", "outcome", "recovered", "releaseReason", "refusal", "correlation",
  ]),
  child_lifecycle: new Set([
    "ledgerVersion", "event", "ts", "executionId", "parentExecutionId", "childId", "state", "executor",
    "exitCode", "signal", "timedOut", "aborted", "truncated", "reason", "deadlineAt", "herdrPaneId",
    "herdrAgentName", "correlation",
  ]),
  check_receipt: new Set([
    "ledgerVersion", "event", "ts", "executionId", "parentExecutionId", "childId", "receiptId", "workspaceId",
    "checkId", "treeSha", "correlation",
  ]),
  workflow_fact: new Set([
    "ledgerVersion", "event", "ts", "factId", "source", "provenance", "kind", "subject", "state", "correlation",
  ]),
} as const;
type EventKind = keyof typeof FIELDS;

export function isLedgerObject(value: unknown): value is LedgerV3Object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Ledger timestamp profile: JSON Schema `date-time`, narrowed to seconds 00-59 for JS date arithmetic. */
export function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]) return false;
  return offsetHourText === undefined || (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function optional(event: LedgerV3Object, field: string, valid: (value: unknown) => boolean): boolean {
  return !Object.hasOwn(event, field) || valid(event[field]);
}

function stringMap(value: unknown, valid: (entry: unknown) => boolean): boolean {
  return isLedgerObject(value) && Object.values(value).every(valid);
}

function capabilityMap(value: unknown, valid: (entry: unknown) => boolean): boolean {
  return isLedgerObject(value) && Object.keys(value).every(isLedgerCapabilityIdentifier) && Object.values(value).every(valid);
}

function validCorrelation(value: unknown): boolean {
  if (!isLedgerObject(value)) return false;
  try {
    const normalised = normaliseCorrelation(value as CorrelationMetadata);
    // `normaliseCorrelation` drops nulls. The closed schema does not, so equality is part of validation.
    return JSON.stringify(normalised) === JSON.stringify(value);
  } catch {
    return false;
  }
}

function validRefusal(value: unknown): boolean {
  if (!isLedgerObject(value) || Object.keys(value).some((key) => !["code", "message", "details"].includes(key))) return false;
  if (!REFUSAL_CODES.includes(value.code as never) || typeof value.message !== "string") return false;
  return optional(value, "details", (details) => isLedgerObject(details) && Object.values(details).every(
    (entry) => entry === null || ["string", "number", "boolean"].includes(typeof entry),
  ));
}

function validDefinitionDigest(value: unknown): boolean {
  return isLedgerObject(value) &&
    Object.keys(value).every((key) => ["name", "source", "sha256"].includes(key)) &&
    typeof value.name === "string" && typeof value.source === "string" && SHA256_RE.test(String(value.sha256));
}

function validApprovalUse(value: unknown): boolean {
  return isLedgerObject(value) && Object.keys(value).every((key) => ["max", "remaining"].includes(key)) &&
    Number.isInteger(value.max) && (value.max as number) >= 0 &&
    Number.isInteger(value.remaining) && (value.remaining as number) >= 0;
}

function validateBase(event: LedgerV3Object): string | null {
  if (!isTimestamp(event.ts)) return "ts must be an RFC 3339 timestamp";
  if (!isExecutionId(event.executionId)) return "executionId is missing or invalid";
  if (event.parentExecutionId !== null && !isExecutionId(event.parentExecutionId)) {
    return "parentExecutionId must be an execution id or null";
  }
  if (event.parentExecutionId === event.executionId) return "an execution cannot be its own parent";
  if (!isLedgerDisplayIdentifier(event.childId)) return "childId is missing or invalid";
  return null;
}

function validateCapabilityDecision(event: LedgerV3Object): string | null {
  if (!isLedgerDisplayIdentifier(event.parentId) || !Number.isInteger(event.depth) || (event.depth as number) < 0) {
    return "capability decision identity is invalid";
  }
  for (const field of ["requested", "parentGrant", "effective", "denied", "clipped", "gatedBlocked"]) {
    if (!isStringArray(event[field]) || !event[field].every(isLedgerCapabilityIdentifier)) {
      return `capability decision ${field} must contain capability identifiers`;
    }
  }
  if (typeof event.blocked !== "boolean" || !EXECUTORS.has(String(event.executor)) || !SHA256_RE.test(String(event.taskDigest))) {
    return "capability decision required fields are invalid";
  }
  if (!optional(event, "agentType", isLedgerDisplayIdentifier) ||
      !optional(event, "reason", (value) => typeof value === "string") ||
      !optional(event, "approved", (value) => isStringArray(value) && value.every(isLedgerCapabilityIdentifier)) ||
      !optional(event, "approvalSource", (value) => APPROVAL_SOURCES.has(String(value))) ||
      !optional(event, "approvalSources", (value) => capabilityMap(value, (entry) => APPROVAL_SOURCES.has(String(entry)))) ||
      !optional(event, "approvalScopes", (value) => capabilityMap(value, (entry) => APPROVAL_SCOPES.has(String(entry)))) ||
      !optional(event, "approvalExpiresAt", (value) => capabilityMap(value, isTimestamp)) ||
      !optional(event, "approvalUses", (value) => capabilityMap(value, validApprovalUse)) ||
      !optional(event, "approvalScope", (value) => APPROVAL_SCOPES.has(String(value))) ||
      !optional(event, "humanDenied", (value) => value === true) ||
      !optional(event, "gateOutcome", (value) => GATE_OUTCOMES.has(String(value))) ||
      !optional(event, "definitionDigest", validDefinitionDigest) ||
      !optional(event, "taskFrom", isLedgerDisplayIdentifier) ||
      !optional(event, "taskFromExecutionId", isExecutionId) ||
      !optional(event, "correlation", validCorrelation) ||
      !optional(event, "refusal", validRefusal)) {
    return "capability decision optional fields are invalid";
  }
  return null;
}

function validateWorkspaceLease(event: LedgerV3Object): string | null {
  if (!isLedgerDisplayIdentifier(event.workspaceId) || !isNonEmptyString(event.root) ||
      !["read", "write"].includes(String(event.access)) || !LEASE_OUTCOMES.has(String(event.outcome))) {
    return "workspace lease required fields are invalid";
  }
  if (!optional(event, "recovered", (value) => value === true || value === false || value === "unknown") ||
      !optional(event, "releaseReason", (value) => typeof value === "string") ||
      !optional(event, "refusal", validRefusal) || !optional(event, "correlation", validCorrelation)) {
    return "workspace lease optional fields are invalid";
  }
  return null;
}

function validateChildLifecycle(event: LedgerV3Object): string | null {
  if (!["starting", "running", "completed", "failed"].includes(String(event.state)) || !EXECUTORS.has(String(event.executor))) {
    return "child lifecycle required fields are invalid";
  }
  if (["starting", "running"].includes(String(event.state)) && !isTimestamp(event.deadlineAt)) {
    return "deadlineAt is required and must be an RFC 3339 timestamp for a non-terminal lifecycle";
  }
  if (!optional(event, "deadlineAt", isTimestamp) ||
      !optional(event, "exitCode", (value) => value === null || Number.isInteger(value)) ||
      !optional(event, "signal", (value) => value === null || PROCESS_SIGNALS.has(String(value))) ||
      !optional(event, "timedOut", (value) => value === true) ||
      !optional(event, "aborted", (value) => value === true) ||
      !optional(event, "truncated", (value) => value === true) ||
      !optional(event, "reason", (value) => typeof value === "string") ||
      !optional(event, "correlation", validCorrelation)) {
    return "child lifecycle optional fields are invalid";
  }
  if (!optional(event, "herdrPaneId", isLedgerDisplayIdentifier) ||
      !optional(event, "herdrAgentName", isLedgerDisplayIdentifier)) {
    return "Herdr runtime identity is invalid";
  }
  if (Object.hasOwn(event, "herdrPaneId") !== Object.hasOwn(event, "herdrAgentName")) {
    return "Herdr runtime identity must be paired";
  }
  if (Object.hasOwn(event, "herdrPaneId") && event.executor !== "herdr") {
    return "Herdr runtime identity requires the Herdr executor";
  }
  return null;
}

function validateCheckReceipt(event: LedgerV3Object): string | null {
  if (!SHA256_RE.test(String(event.receiptId)) || !isLedgerDisplayIdentifier(event.workspaceId) ||
      !isLedgerDisplayIdentifier(event.checkId) || !isNonEmptyString(event.treeSha) ||
      !optional(event, "correlation", validCorrelation)) {
    return "check receipt required fields are invalid";
  }
  return null;
}

function validateWorkflowFact(event: LedgerV3Object): string | null {
  if (!isTimestamp(event.ts) || !isWorkflowFactId(event.factId) ||
      !isWorkflowIdentifier(event.source) || !isWorkflowIdentifier(event.subject) ||
      !["planned", "observed", "controller_validated"].includes(String(event.provenance)) ||
      !["workflow_phase", "inline_skill", "transition"].includes(String(event.kind)) ||
      !["pending", "observed", "started", "completed", "blocked"].includes(String(event.state)) ||
      !validCorrelation(event.correlation) ||
      !isNonEmptyString((event.correlation as LedgerV3Object).run_id)) {
    return "workflow fact required fields are invalid";
  }
  return workflowFactStateMatches(event.provenance, event.state)
    ? null
    : "workflow fact provenance contradicts its state";
}

/** Exact, content-free runtime validation for one closed ledger v3 event. */
export function validateLedgerV3Event(event: LedgerV3Object): string | null {
  if (event.ledgerVersion !== 3) return "unsupported ledger version";
  const kind = event.event;
  if (typeof kind !== "string" || !Object.hasOwn(FIELDS, kind)) return "unknown ledger event discriminator";
  const allowed = FIELDS[kind as EventKind];
  if (Object.keys(event).some((field) => !allowed.has(field))) return "ledger v3 contains an unsupported field";
  if (kind === "workflow_fact") return validateWorkflowFact(event);
  const base = validateBase(event);
  if (base) return base;
  if (kind === "capability_decision") return validateCapabilityDecision(event);
  if (kind === "workspace_lease") return validateWorkspaceLease(event);
  if (kind === "child_lifecycle") return validateChildLifecycle(event);
  return validateCheckReceipt(event);
}

/** Ensure a public builder cannot emit bytes the closed v3 reader would reject. */
export function assertLedgerV3Wire<T extends object>(event: T): T {
  let wire: unknown;
  try {
    wire = JSON.parse(JSON.stringify(event));
  } catch (error) {
    throw new TypeError(`invalid ledger v3 event: ${String(error)}`);
  }
  if (!isLedgerObject(wire)) throw new TypeError("invalid ledger v3 event: event is not a JSON object");
  const invalid = validateLedgerV3Event(wire);
  if (invalid) throw new TypeError(`invalid ledger v3 event: ${invalid}`);
  return event;
}
