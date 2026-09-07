/** Opt-in work-v4 evidence. No default emission or built-in acceptance authority. */
import { isDate } from "node:util/types";
import { open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { appendLedgerLine, readWorkBytes, closeWorkHandle } from "./ledger-append.ts";
import { workDestination, workFsError, validWorkPath } from "./work-ledger-destination.ts";
import { LockTimeoutError } from "./file-lock.ts";
import {
  canonicalWorkJson, copyWorkJson, freezeWork, ownWorkFields, parseWorkJson,
  WORK_EVENT_BYTES, WORK_TEXT_BYTES, WORK_RECORDS, mergeWorkConflicts,
} from "./work-ledger-json.ts";
import { validateWorkEvent, validateWorkContext } from "./work-ledger-validation.ts";
import { indexWorkLedgerText, indexWorkReceipts, projectWorkAcceptance } from "./work-ledger-projection.ts";
import { resolveWorkSnapshotText } from "./work-ledger-snapshot.ts";
import { foldWorkOccurrences } from "./work-ledger-occurrences.ts";
import {
  WorkInputError, type WorkAcceptanceEvent, type WorkAcceptancePayload, type WorkDiagnostic,
  type WorkFrozen, type WorkIngestion, type WorkLedgerEvent, type WorkOccurrenceEvent,
  type WorkOccurrencePayload, type WorkRevision, type WorkRevisionEvent, type WorkSnapshot,
  type WorkSnapshotEvent, type WorkEventKind, type WorkProjectionContext, type WorkProjection,
  type WorkProblem, type WorkConflict, WorkLedgerWriteError, type WorkLedgerInspection, type WorkInspectionDiagnostic,
} from "./work-ledger-types.ts";
export * from "./work-ledger-types.ts";

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

/** Diagnostic boundary: retain physical valid deliveries, never rewrite, deduplicate or elect a winner. */
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

/** Public opt-in projection: strict text, detached host context, exact selection, actual runtime,
 * then conditional authority binding. No I/O, authenticator, ambient trust or acceptance callback. */
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

/** Always opt-in, strict, and detached before the first filesystem await. No environment defaults. */
export async function appendWorkLedgerEvent(options: { path: string; grantLedgerPath: string | null }, event: WorkFrozen<WorkLedgerEvent>): Promise<void> {
  const fields = ownWorkFields(options);
  if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, "path") || !Object.hasOwn(fields, "grantLedgerPath") || typeof fields.path.value !== "string" ||
      (fields.grantLedgerPath.value !== null && typeof fields.grantLedgerPath.value !== "string")) throw new WorkInputError("WORK_SCHEMA_INVALID");
  const path: string = fields.path.value, grant: string | null = fields.grantLedgerPath.value;
  const candidate = validateWorkEvent(copyWorkJson(event));
  const canonical = canonicalWorkJson(candidate);
  if (Buffer.byteLength(canonical, "utf8") > WORK_EVENT_BYTES) throw new WorkInputError("WORK_LIMIT_EXCEEDED");
  try {
    const destination = await workDestination(path, grant);
    await appendLedgerLine({ path: destination.path }, canonical + "\n", destination);
  } catch (error) {
    if (error instanceof LockTimeoutError || workFsError(error)) throw new WorkLedgerWriteError("WORK_LEDGER_WRITE_FAILED");
    throw error;
  }
}

/** Read-only regular-file inspection; a successful read is not a content-validity or acceptance claim. */
export async function inspectWorkLedger(options: { version: 4; path: string },
  context: WorkFrozen<WorkProjectionContext> = { selectedSnapshot: null, authority: null }): Promise<WorkFrozen<WorkLedgerInspection>> {
  let exists: boolean | null = null;
  const failure = (code: WorkInspectionDiagnostic["code"]): WorkFrozen<WorkLedgerInspection> => freezeWork({
    version: 4, status: "error", exists, ingestion: null, projection: null, errors: [{ line: null, code }],
  });
  const missing = (): WorkFrozen<WorkLedgerInspection> => freezeWork({ version: 4, status: "missing", exists: false,
    ingestion: null, projection: null, errors: [] });
  let path: string, copied: WorkFrozen<WorkProjectionContext>;
  try {
    const fields = ownWorkFields(options);
    if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, "path") || !Object.hasOwn(fields, "version") || typeof fields.path.value !== "string") throw new WorkInputError("WORK_SCHEMA_INVALID");
    if (fields.version.value !== 4) throw new WorkInputError("WORK_VERSION_UNSUPPORTED");
    path = fields.path.value;
    try { const value = copyWorkJson(context); validateWorkContext(value); copied = value as unknown as WorkFrozen<WorkProjectionContext>; }
    catch (error) { if (error instanceof WorkInputError) throw new WorkInputError("WORK_CONTEXT_INVALID"); throw error; }
  } catch (error) { if (error instanceof WorkInputError) return failure(error.code); throw error; }
  if (!validWorkPath(path)) return failure("WORK_INSPECTION_PATH_INVALID");
  try {
    let info;
    try { info = await stat(path); }
    catch (error) {
      if (workFsError(error) && error.code === "ENOENT") return missing();
      throw error;
    }
    exists = true;
    if (!info.isFile()) return failure("WORK_INSPECTION_NOT_REGULAR");
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
    catch (error) { if (workFsError(error) && error.code === "ENOENT") return missing(); throw error; }
    let failed = false, bytes: Buffer;
    try {
      if (!(await handle.stat()).isFile()) return failure("WORK_INSPECTION_NOT_REGULAR");
      bytes = await readWorkBytes(handle);
    } catch (error) { failed = true; throw error; }
    finally { await closeWorkHandle(handle, failed); }
    const text = bytes.toString("utf8");
    return freezeWork({ version: 4, status: "read", exists: true, ingestion: parseWorkLedgerText(text), projection: projectWorkLedger(text, copied), errors: [] });
  } catch (error) {
    if (error instanceof WorkInputError) return failure(error.code);
    if (workFsError(error)) return failure("WORK_INSPECTION_READ_FAILED");
    throw error;
  }
}
