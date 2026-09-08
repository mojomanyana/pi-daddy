import { createHash } from "node:crypto";
import { canonicalWorkJson, copyWorkJson, freezeWork, parseWorkJson } from "./work-ledger-json.ts";
import { parseWorkLedgerText, type WorkFrozen, type WorkProjectionContext, type RevisionRef, type WorkRevisionEvent, type WorkSnapshotEvent } from "./work-ledger.ts";
import { validateWorkSelection } from "./work-ledger-validation.ts";
import { controlShape } from "./dispatch-control.ts";
export type IntentSelection = NonNullable<WorkProjectionContext["selectedSnapshot"]>;
export interface IntentPriority { obligation: RevisionRef; rank: number }
export interface WorkIntentBinding {
  version: "1.0"; path: string; device: string; inode: string; grantLedgerPath: string | null;
  selection: IntentSelection; priorities: IntentPriority[];
}
export interface IntentRequest {
  version: "intent-request-v1"; requestId: string; bindingDigest: string; expectedRevision: number;
  expectedSelection: IntentSelection; action: "revise-scope" | "reprioritize" | "select-alternative";
  events: (WorkRevisionEvent | WorkSnapshotEvent)[]; selection: IntentSelection; priorities: IntentPriority[];
}
export interface IntentReceipt {
  requestId: string; digest: string; expectedRevision: number; expectedSelection: IntentSelection;
  action: IntentRequest["action"]; selection: IntentSelection; priorities: IntentPriority[];
  events: { eventId: string; digest: string }[];
  decision: "approved" | "authority-unavailable" | "stale" | "busy";
  application: "pending-or-unknown" | "applied" | "not-applied";
  outcome: "pending-or-unknown" | "selection-applied" | "priority-applied" | "refused";
  resultSelection: IntentSelection | null;
}
export interface IntentState { revision: number; selection: IntentSelection; priorities: IntentPriority[]; records: IntentReceipt[] }
export interface IntentAdmission { selection: IntentSelection; revision: number; obligation: RevisionRef }
export type IntentSnapshot = WorkFrozen<IntentState & { version: "intent-controller-snapshot-v1"; bindingDigest: string;
  admission: "blocked-pending" | "intent-ready"; acceptance: "not-assessed"; freshness: "snapshot-unknown" }>;
export const intentKey = (value: unknown) => canonicalWorkJson(copyWorkJson(value));
const hash = (value: unknown) => createHash("sha256").update(intentKey(value)).digest("hex");
const id = (x: unknown) => typeof x === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(x);
const hex = (x: unknown) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
export function intentPriorities(input: unknown): IntentPriority[] {
  const result = copyWorkJson(input) as unknown as IntentPriority[];
  if (!Array.isArray(result) || result.length > 32) throw new TypeError("bounded explicit priorities required");
  for (const p of result) {
    controlShape(p, ["obligation", "rank"]); controlShape(p.obligation, ["kind", "id", "revision", "digest"]);
    if (p.obligation.kind !== "obligation" || !id(p.obligation.id) || !hex(p.obligation.digest) || !Number.isSafeInteger(p.obligation.revision) || p.obligation.revision < 1 ||
      !Number.isSafeInteger(p.rank) || p.rank < 0 || p.rank > 127) throw new TypeError("invalid priority");
  }
  if (new Set(result.map(p => intentKey(p.obligation))).size !== result.length) throw new TypeError("duplicate priority obligation");
  return result.sort((a, b) => a.rank - b.rank || (intentKey(a.obligation) < intentKey(b.obligation) ? -1 : 1));
}
export function intentSelection(value: unknown): IntentSelection {
  const copied = copyWorkJson(value); validateWorkSelection(copied);
  if (copied === null) throw new TypeError("exact intent selection required");
  return copied as unknown as IntentSelection;
}
export function intentRequest(input: IntentRequest): WorkFrozen<IntentRequest> {
  const r = copyWorkJson(input) as unknown as IntentRequest;
  controlShape(r, ["version", "requestId", "bindingDigest", "expectedRevision", "expectedSelection", "action", "events", "selection", "priorities"]);
  if (r.version !== "intent-request-v1" || !id(r.requestId) || !hex(r.bindingDigest) || !Number.isSafeInteger(r.expectedRevision) || r.expectedRevision < 0 || r.expectedRevision > 32 ||
    !["revise-scope", "reprioritize", "select-alternative"].includes(r.action) || !Array.isArray(r.events) || r.events.length > 16 || Buffer.byteLength(intentKey(r)) > 48 * 1024) throw new TypeError("invalid bounded intent request");
  const parsed = parseWorkLedgerText(r.events.map(e => intentKey(e)).join("\n"));
  if (!parsed.complete || parsed.events.some(e => !id(e.eventId) || !["work_revision", "work_snapshot"].includes(e.event)) || new Set(parsed.events.map(e => e.eventId)).size !== parsed.events.length ||
    (r.action !== "revise-scope" && r.events.length)) throw new TypeError("only strict revision/snapshot proposals may be appended");
  return freezeWork({ ...r, expectedSelection: intentSelection(r.expectedSelection), selection: intentSelection(r.selection), priorities: intentPriorities(r.priorities) });
}
export const parseIntentRequest = (text: string) => intentRequest(parseWorkJson(text) as unknown as IntentRequest);
export const intentRequestDigest = (input: WorkFrozen<IntentRequest>) => hash(intentRequest(input as IntentRequest));
export function intentReceipt(input: WorkFrozen<IntentRequest>, decision: IntentReceipt["decision"]): IntentReceipt {
  return JSON.parse(intentKey({ requestId: input.requestId, digest: intentRequestDigest(input), expectedRevision: input.expectedRevision,
    expectedSelection: input.expectedSelection, action: input.action, selection: input.selection, priorities: input.priorities,
    events: input.events.map(e => ({ eventId: e.eventId, digest: e.digest })), decision,
    application: decision === "approved" ? "pending-or-unknown" : "not-applied",
    outcome: decision === "approved" ? "pending-or-unknown" : "refused", resultSelection: null }));
}
export function matchesIntentReceipt(receipt: IntentReceipt, request: WorkFrozen<IntentRequest>): boolean {
  const expected = intentReceipt(request, receipt.decision);
  if (receipt.application === "applied") {
    expected.application = "applied"; expected.resultSelection = JSON.parse(intentKey(request.selection));
    expected.outcome = request.action === "reprioritize" ? "priority-applied" : "selection-applied";
  }
  return intentKey(receipt) === intentKey(expected);
}
export function intentDecision(state: IntentState, request: Pick<IntentRequest, "expectedRevision" | "expectedSelection">, authorized: boolean, dispatchBusy: boolean): IntentReceipt["decision"] {
  if (!authorized) return "authority-unavailable";
  if (request.expectedRevision !== state.revision || intentKey(request.expectedSelection) !== intentKey(state.selection)) return "stale";
  if (dispatchBusy || state.records.some(r => r.application === "pending-or-unknown")) return "busy";
  return "approved";
}
export function replayIntent(state: IntentState, event: Record<string, unknown>, active: number, dispatchBusy: boolean): void {
  if (event.type === "intent-request") {
    controlShape(event, ["type", "receipt"]);
    const r = event.receipt as IntentReceipt;
    controlShape(r, ["requestId", "digest", "expectedRevision", "expectedSelection", "action", "selection", "priorities", "events", "decision", "application", "outcome", "resultSelection"]);
    intentSelection(r.expectedSelection); intentSelection(r.selection); intentPriorities(r.priorities);
    if (!id(r.requestId) || !hex(r.digest) || !Number.isSafeInteger(r.expectedRevision) || r.expectedRevision < 0 || !["revise-scope", "reprioritize", "select-alternative"].includes(r.action) ||
      !Array.isArray(r.events) || r.events.length > 16 || state.records.length >= 32 || state.records.some(p => p.requestId === r.requestId) ||
      intentDecision(state, r, r.decision !== "authority-unavailable", dispatchBusy) !== r.decision || r.application !== (r.decision === "approved" ? "pending-or-unknown" : "not-applied") ||
      r.outcome !== (r.decision === "approved" ? "pending-or-unknown" : "refused") || r.resultSelection !== null) throw new Error("invalid intent decision sequence");
    for (const ref of r.events) { controlShape(ref, ["eventId", "digest"]); if (!id(ref.eventId) || !hex(ref.digest)) throw new Error("invalid event reference"); }
    state.records.push(r); if (r.decision === "approved") state.revision++;
  } else {
    controlShape(event, ["type", "requestId"]);
    const r = state.records.find(r => r.requestId === event.requestId);
    if (event.type !== "intent-apply" || !r || r.application !== "pending-or-unknown" || active || dispatchBusy) throw new Error("invalid intent application boundary");
    state.selection = r.selection; state.priorities = r.priorities; r.application = "applied";
    r.outcome = r.action === "reprioritize" ? "priority-applied" : "selection-applied"; r.resultSelection = r.selection;
  }
}
export function intentSnapshot(state: IntentState, bindingDigest: string): IntentSnapshot {
  return freezeWork({ version: "intent-controller-snapshot-v1", bindingDigest, ...state,
    admission: state.records.some(r => r.application === "pending-or-unknown") ? "blocked-pending" : "intent-ready",
    acceptance: "not-assessed", freshness: "snapshot-unknown" });
}
