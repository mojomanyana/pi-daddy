import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendWorkCaseDecision, type WorkCaseDecision, type WorkCaseDisposition } from "@skill-harness/core";
import { readArchiveSource } from "./evidence-archive.js";
import { readWorkCandidate } from "./work-case-archive.js";
import { readWorkSignalBatch, readWorkSignalCase } from "./work-signal-cases.js";
const SHA = /^[a-f0-9]{64}$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
function assertDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("private case directory required");
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function privateDirectory(path: string): boolean {
  let created = false;
  try { mkdirSync(path, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  assertDirectory(path);
  return created;
}
function bytes(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || (stat.mode & 0o077)) throw new Error("invalid case history file");
    const out = Buffer.alloc(limit + 1); let used = 0;
    while (used <= limit) { const n = readSync(fd, out, used, out.length - used, used); if (!n) break; used += n; }
    if (used > limit) throw new Error("case history bound exceeded");
    return out.subarray(0, used);
  } finally { closeSync(fd); }
}
function historyAt(directory: string, caseId: string, brandNew = false): WorkCaseDecision[] {
  let raw: Buffer;
  try { raw = bytes(join(directory, "history.jsonl"), 1024 * 1024); }
  catch (error) {
    if (missing(error) && brandNew) return [];
    if (missing(error)) throw new Error("case history missing; explicit recovery required");
    throw error;
  }
  if (!raw.length || raw.at(-1) !== 10) throw new Error("case history incomplete; explicit recovery required");
  const records = raw.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line) as WorkCaseDecision);
  let valid: WorkCaseDecision[] = [];
  for (const record of records) {
    if (record.caseId !== caseId || record.decision_schema !== 1) throw new Error("case history binding mismatch");
    const { id, decision_schema: _schema, ...input } = record;
    valid = appendWorkCaseDecision(valid, input);
    if (!valid.some(r => r.id === id)) throw new Error("case history identity mismatch");
  }
  return valid;
}
export interface WorkCaseReviewRequest { caseManifestId: string; priorDecisionId: string | null; disposition: WorkCaseDisposition; note: string }
function assertAuthor(author: string): void {
  if (typeof author !== "string" || !author || author.length > 512 || /[\u0000-\u001f\u007f]/.test(author)) throw new Error("explicit operator author required");
}
/** Operator-selected batch/author capability. Not user authentication, worker authority or scenario promotion. */
export function createWorkCaseReviewer(root: string, batchId: string, author: string) {
  assertAuthor(author);
  const source = readArchiveSource(root, batchId);
  if (source.status !== "available" || source.reference.parser.id !== "work-candidate-batch" || source.reference.parser.version !== "1" || source.reference.retention !== "exact") throw new Error("case batch missing or invalid");
  const batch = JSON.parse(source.bytes.toString("utf8"));
  if (batch.version !== "work-candidate-batch-v1" || batch.visibility !== "silent" || batch.promotion !== "not-authorized"
    || !Array.isArray(batch.candidateIds) || batch.candidateIds.length > 4096 || batch.candidateIds.some((id: unknown) => typeof id !== "string" || !SHA.test(id))) throw new Error("invalid selected case batch");
  return createSelectedCaseReviewer(root, author, batch.candidateIds, id => readWorkCandidate(root, id));
}

/** Explicit new signal contract; the existing v2 entry point still refuses these batches. */
export function createWorkSignalReviewer(root: string, batchId: string, author: string) {
  assertAuthor(author);
  const batch = readWorkSignalBatch(root, batchId);
  const reviewer = createSelectedCaseReviewer(root, author, batch.candidateIds, id => {
    const selected = readWorkSignalCase(root, id);
    if (selected.observationId !== batch.observationId) throw new Error("work signal case outside frozen observation");
    return selected.candidate;
  });
  return { ...reviewer, list(offset = 0, limit = 5) {
    const current = readWorkSignalBatch(root, batchId);
    return { ...reviewer.list(offset, limit), observationId: current.observationId, issues: current.issues };
  } };
}

function createSelectedCaseReviewer<Candidate extends { id: string }>(root: string, author: string, ids: string[], readCandidate: (id: string) => Candidate) {
  const allowed = new Set<string>(ids);
  const selected = (id: string) => { if (!allowed.has(id)) throw new Error("case outside selected batch"); return readCandidate(id); };
  const getHistory = (caseManifestId: string): WorkCaseDecision[] => {
      const candidate = selected(caseManifestId), directory = join(root, "case-decisions", candidate.id);
      try { assertDirectory(join(root, "case-decisions")); assertDirectory(directory); }
      catch (error) { if (missing(error)) return []; throw error; }
      return historyAt(directory, candidate.id);
  };
  return {
    history: getHistory,
    list(offset = 0, limit = 5) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new Error("bounded case page required");
      const ids = [...allowed].sort();
      return { total: ids.length, offset, items: ids.slice(offset, offset + limit).map(caseManifestId => {
        const candidate = selected(caseManifestId), current = getHistory(caseManifestId).at(-1) ?? null;
        return { caseManifestId, candidate, priorDecisionId: current?.id ?? null, disposition: current?.disposition ?? "unresolved" };
      }) };
    },
    decide(request: WorkCaseReviewRequest) {
      if (!request || Object.keys(request).sort().join() !== "caseManifestId,disposition,note,priorDecisionId"
        || !["confirmed_defect", "expected_behavior", "exemplar", "uncertain", "skip"].includes(request.disposition)
        || typeof request.note !== "string" || request.note.length > 4000
        || !(request.priorDecisionId === null || (typeof request.priorDecisionId === "string" && SHA.test(request.priorDecisionId)))) throw new Error("invalid case review request");
      const candidate = selected(request.caseManifestId);
      const parent = join(root, "case-decisions"); privateDirectory(parent);
      const directory = join(parent, candidate.id);
      const lockPath = join(parent, candidate.id + ".lock"), token = randomUUID();
      const lock = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const identity = fstatSync(lock); let primary: unknown; let result: { current: WorkCaseDecision; replayed: boolean } | undefined;
      try {
        writeFileSync(lock, token); fsyncSync(lock);
        // Hold the case lock BEFORE first directory creation; concurrent first reviewers cannot poison initialization.
        const brandNew = privateDirectory(directory);
        const before = historyAt(directory, candidate.id, brandNew);
        const after = appendWorkCaseDecision(before, { caseId: candidate.id, priorDecisionId: request.priorDecisionId,
          disposition: request.disposition, author, evidence: [request.caseManifestId], note: request.note });
        if (after.length > before.length) {
          const path = join(directory, "history.jsonl"); const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
          try {
            const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error("invalid case history destination");
            const line = Buffer.from(JSON.stringify(after.at(-1)) + "\n");
            if (stat.size + line.length > 1024 * 1024) throw new Error("case history bound exceeded");
            let offset = 0; while (offset < line.length) { const n = writeSync(fd, line, offset, line.length - offset); if (!n) throw new Error("case history write stalled"); offset += n; }
            fsyncSync(fd);
          } finally { closeSync(fd); }
        }
        syncDirectory(directory); syncDirectory(parent); syncDirectory(root);
        result = { current: after.at(-1)!, replayed: after.length === before.length };
      } catch (error) { primary = error; }
      finally {
        try {
          const present = lstatSync(lockPath);
          if (present.dev !== identity.dev || present.ino !== identity.ino || bytes(lockPath, 128).toString() !== token) throw new Error("case writer lock ownership lost");
          unlinkSync(lockPath); syncDirectory(parent);
        } catch (error) { if (!primary) primary = error; }
        finally { closeSync(lock); }
      }
      if (primary) throw primary;
      return result!;
    },
  };
}
