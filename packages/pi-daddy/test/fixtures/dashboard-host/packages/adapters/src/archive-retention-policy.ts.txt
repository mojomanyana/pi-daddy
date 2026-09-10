import { dirname, join } from "node:path";
import type { ArchiveIngestionPolicy, PolicySource } from "./archive-policy.js";
import { parseExecutionRetentionManifest } from "./generated/retention-v2-contract.js";
import { ingestRetainedExecution, readRetainedExecution, type RetentionProjection } from "./execution-retention-archive.js";
import { retainArchiveSource } from "./evidence-archive.js";
interface Context { policy: ArchiveIngestionPolicy; source: PolicySource; archiveSourceId: string; policySha256: string }
function metadata(context: Context, checkpointId: string, projection: RetentionProjection) {
  return {
    kind: "execution-retention-v2" as const, checkpointId, policySha256: context.policySha256,
    sourceId: context.source.id, archiveSourceId: context.archiveSourceId, sourceSha256: projection.sourceSha256,
    sourceStatus: "available" as const, retention: "exact" as const, syntax: "not-applicable" as const,
    runtime: projection.runtime, content: projection.content, activeBranch: null,
    coverage: projection.coverage, issueCount: projection.issues.length, acceptance: projection.acceptance,
  };
}
export function inspectNativePolicy(context: Context, checkpointId: string) {
  const read = readRetainedExecution(context.policy.archiveRoot, checkpointId);
  if (read.sourceId !== context.archiveSourceId || Object.values(read.manifest.content).some(ref => ref.bytes !== null && ref.bytes > context.policy.maxBytes)) throw new Error("native snapshot outside policy");
  return metadata(context, checkpointId, read.projection);
}
export function ingestNativePolicy(context: Context, previous: string | undefined, readBytes: (path: string, limit: number) => Buffer) {
  if (previous) inspectNativePolicy(context, previous);
  const path = join(context.policy.sourceRoot, context.source.path);
  const manifestBytes = readBytes(path, Math.min(context.policy.maxBytes, 65536));
  const manifest = parseExecutionRetentionManifest(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  const blobs = new Map<string, Uint8Array>();
  for (const ref of Object.values(manifest.content)) {
    if (!ref.path) continue;
    if (ref.bytes! > context.policy.maxBytes) throw new Error("native content exceeds policy bound");
    try { blobs.set(ref.path, readBytes(join(dirname(path), ref.path), Math.min(context.policy.maxBytes, 1024 * 1024))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const result = ingestRetainedExecution(context.policy.archiveRoot, {
    manifest: manifestBytes, blobs, retention: "exact", sourceId: context.archiveSourceId,
  });
  const receipt = retainArchiveSource(context.policy.archiveRoot, {
    sourceId: `policy-${context.policySha256}`, parser: { id: "archive-policy-receipt", version: "1" }, retention: "exact",
    bytes: Buffer.from(JSON.stringify({ version: "archive-policy-receipt-v1", policySha256: context.policySha256, checkpointId: result.snapshotId, sourceId: context.source.id })),
  });
  return { ...metadata(context, result.snapshotId, result.projection), change: previous === result.snapshotId ? "repeat" : previous ? "observation" : "initial", policyReceiptId: receipt.manifestId };
}
