import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { parseRetentionJson } from "./retention-json.ts";
import { runWithFinalizers } from "./finalization.ts";

export const ARCHIVE_PROJECTION_VERSION = "execution-archive-projection-v1" as const;
export const DAILY_INPUT_LIMIT = 4 * 1024 * 1024;
export interface ArchiveExecution {
  executionId: string; parentExecutionIds: (string | null)[]; retainedSessionIds: string[]; activeBranch: null;
  toolCallIds: (string | null)[]; archiveIds: string[]; runtime: "running" | "terminal" | "conflict";
  outcome: { code: number | null; signal: string | null; timedOut: boolean; aborted: boolean; truncated: boolean; failed: boolean } | null;
  sourceReferences: string[]; issues: string[]; coverage: "partial"; acceptance: "not-assessed";
}
export interface ArchiveProjection { version: typeof ARCHIVE_PROJECTION_VERSION; executions: ArchiveExecution[]; acceptance: "not-assessed" }
const schema = createRequire(import.meta.url)("../contracts/daily-view/v1/p03/projection.schema.json");
const validator = Compile(schema);
export const byteHash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export function freezeDaily<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeDaily); Object.freeze(value); }
  return value;
}
/** Exact vendored P03 shape, plus no duplicate execution identity or contradictory terminal shape.
 * Only the producer's emitted integer-token subset is supported; no lossy fractional rounding. */
export function parseArchiveProjection(text: string): ArchiveProjection {
  const value = parseRetentionJson(text, DAILY_INPUT_LIMIT);
  for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[^\s{}\[\],:]+/g)) {
    if (/^-?\d/.test(match[0]) && !/^-?(0|[1-9]\d*)$/.test(match[0])) throw new TypeError("unsupported archive numeric token");
  }
  if (!validator.Check(value)) throw new TypeError("unsupported archive projection shape/version");
  const projection = value as ArchiveProjection, ids = new Set<string>();
  for (const e of projection.executions) {
    if (ids.has(e.executionId) || (e.runtime !== "terminal" && e.outcome !== null)) throw new TypeError("ambiguous archive execution");
    ids.add(e.executionId);
  }
  projection.executions.sort((a, b) => a.executionId < b.executionId ? -1 : a.executionId > b.executionId ? 1 : 0);
  return freezeDaily(projection);
}
export type SnapshotRead = { status: "read"; bytes: Buffer; sha256: string } | { status: "missing" | "error" | "unconfigured"; reason: string };
/** Caller-authorized exact file only. No directories, symlink following, watching or mtime freshness claim. */
export async function readDailySnapshot(path: string | undefined, limit = DAILY_INPUT_LIMIT): Promise<SnapshotRead> {
  if (!path) return { status: "unconfigured", reason: "not-configured" };
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return await runWithFinalizers(async (): Promise<SnapshotRead> => {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(limit)) return { status: "error", reason: "not-regular-or-over-limit" };
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < bytes.length) { const n = (await file.read(bytes, offset, bytes.length - offset, offset)).bytesRead;
        if (!n) return { status: "error", reason: "changed-during-read" }; offset += n; }
      const after = await file.stat({ bigint: true }), located = await lstat(path, { bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        after.dev !== located.dev || after.ino !== located.ino) return { status: "error", reason: "changed-during-read" };
      return { status: "read", bytes, sha256: byteHash(bytes) };
    }, [{ label: "snapshot close failed", run: () => file.close() }]);
  } catch (error) { return { status: (error as { code?: string }).code === "ENOENT" ? "missing" : "error", reason: "snapshot-unavailable" }; }
}
