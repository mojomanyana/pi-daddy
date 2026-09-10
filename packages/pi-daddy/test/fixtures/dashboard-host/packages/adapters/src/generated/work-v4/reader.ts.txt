// GENERATED from pi-daddy 7c78769c47177b1972b09e1f5c5474ad44cd2cac by scripts/vendor-work-v4-reader.mjs. Do not hand-edit.
import { isDate } from "node:util/types";
import {
  canonicalWorkJson, copyWorkJson, freezeWork, ownWorkFields, parseWorkJson,
  WORK_EVENT_BYTES, WORK_TEXT_BYTES, WORK_RECORDS, mergeWorkConflicts,
} from "./json.js";
import { validateWorkEvent, validateWorkContext } from "./validation.js";
import { indexWorkLedgerText, indexWorkReceipts, projectWorkAcceptance } from "./projection.js";
import { resolveWorkSnapshotText } from "./snapshot.js";
import { foldWorkOccurrences } from "./occurrences.js";
import {
  WorkInputError, type WorkAcceptanceEvent, type WorkAcceptancePayload, type WorkDiagnostic,
  type WorkFrozen, type WorkIngestion, type WorkLedgerEvent, type WorkOccurrenceEvent,
  type WorkOccurrencePayload, type WorkRevision, type WorkRevisionEvent, type WorkSnapshot,
  type WorkSnapshotEvent, type WorkEventKind, type WorkProjectionContext, type WorkProjection,
  type WorkProblem, type WorkConflict, WorkLedgerWriteError, type WorkLedgerInspection, type WorkInspectionDiagnostic,
} from "./types.js";
export * from "./types.js";
function build(args: unknown, kind: WorkEventKind, field: "revision" | "snapshot" | "payload"): WorkFrozen<WorkLedgerEvent> {
  const fields = ownWorkFields(args);
  const required = ["eventId", "now", field];
  if (Object.keys(fields).length !== required.length || required.some(key => !Object.hasOwn(fields, key))) {
    throw new WorkInputError("WORK_SCHEMA_INVALID");
  }
  const now = fields.now.value;
  if (!isDate(now) || Object.getPrototypeOf(now) !== Date.prototype || Reflect.ownKeys(now).length !== 0 ||
      !Number.isFinite(Date.prototype.getTime.call(now))) throw new WorkInputError("WORK_SCHEMA_INVALID");
  const content = copyWorkJson(fields[field].value);
  const candidate = copyWorkJson({ ledgerVersion: 4, event: kind, eventId: fields.eventId.value,
    ts: Date.prototype.toISOString.call(now), payload: field === "payload" ? content : { [field]: content } });
  const event = validateWorkEvent(candidate, true);
  if (Buffer.byteLength(canonicalWorkJson(event), "utf8") > WORK_EVENT_BYTES) throw new WorkInputError("WORK_LIMIT_EXCEEDED");
  return freezeWork(event);
}
export function buildWorkRevisionEvent(args: { eventId: string; now: Date; revision: Omit<WorkRevision, "digest"> }): WorkFrozen<WorkRevisionEvent> {
  return build(args, "work_revision", "revision") as WorkFrozen<WorkRevisionEvent>;
}
export function buildWorkSnapshotEvent(args: { eventId: string; now: Date; snapshot: Omit<WorkSnapshot, "digest"> }): WorkFrozen<WorkSnapshotEvent> {
  return build(args, "work_snapshot", "snapshot") as WorkFrozen<WorkSnapshotEvent>;
}
export function buildWorkOccurrenceEvent(args: { eventId: string; now: Date; payload: WorkOccurrencePayload }): WorkFrozen<WorkOccurrenceEvent> {
  return build(args, "work_occurrence", "payload") as WorkFrozen<WorkOccurrenceEvent>;
}
export function buildWorkAcceptanceEvent(args: { eventId: string; now: Date; payload: WorkAcceptancePayload }): WorkFrozen<WorkAcceptanceEvent> {
  return build(args, "work_acceptance", "payload") as WorkFrozen<WorkAcceptanceEvent>;
}
function* lines(text: string): Generator<{ text: string; line: number }> {
  let start = 0, line = 1;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    yield { text: text.slice(start, end === -1 ? text.length : end), line: line++ };
    if (end === -1) return;
    start = end + 1;
  }
}
const blank = (text: string): boolean => /^[ \t\r]*$/.test(text);
export function parseWorkLedgerText(text: string): WorkFrozen<WorkIngestion> {
  const wholeError = (code: WorkDiagnostic["code"]) => freezeWork({ events: [], errors: [{ line: null, code }], complete: false });
  if (typeof text !== "string") return wholeError("WORK_SCHEMA_INVALID");
  if (Buffer.byteLength(text, "utf8") > WORK_TEXT_BYTES) return wholeError("WORK_LIMIT_EXCEEDED");
  let records = 0;
  for (const row of lines(text)) if (!blank(row.text) && ++records > WORK_RECORDS) return wholeError("WORK_LIMIT_EXCEEDED");
  const events: WorkLedgerEvent[] = [], errors: WorkDiagnostic[] = [];
  for (const row of lines(text)) {
    if (blank(row.text)) continue;
    try { events.push(validateWorkEvent(parseWorkJson(row.text))); }
    catch (error) {
      if (!(error instanceof WorkInputError)) throw error;
      errors.push({ line: row.line, code: error.code });
    }
  }
  return freezeWork({ events, errors, complete: errors.length === 0 });
}
export function projectWorkLedger(text: string, context: WorkFrozen<WorkProjectionContext> = { selectedSnapshot: null, authority: null }): WorkFrozen<WorkProjection> {
  const index = indexWorkLedgerText(text);
  const errors: WorkFrozen<WorkDiagnostic>[] = [...index.ingestion.errors];
  let copied: WorkFrozen<WorkProjectionContext> | null = null;
  try {
    const value = copyWorkJson(context);
    validateWorkContext(value);
    copied = JSON.parse(canonicalWorkJson(value)) as WorkProjectionContext;
  } catch (error) {
    if (!(error instanceof WorkInputError)) throw error;
    errors.push({ line: null, code: "WORK_CONTEXT_INVALID" });
  }
  errors.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const conflicts = mergeWorkConflicts([
    ...index.conflictingEvents.map(ref => ({ kind: "event" as const, id: ref.eventId, digests: [ref.digest], affectedObligations: [] })),
    ...indexWorkReceipts(copied?.authority ?? null).conflicts,
  ]);
  const identities = { selectedSnapshot: copied?.selectedSnapshot?.snapshot ?? null, authoritySnapshot: copied?.authority?.snapshot ?? null };
  function empty(scopeState: WorkProjection["scopeState"], problems: readonly WorkFrozen<WorkProblem>[], retained: readonly WorkFrozen<WorkConflict>[] = conflicts) {
    return freezeWork({ ...identities, scopeState, progress: null, obligations: [], claims: [], supersededClaims: 0,
      conflicts: mergeWorkConflicts([...retained, ...conflicts]), problems, errors, runtime: null });
  }
  if (errors.length) return empty("unresolved", [{ code: "INPUT_INCOMPLETE", reference: null, affectedObligations: [] }]);
  const structure = resolveWorkSnapshotText(text, copied!.selectedSnapshot);
  if (structure.scopeState !== "valid") return empty(structure.scopeState, structure.problems, structure.conflicts);
  const runtime = foldWorkOccurrences(index, structure.snapshot!);
  const acceptance = projectWorkAcceptance(index, structure, copied!.authority, runtime);
  return freezeWork({ ...identities, scopeState: "valid", ...acceptance, errors, runtime: runtime.runtime });
}
