/**
 * One record envelope for every append-only store (ADR-0076 PR 3d).
 *
 * A line is `{ v, seq, prev, at, kind, id, body, digest }`: `prev` is the SHA-256 of the previous line's
 * bytes (null for the first), `digest` the SHA-256 of the canonical JSON of the record without `digest`.
 * Writes go under the existing file lock and read only the tail, so an append is O(tail), not O(file).
 *
 * Damage policy (operator decision, 2026-09-21): the reader returns every intact record before the first
 * damaged line plus one marker naming that line; the writer refuses `LEDGER_DAMAGED` until `repairLedger`
 * truncates the torn tail with the caller's explicit consent. Governance fails closed (no spawn goes
 * unrecorded), history stays readable, repair is a deliberate act that shows what it drops.
 *
 * Stated limit: the WRITER inspects only the last line, so a record tampered in the middle of the file does not
 * stop appends; it shows as damage on every READ (report, dashboard, timeline), and a repair there would drop
 * every intact record after it. That is why repair previews by default and why the preview names records it
 * would drop that still parse. Whole-file verification is the reader's job, not the writer's.
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, stat, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { GovernanceRefusal, refusal } from "../kernel/refusals.ts";
import { withFileLock } from "./file-lock.ts";

export const RECORD_FORMAT = 1 as const;
export const RECORD_KINDS = [
  "binding",
  "capability",
  "lifecycle",
  "approval",
  "lease",
  "check",
  "fact",
  "work",
  "control",
  "experiment",
  "activity",
  "advice",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export const LEDGER_DAMAGED = "LEDGER_DAMAGED" as const;

export interface RecordEnvelope<B = unknown> {
  v: typeof RECORD_FORMAT;
  seq: number;
  prev: string | null;
  at: string;
  kind: RecordKind;
  id: string;
  body: B;
  /** Present when the record was copied from a pre-format store; the original is left untouched. */
  imported?: { path: string; line: number };
  digest: string;
}

export interface RecordDamage {
  line: number;
  reason: string;
}

export interface ReadRecords<B = unknown> {
  records: RecordEnvelope<B>[];
  damage: RecordDamage | null;
}

/** Deterministic JSON: sorted object keys at every level, arrays in order. No `undefined` survives. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function recordDigest(record: object): string {
  const { digest: _drop, ...rest } = record as Record<string, unknown>;
  return sha256(canonicalJson(rest));
}

const HEX64 = /^[0-9a-f]{64}$/;
/** Damage reasons that mean "this is not a record file at all" rather than "a record file with a torn tail". */
export const PRE_FORMAT_REASONS: ReadonlySet<string> = new Set([
  "unknown format version",
  "not an object",
  "invalid seq",
  "invalid prev",
  "invalid timestamp",
  "unknown kind",
  "invalid id",
  "missing body",
  "invalid digest",
]);

/** Parse one line; returns a reason string when it is not a well-formed record of this format. */
function parseLine(line: string): { record: RecordEnvelope } | { reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { reason: "unterminated or unparsable line" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: "not an object" };
  const r = value as Record<string, unknown>;
  if (r.v !== RECORD_FORMAT) return { reason: "unknown format version" };
  if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 1) return { reason: "invalid seq" };
  if (!(r.prev === null || (typeof r.prev === "string" && HEX64.test(r.prev)))) return { reason: "invalid prev" };
  if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return { reason: "invalid timestamp" };
  if (typeof r.kind !== "string" || !(RECORD_KINDS as readonly string[]).includes(r.kind))
    return { reason: "unknown kind" };
  if (typeof r.id !== "string" || r.id.length === 0 || r.id.length > 128) return { reason: "invalid id" };
  if (!("body" in r)) return { reason: "missing body" };
  if (typeof r.digest !== "string" || !HEX64.test(r.digest)) return { reason: "invalid digest" };
  const record = r as unknown as RecordEnvelope;
  if (recordDigest(record) !== record.digest) return { reason: "digest mismatch" };
  return { record };
}

/** Read every intact record before the first damaged line. Never throws on content; damage is data. */
export function readRecords<B = unknown>(text: string): ReadRecords<B> {
  const records: RecordEnvelope<B>[] = [];
  if (text.length === 0) return { records, damage: null };
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) lines.pop();
  let prevLine: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const last = index === lines.length - 1;
    if (last && !terminated)
      return { records, damage: { line: lineNumber, reason: "unterminated or unparsable line" } };
    const parsed = parseLine(line);
    if ("reason" in parsed) return { records, damage: { line: lineNumber, reason: parsed.reason } };
    const { record } = parsed;
    if (record.seq !== records.length + 1) return { records, damage: { line: lineNumber, reason: "sequence gap" } };
    const expectedPrev = prevLine === null ? null : sha256(prevLine);
    if (record.prev !== expectedPrev) return { records, damage: { line: lineNumber, reason: "prev hash mismatch" } };
    records.push(record as RecordEnvelope<B>);
    prevLine = line;
  }
  return { records, damage: null };
}

export async function readRecordsFile<B = unknown>(path: string): Promise<ReadRecords<B>> {
  try {
    return readRecords<B>(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], damage: null };
    throw error;
  }
}

/** The last complete line and its sequence, reading only the file's tail. Damage is reported, not skipped. */
async function tail(path: string): Promise<{ seq: number; prevLine: string | null } | { damage: RecordDamage }> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { seq: 0, prevLine: null };
    throw error;
  }
  if (size === 0) return { seq: 0, prevLine: null };
  const window = Math.min(size, 256 * 1024);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(window);
    await handle.read(buffer, 0, window, size - window);
    const text = buffer.toString("utf8");
    if (!text.endsWith("\n")) return { damage: { line: -1, reason: "unterminated or unparsable line" } };
    const body = text.slice(0, -1);
    const cut = body.lastIndexOf("\n");
    const lastLine = cut === -1 ? body : body.slice(cut + 1);
    if (cut === -1 && window < size) {
      // The last record is larger than the window: read the whole file once rather than call it damage.
      const whole = (await readFile(path, "utf8")).slice(0, -1);
      const wholeCut = whole.lastIndexOf("\n");
      const wholeLast = wholeCut === -1 ? whole : whole.slice(wholeCut + 1);
      const parsedWhole = parseLine(wholeLast);
      if ("reason" in parsedWhole) return { damage: { line: -1, reason: parsedWhole.reason } };
      return { seq: parsedWhole.record.seq, prevLine: wholeLast };
    }
    const parsed = parseLine(lastLine);
    if ("reason" in parsed) return { damage: { line: -1, reason: parsed.reason } };
    return { seq: parsed.record.seq, prevLine: lastLine };
  } finally {
    await handle.close();
  }
}

export interface AppendOptions {
  id?: string;
  at?: string;
  imported?: { path: string; line: number };
}

/** Append one record under the file lock. Refuses LEDGER_DAMAGED when the tail is torn or invalid. */
export async function appendRecord<B>(
  path: string,
  kind: RecordKind,
  body: B,
  options: AppendOptions = {},
): Promise<RecordEnvelope<B>> {
  await mkdir(dirname(path), { recursive: true });
  return withFileLock(path, "ledger", async () => {
    const last = await tail(path);
    if ("damage" in last) {
      const where = last.damage.line === -1 ? "its last line" : `line ${last.damage.line}`;
      const preFormat = PRE_FORMAT_REASONS.has(last.damage.reason);
      throw new GovernanceRefusal(
        refusal(
          LEDGER_DAMAGED,
          preFormat
            ? `ledger ${path} predates the record format (${last.damage.reason}); do NOT repair it — run ` +
                `\`pi-daddy ledger import ${path} <target>\` or point PI_DADDY_LEDGER at the imported project ledger`
            : `ledger ${path} is damaged at ${where} (${last.damage.reason}); run ` +
                `\`pi-daddy ledger repair ${path}\` to preview the torn tail, then retry with --yes`,
          { path, reason: last.damage.reason, preFormat },
        ),
      );
    }
    const draft: Omit<RecordEnvelope<B>, "digest"> = {
      v: RECORD_FORMAT,
      seq: last.seq + 1,
      prev: last.prevLine === null ? null : sha256(last.prevLine),
      at: options.at ?? new Date().toISOString(),
      kind,
      id: options.id ?? randomUUID(),
      body,
      ...(options.imported ? { imported: options.imported } : {}),
    };
    // Digest the serialised round-trip, not the in-memory value: a body with `toJSON` (a Date, a class) would
    // otherwise be written as one thing and digested as another, and the line would read back as damage.
    const plain = JSON.parse(JSON.stringify(draft)) as Omit<RecordEnvelope<B>, "digest">;
    const record: RecordEnvelope<B> = { ...plain, digest: recordDigest(plain) };
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    return record;
  });
}

export interface RepairResult {
  /** The raw lines that were (or would be) dropped, in file order. */
  dropped: string[];
  /** Where the intact prefix ends, 1-based line count. */
  keptLines: number;
  /** How many dropped lines still parse as JSON objects: a tampered middle, not a torn tail. */
  droppedParseable: number;
  /** True when the file is not a record file at all (a pre-format ledger); nothing is ever truncated then. */
  preFormat: boolean;
  /** True when there was no file. */
  missing: boolean;
}

/**
 * Drop everything from the first damaged line on. `apply: false` previews. The repair never rewrites an
 * intact record and never invents one; it only truncates, and only after the caller decided to.
 */
export async function repairLedger(path: string, options: { apply: boolean }): Promise<RepairResult> {
  return withFileLock(path, "ledger repair", async () => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { dropped: [], keptLines: 0, droppedParseable: 0, preFormat: false, missing: true };
      throw error;
    }
    const read = readRecords(text);
    if (read.damage === null)
      return { dropped: [], keptLines: read.records.length, droppedParseable: 0, preFormat: false, missing: false };
    const lines = text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    const dropped = lines.slice(read.damage.line - 1);
    const droppedParseable = dropped.filter((line) => {
      try {
        const v: unknown = JSON.parse(line);
        return !!v && typeof v === "object" && !Array.isArray(v);
      } catch {
        return false;
      }
    }).length;
    // A file whose FIRST line is not a record is a pre-format ledger. Repairing it would delete it whole; the
    // only right action is to import it, so `apply` is refused here regardless of what the caller asked.
    const preFormat = read.records.length === 0 && PRE_FORMAT_REASONS.has(read.damage.reason);
    if (options.apply && !preFormat) {
      const keep = lines.slice(0, read.damage.line - 1);
      const bytes = Buffer.byteLength(keep.length > 0 ? `${keep.join("\n")}\n` : "", "utf8");
      await truncate(path, bytes);
    }
    return { dropped, keptLines: read.damage.line - 1, droppedParseable, preFormat, missing: false };
  });
}
