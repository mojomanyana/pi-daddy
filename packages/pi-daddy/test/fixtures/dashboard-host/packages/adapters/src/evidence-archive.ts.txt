import {
  closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, parse, resolve, sep } from "node:path";

const LIMIT = 8 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export type ArchiveRetention = "exact" | "redacted" | "reference-only";
export interface ArchiveSourceReference {
  schema: "archive-source-v1";
  sourceId: string;
  parser: { id: string; version: string };
  sha256: string;
  bytes: number;
  retention: ArchiveRetention;
}
export interface ArchiveSourceInput {
  sourceId: string;
  parser: { id: string; version: string };
  bytes: Uint8Array;
  /** Explicit caller policy; this API neither authorizes collection nor redacts data. */
  retention: ArchiveRetention;
}
export type ArchiveRead =
  | { status: "available"; reference: ArchiveSourceReference; bytes: Buffer }
  | { status: "missing"; reason: "manifest" | "content" | "not-retained" }
  | { status: "error"; reason: string };

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
function fail(message: string): never { throw new Error(`archive: ${message}`); }

function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));
}
function validReference(value: unknown): value is ArchiveSourceReference {
  if (!keys(value, ["schema", "sourceId", "parser", "sha256", "bytes", "retention"])) return false;
  return value.schema === "archive-source-v1"
    && typeof value.sourceId === "string" && ID.test(value.sourceId)
    && keys(value.parser, ["id", "version"])
    && typeof value.parser.id === "string" && ID.test(value.parser.id)
    && typeof value.parser.version === "string" && ID.test(value.parser.version)
    && typeof value.sha256 === "string" && HASH.test(value.sha256)
    && Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0 && Number(value.bytes) <= LIMIT
    && typeof value.retention === "string" && ["exact", "redacted", "reference-only"].includes(value.retention);
}

/** Reject existing symlink ancestors. This is a trusted local-writer boundary, not an OS sandbox. */
function directory(path: string, create: boolean): void {
  if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK) fail("required filesystem flags unavailable");
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (!absent(error) || !create) throw error;
      mkdirSync(current, { mode: 0o700 }); stat = lstatSync(current);
    }
    if (stat.isSymbolicLink()) fail("symlink directory refused");
    if (!stat.isDirectory()) fail("non-directory path refused");
  }
  const stat = lstatSync(absolute);
  if ((stat.mode & 0o077) !== 0) fail("archive directory must be private");
  if (process.getuid && stat.uid !== process.getuid()) fail("archive directory owner mismatch");
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readVerified(path: string, hash: string, limit = LIMIT): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || (stat.mode & 0o077) !== 0) fail("invalid retained file");
    const buffer = Buffer.alloc(limit + 1); let size = 0;
    while (size <= limit) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size > limit) fail("retained byte limit exceeded");
    const bytes = buffer.subarray(0, size);
    if (digest(bytes) !== hash) fail("content identity mismatch");
    return bytes;
  } finally { closeSync(fd); }
}
function put(root: string, category: "objects" | "manifests", bytes: Buffer): string {
  const hash = digest(bytes); const dir = join(root, category); directory(dir, true);
  const target = join(dir, hash);
  try { readVerified(target, hash); return hash; }
  catch (error) { if (!absent(error)) throw error; }
  const temporary = join(dir, `.pending-${randomUUID()}`);
  let owned = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    owned = true;
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      readVerified(target, hash); // Never overwrite an existing corrupt or redirected object.
    }
  } finally {
    if (owned) unlinkSync(temporary); // Only this invocation's own staging file.
  }
  syncDirectory(dir);
  return hash;
}

/** External explicit ingestion only: no session writes, worker callbacks, network or automatic discovery. */
export function retainArchiveSource(root: string, input: ArchiveSourceInput): { manifestId: string; reference: ArchiveSourceReference } {
  if (!(input.bytes instanceof Uint8Array)) fail("bytes required");
  if (input.bytes.byteLength > LIMIT) fail("source byte limit exceeded");
  const bytes = Buffer.from(input.bytes);
  const reference: ArchiveSourceReference = {
    schema: "archive-source-v1", sourceId: input.sourceId,
    parser: { id: input.parser?.id, version: input.parser?.version },
    sha256: digest(bytes), bytes: bytes.length, retention: input.retention,
  };
  if (!validReference(reference)) fail("invalid metadata or retention policy");
  directory(root, true);
  if (reference.retention !== "reference-only") put(root, "objects", bytes);
  // A manifest becomes visible only after its required content has been persisted.
  const manifestId = put(root, "manifests", Buffer.from(JSON.stringify(reference)));
  syncDirectory(resolve(root));
  return { manifestId, reference };
}

export function readArchiveSource(root: string, manifestId: string, maxBytes = LIMIT): ArchiveRead {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > LIMIT) return { status: "error", reason: "invalid read bound" };
  if (!HASH.test(manifestId)) return { status: "error", reason: "invalid manifest identity" };
  try {
    let manifest: Buffer;
    try {
      directory(root, false); directory(join(root, "manifests"), false);
      manifest = readVerified(join(root, "manifests", manifestId), manifestId, 8192);
    } catch (error) {
      if (absent(error)) return { status: "missing", reason: "manifest" };
      throw error;
    }
    const text = manifest.toString("utf8"); const reference: unknown = JSON.parse(text);
    if (!validReference(reference) || JSON.stringify(reference) !== text) fail("invalid manifest");
    if (reference.retention === "reference-only") return { status: "missing", reason: "not-retained" };
    if (reference.bytes > maxBytes) return { status: "error", reason: "read bound exceeded" };
    let bytes: Buffer;
    try {
      directory(join(root, "objects"), false);
      bytes = readVerified(join(root, "objects", reference.sha256), reference.sha256, maxBytes);
    } catch (error) {
      if (absent(error)) return { status: "missing", reason: "content" };
      throw error;
    }
    if (bytes.length !== reference.bytes) fail("retained length mismatch");
    return { status: "available", reference, bytes };
  } catch {
    // No raw paths, content or exception payloads escape into exported diagnostics.
    return { status: "error", reason: "invalid or inaccessible retained evidence" };
  }
}

export interface ArchivedJsonl {
  status: "complete" | "partial" | "error";
  records: Array<{ line: number; start: number; end: number; value: unknown }>;
  errors: Array<{ line: number; start: number; reason: "invalid-json" }>;
  completeBytes: number;
  pendingBytes: number;
}
/** Syntax/byte coverage only. No semantic validation, branch inference, deduplication or acceptance. */
export function parseArchivedJsonl(bytes: Uint8Array): ArchivedJsonl {
  if (bytes.byteLength > LIMIT) fail("source byte limit exceeded");
  const buffer = Buffer.from(bytes); const records: ArchivedJsonl["records"] = []; const errors: ArchivedJsonl["errors"] = [];
  let start = 0; let line = 1;
  while (start < buffer.length) {
    const newline = buffer.indexOf(10, start);
    if (newline < 0) break;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(start, newline));
      records.push({ line, start, end: newline + 1, value: JSON.parse(text) });
    } catch { errors.push({ line, start, reason: "invalid-json" }); }
    start = newline + 1; line++;
  }
  return { status: errors.length ? "error" : start === buffer.length ? "complete" : "partial", records, errors, completeBytes: start, pendingBytes: buffer.length - start };
}
