import { createHash } from "node:crypto";
import {
  parseArchivedJsonl, readArchiveSource, retainArchiveSource,
  type ArchiveRead, type ArchiveSourceInput, type ArchiveRetention,
} from "./evidence-archive.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const SHA = /^[a-f0-9]{64}$/;
const LIMIT = 8 * 1024 * 1024;
export type SnapshotChange = "initial" | "append" | "replaced" | "unknown";
export interface ArchiveCheckpoint {
  version: "archive-checkpoint-v1";
  sourceId: string;
  sourceManifestId: string;
  sourceSha256: string;
  sourceBytes: number;
  previousCheckpointId: string | null;
  lineage: string;
  declaredParser: { id: string; version: string };
  reader: "jsonl-syntax-v1";
  retention: ArchiveRetention;
  change: SnapshotChange;
  syntax: "complete" | "partial" | "error" | "unavailable";
  completeBytes: number;
  pendingBytes: number;
  invalidLines: number;
  issues: string[];
  activeBranch: null;
  acceptance: "not-assessed";
}
export interface ArchivedRecord { id: string; line: number; start: number; end: number; value: unknown }
export interface CheckpointRead { checkpoint: ArchiveCheckpoint; source: ArchiveRead; records: ArchivedRecord[] }
const parserEqual = (a: ArchiveCheckpoint["declaredParser"], b: ArchiveCheckpoint["declaredParser"]) => a.id === b.id && a.version === b.version;
function reject(): never { throw new Error("invalid archive checkpoint"); }
function parseCheckpoint(bytes: Buffer): ArchiveCheckpoint {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const v = JSON.parse(text) as ArchiveCheckpoint;
  if (JSON.stringify(v) !== text) reject();
  const names = ["version", "sourceId", "sourceManifestId", "sourceSha256", "sourceBytes", "previousCheckpointId", "lineage", "declaredParser", "reader", "retention", "change", "syntax", "completeBytes", "pendingBytes", "invalidLines", "issues", "activeBranch", "acceptance"];
  if (!v || Object.keys(v).length !== names.length || Object.keys(v).some(k => !names.includes(k))
    || v.version !== "archive-checkpoint-v1" || v.reader !== "jsonl-syntax-v1"
    || typeof v.sourceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.sourceId)
    || ![v.sourceManifestId, v.sourceSha256, v.lineage].every(h => typeof h === "string" && SHA.test(h))
    || !(v.previousCheckpointId === null || (typeof v.previousCheckpointId === "string" && SHA.test(v.previousCheckpointId)))
    || ![v.sourceBytes, v.completeBytes, v.pendingBytes, v.invalidLines].every(n => Number.isSafeInteger(n) && n >= 0 && n <= LIMIT)
    || v.completeBytes + v.pendingBytes !== v.sourceBytes
    || !v.declaredParser || Object.keys(v.declaredParser).sort().join() !== "id,version"
    || ![v.declaredParser.id, v.declaredParser.version].every(s => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s))
    || !["exact", "redacted", "reference-only"].includes(v.retention)
    || !["initial", "append", "replaced", "unknown"].includes(v.change)
    || !["complete", "partial", "error", "unavailable"].includes(v.syntax)
    || (v.retention === "reference-only" && (v.syntax !== "unavailable" || v.completeBytes !== 0 || v.invalidLines !== 0))
    || !Array.isArray(v.issues) || v.issues.length > 16 || v.issues.some(i => typeof i !== "string" || i.length > 128)
    || v.activeBranch !== null || v.acceptance !== "not-assessed") reject();
  return v;
}
function records(checkpoint: ArchiveCheckpoint, source: ArchiveRead): ArchivedRecord[] {
  if (source.status !== "available") return [];
  const parsed = parseArchivedJsonl(source.bytes);
  return parsed.records.map(record => ({
    ...record, id: hash(JSON.stringify([checkpoint.sourceId, checkpoint.lineage, record.start, hash(source.bytes.subarray(record.start, record.end))])),
  }));
}

/** Restart from the immutable checkpoint ID. This never advances a worker or invokes a gate. */
export function readArchiveCheckpoint(root: string, checkpointId: string): CheckpointRead {
  const stored = readArchiveSource(root, checkpointId);
  if (stored.status !== "available" || stored.reference.retention !== "exact") reject();
  const checkpoint = parseCheckpoint(stored.bytes);
  const source = readArchiveSource(root, checkpoint.sourceManifestId);
  if (source.status === "available") {
    const ref = source.reference;
    if (ref.sourceId !== checkpoint.sourceId || ref.sha256 !== checkpoint.sourceSha256 || ref.bytes !== checkpoint.sourceBytes
      || ref.retention !== checkpoint.retention || !parserEqual(ref.parser, checkpoint.declaredParser)) reject();
    const actual = parseArchivedJsonl(source.bytes);
    if (actual.status !== checkpoint.syntax || actual.completeBytes !== checkpoint.completeBytes
      || actual.pendingBytes !== checkpoint.pendingBytes || actual.errors.length !== checkpoint.invalidLines) reject();
  }
  return { checkpoint, source, records: records(checkpoint, source) };
}

/** Caller supplies an explicit snapshot, policy and prior receipt. No inferred active branch or acceptance. */
export function ingestArchiveSnapshot(root: string, input: ArchiveSourceInput & { previousCheckpointId?: string }): CheckpointRead & {
  checkpointId: string; change: SnapshotChange | "repeat"; newRecords: ArchivedRecord[];
} {
  // Inspect the prior bytes BEFORE storing this snapshot, so reacquisition cannot disguise a prior gap.
  const previous = input.previousCheckpointId ? readArchiveCheckpoint(root, input.previousCheckpointId) : undefined;
  if (previous && previous.checkpoint.sourceId !== input.sourceId) throw new Error("checkpoint source mismatch");
  const captured = retainArchiveSource(root, input);
  const source = readArchiveSource(root, captured.manifestId);
  const issues: string[] = [];
  let change: SnapshotChange = previous ? "unknown" : "initial";
  let lineage = captured.manifestId;
  if (previous) {
    if (!parserEqual(previous.checkpoint.declaredParser, captured.reference.parser) || previous.checkpoint.retention !== input.retention) {
      issues.push("parser-or-representation-changed");
    } else if (previous.source.status !== "available") {
      issues.push("previous-content-unavailable");
    } else if (input.retention !== "exact") {
      issues.push("non-exact-continuity-unknown");
    } else if (source.status === "available") {
      if (captured.manifestId === previous.checkpoint.sourceManifestId) {
        return { ...previous, checkpointId: input.previousCheckpointId!, change: "repeat", newRecords: [] };
      }
      if (source.bytes.length >= previous.source.bytes.length && source.bytes.subarray(0, previous.source.bytes.length).equals(previous.source.bytes)) {
        change = "append"; lineage = previous.checkpoint.lineage;
      } else { change = "replaced"; issues.push("source-replaced"); }
    }
  }
  if (input.retention === "redacted") issues.push("redacted-representation");
  if (source.status !== "available") issues.push("content-not-retained");
  const syntax = source.status === "available" ? parseArchivedJsonl(source.bytes) : undefined;
  const checkpoint: ArchiveCheckpoint = {
    version: "archive-checkpoint-v1", sourceId: input.sourceId,
    sourceManifestId: captured.manifestId, sourceSha256: captured.reference.sha256, sourceBytes: captured.reference.bytes,
    previousCheckpointId: input.previousCheckpointId ?? null, lineage,
    declaredParser: captured.reference.parser, reader: "jsonl-syntax-v1", retention: input.retention, change,
    syntax: syntax?.status ?? "unavailable", completeBytes: syntax?.completeBytes ?? 0,
    pendingBytes: syntax?.pendingBytes ?? captured.reference.bytes, invalidLines: syntax?.errors.length ?? 0,
    issues, activeBranch: null, acceptance: "not-assessed",
  };
  const result = retainArchiveSource(root, {
    sourceId: `checkpoint-${hash(input.sourceId)}`, parser: { id: "archive-checkpoint", version: "1" },
    retention: "exact", bytes: Buffer.from(JSON.stringify(checkpoint)),
  });
  const all = records(checkpoint, source);
  return { checkpointId: result.manifestId, checkpoint, source, records: all, change,
    newRecords: change === "append" ? all.filter(record => record.start >= previous!.checkpoint.completeBytes) : all };
}
