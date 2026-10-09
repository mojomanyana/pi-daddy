/** Offline, explicit-selection export. Original files are read only; output is private and never training data. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readBoundedBytes } from "../kernel/bounded-read.ts";
import { parseRetentionJson } from "../governance/retention-json.ts";
import { parseExecutionRetentionManifest, RETENTION_CONTENT_KINDS } from "../governance/retention-contract.ts";
import { filterDiagnostic, type DiagnosticFormat } from "./diagnostic-filter.ts";

const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_SOURCES = 1024;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const pathValue = (x: unknown): x is string =>
  typeof x === "string" && x.length > 0 && x.length <= 4096 && !/[\x00-\x1f]/.test(x);
const hashValue = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
interface Source {
  path: string;
  format: DiagnosticFormat;
  sha256?: string;
}
export interface DiagnosticSelection {
  version: 1;
  sources: Source[];
  retentionRoots?: string[];
}
interface InventoryEntry {
  source: string;
  format: string;
  status: "included" | "missing" | "excluded";
  reason?: string;
  sourceSha256?: string;
  sourceBytes?: number;
  path?: string;
  sha256?: string;
  bytes?: number;
  omissions?: Record<string, number>;
}

export function parseDiagnosticSelection(text: string, base: string): DiagnosticSelection {
  const value = parseRetentionJson(text, 256 * 1024);
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.sources) ||
    Object.keys(value).some((key) => !["version", "sources", "retentionRoots"].includes(key)) ||
    value.sources.length > MAX_SOURCES ||
    (value.retentionRoots !== undefined && (!Array.isArray(value.retentionRoots) || value.retentionRoots.length > 16))
  )
    throw new Error("invalid diagnostic selection v1");
  const sources = value.sources.map((source): Source => {
    if (
      !object(source) ||
      !pathValue(source.path) ||
      !["session", "json", "jsonl", "text"].includes(String(source.format)) ||
      Object.keys(source).some((key) => !["path", "format", "sha256"].includes(key)) ||
      (source.sha256 !== undefined && !hashValue(source.sha256))
    )
      throw new Error("invalid diagnostic source");
    return {
      path: resolve(base, source.path),
      format: source.format as DiagnosticFormat,
      ...(source.sha256 ? { sha256: source.sha256 as string } : {}),
    };
  });
  const retentionRoots = ((value.retentionRoots ?? []) as unknown[]).map((path) => {
    if (!pathValue(path)) throw new Error("invalid retention root");
    return resolve(base, path);
  });
  return { version: 1, sources, retentionRoots };
}

async function readSource(path: string, limit = MAX_FILE): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || (await realpath(path)) !== resolve(path))
    throw new Error("source-must-be-canonical-regular-file");
  const result = await readBoundedBytes(
    path,
    { maxBytes: limit, timeoutMs: 10000 },
    {
      open: (file, flags) => open(file, flags | constants.O_NOFOLLOW),
      read: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: (handle) => handle.close(),
    },
  );
  if (!result.ok) throw new Error(`source-${result.why}`);
  const after = await lstat(path);
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    after.size !== result.bytes.length
  )
    throw new Error("source-changed-during-read");
  return result.bytes;
}
const reason = (error: unknown): string => {
  const code = object(error) && typeof error.code === "string" ? error.code : undefined;
  if (code) return code;
  return error instanceof Error && /^source-[a-z-]+$/.test(error.message)
    ? error.message
    : "invalid-or-unreadable-source";
};

export async function exportDiagnostics(selectionPath: string, destination: string) {
  const selectedPath = resolve(selectionPath);
  const selectedBytes = await readSource(selectedPath, 256 * 1024);
  const selection = parseDiagnosticSelection(
    new TextDecoder("utf-8", { fatal: true }).decode(selectedBytes),
    dirname(selectedPath),
  );
  const choices = new Map<string, Source>();
  for (const source of selection.sources) {
    const prior = choices.get(source.path);
    if (prior && (prior.format !== source.format || prior.sha256 !== source.sha256))
      throw new Error("conflicting diagnostic selection for one source");
    choices.set(source.path, source);
  }
  const target = resolve(destination);
  if ((await realpath(dirname(target))) !== dirname(target)) throw new Error("destination parent must be canonical");
  await mkdir(target, { mode: 0o700 }); // Exclusive: never overwrite or remove an existing directory.
  await mkdir(join(target, "objects"), { mode: 0o700 });
  const inventory: InventoryEntry[] = [];
  const objects = new Map<string, number>();
  const seen = new Map<string, { source: Source; row: InventoryEntry }>();
  let total = 0;
  let readTotal = 0;
  const read = async (source: Source) => {
    if (readTotal >= MAX_TOTAL) throw new Error("source-total-size-limit");
    const raw = await readSource(source.path, Math.min(MAX_FILE, MAX_TOTAL - readTotal));
    readTotal += raw.length;
    return raw;
  };
  const add = async (source: Source, expectedBytes?: number, traverse = false): Promise<Buffer | undefined> => {
    const prior = seen.get(source.path);
    const expected = (digest: string | undefined, bytes: number | undefined) => {
      if (source.sha256 && digest !== source.sha256) throw new Error("source-digest-mismatch");
      if (expectedBytes !== undefined && bytes !== expectedBytes) throw new Error("source-size-mismatch");
    };
    if (prior) {
      if (prior.source.format !== source.format) throw new Error("conflicting diagnostic selection for one source");
      if (prior.row.status !== "included") return undefined;
      try {
        expected(prior.row.sourceSha256, prior.row.sourceBytes);
        if (!traverse) return undefined;
        // A selected manifest still needs traversal. Re-read and compare rather than caching all raw payloads.
        const raw = await read(source);
        if (sha256(raw) !== prior.row.sourceSha256 || raw.length !== prior.row.sourceBytes)
          throw new Error("source-changed-before-traversal");
        return raw;
      } catch (error) {
        inventory.push({ source: source.path, format: source.format, status: "missing", reason: reason(error) });
        return undefined;
      }
    }
    if (seen.size >= MAX_SOURCES) throw new Error("diagnostic source count exceeds bounds");
    const row: InventoryEntry = { source: source.path, format: source.format, status: "missing" };
    seen.set(source.path, { source, row });
    inventory.push(row);
    try {
      const raw = await read(source);
      row.sourceSha256 = sha256(raw);
      row.sourceBytes = raw.length;
      expected(row.sourceSha256, row.sourceBytes);
      const filtered = filterDiagnostic(raw, source.format);
      const hash = sha256(filtered.bytes),
        path = `objects/${hash}`;
      if (!objects.has(hash)) {
        if (total + filtered.bytes.length > MAX_TOTAL) throw new Error("source-export-size-limit");
        await writeFile(join(target, path), filtered.bytes, { flag: "wx", mode: 0o600 });
        objects.set(hash, filtered.bytes.length);
        total += filtered.bytes.length;
      }
      Object.assign(row, {
        status: "included",
        path,
        sha256: hash,
        bytes: filtered.bytes.length,
        omissions: filtered.omissions,
      });
      return raw;
    } catch (error) {
      row.reason = reason(error);
      return undefined;
    }
  };
  for (const source of [...choices.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
    await add(source);
  const captures: unknown[] = [];
  for (const root of [...new Set(selection.retentionRoots)].sort()) {
    try {
      if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
        throw new Error("source-invalid-retention-root");
      const entries = await readdir(root, { withFileTypes: true });
      if (entries.length > MAX_SOURCES) throw new Error("source-directory-size-limit");
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (!entry.isDirectory()) continue;
        const manifestPath = join(root, entry.name, "manifest.json");
        const raw = await add({ path: manifestPath, format: "json" }, undefined, true);
        if (!raw) continue;
        let manifest;
        try {
          manifest = parseExecutionRetentionManifest(raw.toString("utf8"));
        } catch {
          inventory.push({
            source: `${manifestPath}#manifest`,
            format: "retention-manifest",
            status: "missing",
            reason: "invalid-retention-manifest",
          });
          captures.push({ source: manifestPath, status: "invalid-retention-manifest" });
          continue;
        }
        const losses = manifest.coverage.losses;
        captures.push({
          source: manifestPath,
          nativeSession: manifest.nativeSession,
          state: manifest.state,
          currentLosses: losses.filter((loss) => loss !== "native-session-read-failed-earlier"),
          recoveredObservations: losses.filter((loss) => loss === "native-session-read-failed-earlier"),
          acceptance: "not-assessed",
        });
        for (const kind of RETENTION_CONTENT_KINDS) {
          const value = manifest.content[kind];
          const format = kind === "session" ? "session" : kind === "checkReceipt" ? "json" : "text";
          const source = `${manifestPath}#${kind}`;
          if (!object(value) || value.status !== "retained") {
            inventory.push({ source, format, status: "missing", reason: "not-retained" });
            continue;
          }
          if (!["session", "checkReceipt", "result"].includes(kind)) {
            inventory.push({
              source,
              format,
              status: "excluded",
              reason: "raw-stream-or-pane",
              sourceSha256: hashValue(value.sha256) ? value.sha256 : undefined,
            });
            continue;
          }
          await add(
            { path: join(dirname(manifestPath), value.path as string), format, sha256: value.sha256! },
            value.bytes as number,
          );
        }
      }
    } catch (error) {
      inventory.push({ source: root, format: "retention-root", status: "missing", reason: reason(error) });
    }
  }
  // Capture metadata is also filtered; an untrusted manifest must not smuggle fields past the projection.
  const manifest = {
    version: 1,
    policy: "pi-daddy-visible-diagnostic-v1",
    selectionSha256: sha256(selectedBytes),
    entries: inventory,
    objects: objects.size,
    exportedBytes: total,
    captures,
    private: true,
    trainingEligible: false,
    exportEligible: false,
    acceptance: "not-assessed",
    limitations: [
      "Not an atomic filesystem snapshot; sources are checked individually.",
      "Known reasoning/environment fields omitted; free-text secret detection is heuristic. Review before sharing.",
      "Raw streams, images, unsupported native entries and unselected files are not exported.",
      "Source hashes identify original bytes; object hashes identify filtered bytes. Neither grants approval or training rights.",
    ],
  };
  const safeManifest = filterDiagnostic(Buffer.from(JSON.stringify(manifest)), "json").bytes;
  await writeFile(join(target, "inventory.json"), safeManifest, { mode: 0o600, flag: "wx" });
  const missing = inventory.filter((entry) => entry.status === "missing").length;
  return {
    directory: target,
    inventory: join(target, "inventory.json"),
    sha256: sha256(safeManifest),
    entries: inventory.length,
    objects: objects.size,
    missing,
    trainingEligible: false,
  };
}
