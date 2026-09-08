import { createHash } from "node:crypto";
import { parseExecutionRetentionManifest, RETENTION_CONTENT_KINDS } from "./generated/retention-v2-contract.js";
import { parseNativeSessionBytes } from "./generated/retention-v2-native.js";
import type { ExecutionRetentionManifest } from "./generated/retention-v2-types.js";
import { RETENTION_V2_COMMIT } from "./generated/retention-v2-pin.js";
import { retainArchiveSource, readArchiveSource } from "./evidence-archive.js";
import { assertExecutionProjection } from "./execution-projection-schema.js";

export type RetentionContentKind = typeof RETENTION_CONTENT_KINDS[number];
export interface RetentionProjection {
  version: "retention-projection-v1";
  sourceSha256: string;
  producerCommit: string;
  archiveId: string;
  identity: ExecutionRetentionManifest["identity"];
  runtime: "running" | "terminal";
  outcome: ExecutionRetentionManifest["outcome"];
  content: Record<RetentionContentKind, { status: "available" | "missing" | "mismatch"; sha256: string | null; bytes: number | null }>;
  sessionId: string | null;
  reportedBranch: { state: "unknown" | "observed"; leafId: string | null };
  activeBranch: null;
  coverage: "partial";
  issues: string[];
  acceptance: "not-assessed";
}
interface Snapshot {
  version: "retention-archive-snapshot-v1";
  producerCommit: string;
  manifestId: string;
  blobs: Record<RetentionContentKind, string | null>;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const SHA = /^[a-f0-9]{64}$/;
const parseManifest = (bytes: Uint8Array) => parseExecutionRetentionManifest(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
function project(manifest: ExecutionRetentionManifest, manifestBytes: Uint8Array, supplied: ReadonlyMap<string, Uint8Array>): RetentionProjection {
  const content = {} as RetentionProjection["content"]; const issues = [...manifest.coverage.losses];
  for (const kind of RETENTION_CONTENT_KINDS) {
    const ref = manifest.content[kind], bytes = ref.path ? supplied.get(ref.path) : undefined;
    const status = ref.status === "missing" || bytes === undefined ? "missing"
      : bytes instanceof Uint8Array && bytes.byteLength === ref.bytes && hash(bytes) === ref.sha256 ? "available" : "mismatch";
    content[kind] = { status, sha256: status === "available" ? ref.sha256 : null, bytes: status === "available" ? ref.bytes : null };
    if (status !== "available") issues.push(`content-${status}:${kind}`);
  }
  let sessionId: string | null = null;
  if (content.session.status === "available") {
    const native = manifest.nativeSession;
    if (!native.source || !native.sessionPath || !native.sessionId) issues.push("native-session-locator-unavailable");
    else {
      const parsed = parseNativeSessionBytes(supplied.get(manifest.content.session.path!)!, {
        source: native.source, path: native.sessionPath, expectedSessionId: native.sessionId,
        truncated: native.status === "truncated",
        ...(native.branchState === "observed" ? { liveLeaf: { sessionId: native.sessionId, leafId: native.branchLeafId } } : {}),
      });
      // This checks retained format/chain consistency, never authenticates the manifest's live observation.
      if (parsed.observation.status !== native.status || parsed.observation.sha256 !== native.sha256
        || parsed.observation.lastPersistedEntryId !== native.lastPersistedEntryId) issues.push("native-session-inconsistent");
      else sessionId = parsed.observation.sessionId;
    }
  }
  if (manifest.nativeSession.branchState === "observed") issues.push("active-branch-not-independently-verified");
  return {
    version: "retention-projection-v1", sourceSha256: hash(manifestBytes), producerCommit: RETENTION_V2_COMMIT,
    archiveId: manifest.archiveId, identity: manifest.identity, runtime: manifest.state, outcome: manifest.outcome,
    content, sessionId, reportedBranch: { state: manifest.nativeSession.branchState, leafId: manifest.nativeSession.branchLeafId },
    activeBranch: null, coverage: "partial", issues: [...new Set(issues)].sort(), acceptance: "not-assessed",
  };
}

/** Caller already owns an exact-content policy. No paths from the producer are opened here. */
export function ingestRetainedExecution(root: string, input: {
  manifest: Uint8Array; blobs: ReadonlyMap<string, Uint8Array>; retention: "exact"; sourceId?: string;
}) {
  if (input.retention !== "exact") throw new Error("native semantic ingestion requires explicit exact-content policy; archive redacted/reference-only data as opaque evidence");
  const bytes = Buffer.from(input.manifest); const manifest = parseManifest(bytes);
  for (const ref of Object.values(manifest.content)) {
    const supplied = ref.path ? input.blobs.get(ref.path) : undefined;
    if (supplied !== undefined && (!(supplied instanceof Uint8Array) || supplied.byteLength > 1024 * 1024)) throw new Error("retention blob exceeds input bounds");
  }
  const projection = project(manifest, bytes, input.blobs);
  const source = retainArchiveSource(root, { sourceId: input.sourceId ?? `retention-${manifest.archiveId}`, parser: { id: "pi-daddy-execution-retention", version: "2.0" }, retention: "exact", bytes });
  const blobs = {} as Snapshot["blobs"];
  for (const kind of RETENTION_CONTENT_KINDS) {
    blobs[kind] = null;
    const ref = manifest.content[kind];
    if (!ref.path || input.blobs.get(ref.path) === undefined) continue;
    // Preserve bounded mismatched bytes as forensic input; their presence never makes them valid evidence.
    blobs[kind] = retainArchiveSource(root, { sourceId: `${manifest.archiveId}-${kind}`, parser: { id: "opaque-bytes", version: "1" }, retention: "exact", bytes: input.blobs.get(ref.path)! }).manifestId;
  }
  const snapshot: Snapshot = { version: "retention-archive-snapshot-v1", producerCommit: RETENTION_V2_COMMIT, manifestId: source.manifestId, blobs };
  const stored = retainArchiveSource(root, { sourceId: `execution-${manifest.archiveId}`, parser: { id: "retention-archive-snapshot", version: "1" }, retention: "exact", bytes: Buffer.from(JSON.stringify(snapshot)) });
  return { snapshotId: stored.manifestId, projection };
}

/** Recompute availability from current retained bytes; a deleted blob never inherits its old available status. */
export function readRetainedExecution(root: string, snapshotId: string) {
  const stored = readArchiveSource(root, snapshotId);
  if (stored.status !== "available" || stored.reference.retention !== "exact") throw new Error("retention snapshot missing or invalid");
  const text = stored.bytes.toString("utf8"), snapshot = JSON.parse(text) as Snapshot;
  if (JSON.stringify(snapshot) !== text || !snapshot || Object.keys(snapshot).sort().join() !== "blobs,manifestId,producerCommit,version"
    || snapshot.version !== "retention-archive-snapshot-v1" || snapshot.producerCommit !== RETENTION_V2_COMMIT || !SHA.test(snapshot.manifestId)
    || !snapshot.blobs || Object.keys(snapshot.blobs).sort().join() !== [...RETENTION_CONTENT_KINDS].sort().join()
    || Object.values(snapshot.blobs).some(id => id !== null && (typeof id !== "string" || !SHA.test(id)))) throw new Error("invalid retention snapshot");
  const source = readArchiveSource(root, snapshot.manifestId);
  if (source.status !== "available" || source.reference.retention !== "exact") throw new Error("retained producer manifest missing or invalid");
  const manifest = parseManifest(source.bytes); const supplied = new Map<string, Uint8Array>();
  for (const kind of RETENTION_CONTENT_KINDS) {
    const id = snapshot.blobs[kind], ref = manifest.content[kind]; if (!id || !ref.path) continue;
    const content = readArchiveSource(root, id);
    if (content.status === "available" && content.reference.retention === "exact") supplied.set(ref.path, content.bytes);
  }
  return { snapshotId, sourceId: source.reference.sourceId, manifest, projection: project(manifest, source.bytes, supplied) };
}

/** Order-independent joins, not an acceptance engine. Logical child names and native parents are not execution keys. */
export function projectRetainedExecutions(snapshots: readonly RetentionProjection[]) {
  if (snapshots.length > 4096) throw new Error("retention projection exceeds snapshot bound");
  const unique = [...new Map(snapshots.map(p => [JSON.stringify(p), p])).values()];
  const objectKey = (value: object) => JSON.stringify(Object.keys(value).sort().map(key => [key, (value as Record<string, unknown>)[key]]));
  const groups = new Map<string, RetentionProjection[]>();
  for (const snapshot of unique) {
    const id = snapshot.identity.executionId; groups.set(id, [...(groups.get(id) ?? []), snapshot]);
  }
  const lineageIssue = (start: string): string | null => {
    const seen = new Set<string>(); let id: string | null = start;
    while (id !== null && groups.has(id)) {
      if (seen.has(id)) return "cyclic-parentage";
      seen.add(id);
      const parents: Array<string | null> = [...new Set(groups.get(id)!.map(p => p.identity.parentExecutionId))];
      if (parents.length !== 1) return "ambiguous-parentage";
      id = parents[0];
    }
    return null;
  };
  const executions = [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([executionId, values]) => {
    const identities = new Set(values.map(p => objectKey(p.identity)));
    const terminals = values.filter(p => p.runtime === "terminal");
    const outcomes = new Set(terminals.map(p => objectKey(p.outcome!)));
    const issues = new Set(values.flatMap(p => p.issues));
    if (identities.size > 1) issues.add("execution-identity-conflict");
    if (outcomes.size > 1) issues.add("terminal-outcome-conflict");
    const lineage = lineageIssue(executionId); if (lineage) issues.add(lineage);
    const parentExecutionIds = [...new Set(values.map(p => p.identity.parentExecutionId))].sort();
    const retainedSessionIds = [...new Set(values.map(p => p.sessionId).filter((id): id is string => id !== null))].sort();
    if (retainedSessionIds.length > 1) issues.add("session-identity-conflict");
    if (parentExecutionIds.some(id => id !== null && !groups.has(id))) issues.add("parent-not-in-snapshot");
    return { executionId, parentExecutionIds, retainedSessionIds, activeBranch: null, toolCallIds: [...new Set(values.map(p => p.identity.toolCallId))].sort(),
      archiveIds: [...new Set(values.map(p => p.archiveId))].sort(),
      runtime: identities.size > 1 || outcomes.size > 1 ? "conflict" : terminals.length ? "terminal" : "running",
      outcome: identities.size === 1 && outcomes.size === 1 ? terminals[0].outcome : null,
      sourceReferences: [...new Set(values.map(p => p.sourceSha256))].sort(), issues: [...issues].sort(), coverage: "partial" as const, acceptance: "not-assessed" as const };
  });
  const projection = { version: "execution-archive-projection-v1" as const, executions, acceptance: "not-assessed" as const };
  assertExecutionProjection(projection);
  return projection;
}
