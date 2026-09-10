import { readArchiveSource, retainArchiveSource } from "./evidence-archive.js";
import { readWorkSignalObservation } from "./work-signal-observation.js";
const SHA = /^[a-f0-9]{64}$/;
const hash = (v: unknown): v is string => typeof v === "string" && SHA.test(v);
function read(root: string, id: string, parser: string) {
  const source = readArchiveSource(root, id);
  if (source.status !== "available" || source.reference.retention !== "exact" || source.reference.parser.id !== parser || source.reference.parser.version !== "1"
    || source.bytes.length > 128 * 1024) throw new Error("work signal case evidence unavailable or unsupported");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)); }
  catch { throw new Error("invalid work signal case JSON"); }
  return { value, sourceId: source.reference.sourceId };
}
function closed(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== [...keys].sort().join()) throw new Error("invalid closed work signal case record");
}
function retain(root: string, sourceId: string, parser: string, value: unknown): string {
  return retainArchiveSource(root, { sourceId, parser: { id: parser, version: "1" }, retention: "exact", bytes: Buffer.from(JSON.stringify(value)) }).manifestId;
}

/** Case records point to frozen inputs, not cached verdicts or caller-authored authority. */
export function captureWorkSignalCases(root: string, observationId: string) {
  const observation = readWorkSignalObservation(root, observationId);
  const candidateIds = observation.detection.cases.map(candidate => retain(root, `work-signal-case-${candidate.id}`, "work-signal-case",
    { version: "work-signal-case-v1", observationId, caseId: candidate.id }));
  const batchId = retain(root, `work-signal-batch-${observationId}`, "work-signal-batch",
    { version: "work-signal-batch-v1", observationId, candidateIds, visibility: "silent", promotion: "not-authorized" });
  return { batchId, observationId, candidateIds };
}
export function readWorkSignalCase(root: string, manifestId: string) {
  const { value, sourceId } = read(root, manifestId, "work-signal-case");
  closed(value, ["version", "observationId", "caseId"]);
  if (value.version !== "work-signal-case-v1" || !hash(value.observationId) || !hash(value.caseId) || sourceId !== `work-signal-case-${value.caseId}`) throw new Error("work signal case binding mismatch");
  const observation = readWorkSignalObservation(root, value.observationId);
  const candidate = observation.detection.cases.find(c => c.id === value.caseId);
  if (!candidate) throw new Error("case is not nominated by frozen work signal inputs");
  return { observationId: value.observationId, candidate };
}
export function readWorkSignalBatch(root: string, manifestId: string) {
  const { value, sourceId } = read(root, manifestId, "work-signal-batch");
  closed(value, ["version", "observationId", "candidateIds", "visibility", "promotion"]);
  if (value.version !== "work-signal-batch-v1" || !hash(value.observationId) || sourceId !== `work-signal-batch-${value.observationId}`
    || value.visibility !== "silent" || value.promotion !== "not-authorized" || !Array.isArray(value.candidateIds)
    || value.candidateIds.length > 1024 || !value.candidateIds.every(hash) || new Set(value.candidateIds).size !== value.candidateIds.length) throw new Error("invalid work signal batch binding");
  const observation = readWorkSignalObservation(root, value.observationId);
  return { observationId: value.observationId, candidateIds: value.candidateIds as string[], issues: observation.detection.issues };
}
