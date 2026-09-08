import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { ingestArchiveSnapshot, readArchiveCheckpoint, type CheckpointRead } from "./archive-checkpoint.js";
import { retainArchiveSource, type ArchiveRetention } from "./evidence-archive.js";
import { ingestNativePolicy, inspectNativePolicy } from "./archive-retention-policy.js";

export interface PolicySource { id: string; path: string; parser: { id: string; version: string }; contentPolicy?: "manifest-only" | "referenced-blobs" }
export interface ArchiveIngestionPolicy {
  version: "archive-policy-v1" | "archive-policy-v2";
  id: string;
  revision: string;
  sourceRoot: string;
  archiveRoot: string;
  maxBytes: number;
  retention: ArchiveRetention;
  expiresAt: string;
  sources: PolicySource[];
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const forbidden = new Set([".pi", ".env", "auth.json", "credentials", "credentials.json"]);
function fail(): never { throw new Error("archive policy refused invalid, expired or inaccessible input"); }
const keys = (v: unknown, names: string[]): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const identifier = (v: unknown): v is string => typeof v === "string" && ID.test(v);
function regularBytes(path: string, limit: number): Buffer {
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) fail();
  const absolute = resolve(path);
  if (absolute.split(sep).some(part => forbidden.has(part))) fail();
  let current = parse(absolute).root;
  for (const part of dirname(absolute).slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part); const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  }
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail();
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size <= limit) { const n = readSync(fd, bytes, size, bytes.length - size, size); if (!n) break; size += n; }
    if (size > limit) fail(); return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}
function selectedPolicy(path: string, sourceId: string) {
  const bytes = regularBytes(path, 65536);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const p = JSON.parse(text) as ArchiveIngestionPolicy;
  // Canonical JSON excludes duplicate-key ambiguity. This is a selected operator configuration, not a signed approval.
  if (JSON.stringify(p) !== text || !keys(p, ["version", "id", "revision", "sourceRoot", "archiveRoot", "maxBytes", "retention", "expiresAt", "sources"])
    || !["archive-policy-v1", "archive-policy-v2"].includes(p.version) || !identifier(p.id) || !identifier(p.revision)
    || typeof p.sourceRoot !== "string" || !isAbsolute(p.sourceRoot) || typeof p.archiveRoot !== "string" || !isAbsolute(p.archiveRoot)
    || resolve(p.sourceRoot) === resolve(p.archiveRoot)
    || [p.sourceRoot, p.archiveRoot].some(root => root.split(/[\\/]/).some(part => forbidden.has(part)))
    || !Number.isSafeInteger(p.maxBytes) || p.maxBytes < 1 || p.maxBytes > 8 * 1024 * 1024
    || !["exact", "redacted", "reference-only"].includes(p.retention)
    || typeof p.expiresAt !== "string" || !Number.isFinite(Date.parse(p.expiresAt))
    || new Date(p.expiresAt).toISOString() !== p.expiresAt || Date.parse(p.expiresAt) <= Date.now()
    || !Array.isArray(p.sources) || p.sources.length < 1 || p.sources.length > 128) fail();
  const ids = new Set<string>();
  for (const item of p.sources) {
    if (!keys(item, p.version === "archive-policy-v2" ? ["id", "path", "parser", "contentPolicy"] : ["id", "path", "parser"]) || !identifier(item.id) || ids.has(item.id)
      || typeof item.path !== "string" || !item.path || isAbsolute(item.path) || item.path.includes("\\")
      || item.path.split("/").some(part => !part || part === "." || part === ".." || forbidden.has(part))
      || !keys(item.parser, ["id", "version"]) || !identifier(item.parser.id) || !identifier(item.parser.version)) fail();
    if (p.version === "archive-policy-v2" && !["manifest-only", "referenced-blobs"].includes(item.contentPolicy!)) fail();
    if (item.contentPolicy === "referenced-blobs" && (p.retention !== "exact" || item.parser.id !== "pi-daddy-execution-retention" || item.parser.version !== "2.0")) fail();
    ids.add(item.id);
  }
  const source = p.sources.find(s => s.id === sourceId); if (!source) fail();
  const root = lstatSync(p.sourceRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0 || (process.getuid && root.uid !== process.getuid())) fail();
  const archiveSourceId = `policy-source-${createHash("sha256").update(JSON.stringify([p.id, source.id, resolve(p.sourceRoot), source.path])).digest("hex")}`;
  return { policy: p, source, archiveSourceId, policySha256: createHash("sha256").update(bytes).digest("hex") };
}
function metadata(result: CheckpointRead, checkpointId: string, policySha256: string) {
  return { checkpointId, policySha256, sourceId: result.checkpoint.sourceId, sourceSha256: result.checkpoint.sourceSha256,
    sourceStatus: result.source.status, retention: result.checkpoint.retention, syntax: result.checkpoint.syntax,
    completeBytes: result.checkpoint.completeBytes, pendingBytes: result.checkpoint.pendingBytes,
    invalidLines: result.checkpoint.invalidLines, issues: result.checkpoint.issues,
    activeBranch: result.checkpoint.activeBranch, acceptance: result.checkpoint.acceptance };
}
/** Host-only policy binding for bounded external observation; no source bytes are read. */
export function archivePolicyBinding(policyPath: string, sourceId: string) {
  const selected = selectedPolicy(policyPath, sourceId);
  return Object.freeze({ policySha256: selected.policySha256, archiveRoot: selected.policy.archiveRoot,
    sourceId, archiveSourceId: selected.archiveSourceId, expiresAt: selected.policy.expiresAt });
}
/** Explicit operator-selected file policy. Not a credential, authorization attestation or hostile-agent sandbox. */
export function ingestPolicySource(policyPath: string, sourceId: string, previousCheckpointId?: string, expectedPolicySha256?: string) {
  try {
    const { policy, source, archiveSourceId, policySha256 } = selectedPolicy(policyPath, sourceId);
    if (expectedPolicySha256 !== undefined && expectedPolicySha256 !== policySha256) throw new Error("archive policy changed");
    if (source.contentPolicy === "referenced-blobs") return ingestNativePolicy({ policy, source, archiveSourceId, policySha256 }, previousCheckpointId, regularBytes);
    const bytes = regularBytes(join(policy.sourceRoot, source.path), policy.maxBytes);
    const result = ingestArchiveSnapshot(policy.archiveRoot, { sourceId: archiveSourceId, parser: source.parser, retention: policy.retention, bytes, previousCheckpointId });
    const receipt = retainArchiveSource(policy.archiveRoot, {
      sourceId: `policy-${policySha256}`, parser: { id: "archive-policy-receipt", version: "1" }, retention: "exact",
      bytes: Buffer.from(JSON.stringify({ version: "archive-policy-receipt-v1", policySha256, checkpointId: result.checkpointId, sourceId })),
    });
    return { ...metadata(result, result.checkpointId, policySha256), sourceId, archiveSourceId, change: result.change, policyReceiptId: receipt.manifestId };
  } catch { fail(); }
}
/** Metadata-only CLI/read-model output; no payload, local path or policy file is exported. */
export function inspectPolicyCheckpoint(policyPath: string, sourceId: string, checkpointId: string) {
  try {
    const { policy, source, archiveSourceId, policySha256 } = selectedPolicy(policyPath, sourceId);
    if (source.contentPolicy === "referenced-blobs") return inspectNativePolicy({ policy, source, archiveSourceId, policySha256 }, checkpointId);
    const result = readArchiveCheckpoint(policy.archiveRoot, checkpointId); const c = result.checkpoint;
    if (c.sourceId !== archiveSourceId || c.retention !== policy.retention || c.sourceBytes > policy.maxBytes
      || c.declaredParser.id !== source.parser.id || c.declaredParser.version !== source.parser.version) fail();
    return { ...metadata(result, checkpointId, policySha256), sourceId, archiveSourceId };
  } catch { fail(); }
}
