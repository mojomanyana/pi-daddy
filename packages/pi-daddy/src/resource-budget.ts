import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withFileLock } from "./file-lock.ts";
import { parseWorkJson } from "./work-ledger-json.ts";
import { runWithFinalizers } from "./finalization.ts";

export interface ResourceLimits { maxAttempts: number; maxInputBytes: number; maxConcurrent: number }
export interface BudgetBinding {
  version: "1.0"; directory: string; device: string; inode: string;
  journalDevice: string; journalInode: string; authorityDigest: string; limits: ResourceLimits;
}
export interface AttemptDemand {
  attemptId: string; orderId: string; experimentId: string;
  kind: "primary" | "retry" | "shadow" | "descendant";
  parentAttemptId: string | null; inputBytes: number; inputDigest: string;
}
interface Reservation extends AttemptDemand { owner: string; state: "reserved" | "settled"; outcome: string | null }
export interface BudgetSnapshot { attempts: number; inputBytes: number; active: number; reservations: readonly Readonly<Reservation>[] }
export interface ResourcePermit { readonly attemptId: string; settle(outcome: "completed" | "failed" | "cancelled"): Promise<void> }
export class ResourceAdmissionError extends Error {
  readonly code: "INVALID" | "AUTHORITY_CHANGED" | "DUPLICATE" | "EXHAUSTED" | "OWNERSHIP_LOST";
  constructor(code: ResourceAdmissionError["code"], message: string) {
    super(message); this.name = "ResourceAdmissionError"; this.code = code;
  }
}
function fail(code: ResourceAdmissionError["code"], text: string): never { throw new ResourceAdmissionError(code, text); }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const digest = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const id = (x: unknown): x is string => typeof x === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(x);
const integer = (x: unknown, max: number): x is number => Number.isSafeInteger(x) && Number(x) >= 0 && Number(x) <= max;
function shape(x: unknown, keys: string[]): asserts x is Record<string, unknown> {
  if (!x || typeof x !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(x)) ||
    Reflect.ownKeys(x).length !== keys.length || keys.some(k => { const d = Object.getOwnPropertyDescriptor(x, k); return !d || !d.enumerable || !Object.hasOwn(d, "value"); })) fail("INVALID", "closed data object required");
}
function limits(x: ResourceLimits): ResourceLimits {
  shape(x, ["maxAttempts", "maxInputBytes", "maxConcurrent"]);
  if (!integer(x.maxAttempts, 1024) || x.maxAttempts < 1 || !integer(x.maxInputBytes, 16 * 1024 * 1024) ||
    !integer(x.maxConcurrent, 32) || x.maxConcurrent < 1 || x.maxConcurrent > x.maxAttempts) fail("INVALID", "unsupported resource limits");
  return Object.freeze({ maxAttempts: x.maxAttempts, maxInputBytes: x.maxInputBytes, maxConcurrent: x.maxConcurrent });
}
function binding(x: BudgetBinding): Readonly<BudgetBinding> {
  shape(x, ["version", "directory", "device", "inode", "journalDevice", "journalInode", "authorityDigest", "limits"]);
  if (x.version !== "1.0" || typeof x.directory !== "string" || !isAbsolute(x.directory) || resolve(x.directory) !== x.directory ||
    x.directory.length > 1024 || x.directory.split("/").includes(".pi") || ![x.device, x.inode, x.journalDevice, x.journalInode].every(v => typeof v === "string" && /^\d+$/.test(v)) || !digest(x.authorityDigest)) fail("INVALID", "invalid independent budget binding");
  return Object.freeze({ version: "1.0", directory: x.directory, device: x.device, inode: x.inode, journalDevice: x.journalDevice, journalInode: x.journalInode, authorityDigest: x.authorityDigest, limits: limits(x.limits) });
}
function demand(x: AttemptDemand): AttemptDemand {
  shape(x, ["attemptId", "orderId", "experimentId", "kind", "parentAttemptId", "inputBytes", "inputDigest"]);
  if (![x.attemptId, x.orderId, x.experimentId].every(id) || !["primary", "retry", "shadow", "descendant"].includes(x.kind) ||
    !(x.parentAttemptId === null || id(x.parentAttemptId)) || (x.kind !== "primary" && x.parentAttemptId === null) ||
    !integer(x.inputBytes, 16384) || !digest(x.inputDigest)) fail("INVALID", "invalid attempt demand");
  return { attemptId: x.attemptId, orderId: x.orderId, experimentId: x.experimentId, kind: x.kind,
    parentAttemptId: x.parentAttemptId, inputBytes: x.inputBytes, inputDigest: x.inputDigest };
}
async function privateDirectory(path: string) {
  const st = await lstat(path, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077n) !== 0n || st.uid !== BigInt(process.getuid!()) || await realpath(path) !== path) fail("INVALID", "a canonical owner-private directory is required");
  return st;
}

/** Explicit one-time creation, never implicit reset/recovery. Keep this binding outside the mutable journal. */
export async function createResourceBudget(input: { directory: string; authorityDigest: string; limits: ResourceLimits }): Promise<Readonly<BudgetBinding>> {
  shape(input, ["directory", "authorityDigest", "limits"]);
  const policy = limits(input.limits), directoryPath = input.directory, authorityDigest = input.authorityDigest;
  if (typeof directoryPath !== "string" || !isAbsolute(directoryPath) || resolve(directoryPath) !== directoryPath ||
    directoryPath.split("/").includes(".pi") || !digest(authorityDigest)) fail("INVALID", "invalid budget creation");
  await privateDirectory(dirname(directoryPath));
  await mkdir(directoryPath, { mode: 0o700 }); // EEXIST refuses even if its journal was deleted.
  const st = await privateDirectory(directoryPath);
  const file = await open(join(directoryPath, "budget.jsonl"), "wx", 0o600);
  const b = await runWithFinalizers(async () => {
    const journal = await file.stat({ bigint: true });
    const result = binding({ version: "1.0", directory: directoryPath, device: String(st.dev), inode: String(st.ino),
      journalDevice: String(journal.dev), journalInode: String(journal.ino), authorityDigest, limits: policy });
    await file.writeFile(JSON.stringify(result) + "\n"); await file.sync(); return result;
  }, [{ label: "budget creation close failed", run: () => file.close() }]);
  const directory = await open(b.directory, constants.O_RDONLY | constants.O_DIRECTORY);
  await runWithFinalizers(() => directory.sync(), [{ label: "budget directory close failed", run: () => directory.close() }]);
  return b;
}

/** Host-side arithmetic for this exact independently retained binding. Not a money/CPU/memory cap. */
export function openResourceBudget(input: BudgetBinding) {
  const b = binding(input), path = join(b.directory, "budget.jsonl"), owner = randomUUID();
  let pinnedFile: string | undefined;
  async function transaction<T>(work: (records: Reservation[], append: (event: unknown) => Promise<void>) => Promise<T>): Promise<T> {
    const checkRoot = async () => {
      const st = await privateDirectory(b.directory);
      if (String(st.dev) !== b.device || String(st.ino) !== b.inode) fail("AUTHORITY_CHANGED", "budget root identity changed");
    };
    await checkRoot();
    return withFileLock(path, "resource budget", async () => {
      await checkRoot();
      const file = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      return runWithFinalizers(async () => {
        const st = await file.stat({ bigint: true }), key = `${st.dev}:${st.ino}`;
        if (!st.isFile() || st.nlink !== 1n || st.uid !== BigInt(process.getuid!()) || (st.mode & 0o077n) !== 0n || st.size > 2n * 1024n * 1024n) fail("INVALID", "unsafe or oversized budget journal");
        if (key !== `${b.journalDevice}:${b.journalInode}` || (pinnedFile && pinnedFile !== key)) fail("AUTHORITY_CHANGED", "budget journal replaced");
        pinnedFile = key;
        const buffer = Buffer.alloc(Number(st.size));
        let offset = 0;
        while (offset < buffer.length) { const n = (await file.read(buffer, offset, buffer.length - offset, offset)).bytesRead; if (!n) fail("INVALID", "short budget read"); offset += n; }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        if (!text.endsWith("\n")) fail("INVALID", "incomplete budget journal; no automatic recovery");
        const lines = text.slice(0, -1).split("\n");
        if (lines.length > 2049 || JSON.stringify(binding(parseWorkJson(lines[0]) as unknown as BudgetBinding)) !== JSON.stringify(b)) fail("AUTHORITY_CHANGED", "budget header does not match independent authority");
        const records: Reservation[] = [];
        for (const line of lines.slice(1)) {
          const event = parseWorkJson(line) as Record<string, unknown>;
          if (event.type === "reserve") {
            shape(event, ["type", "owner", "demand"]);
            const d = demand(event.demand as AttemptDemand);
            if (!id(event.owner) || records.some(r => r.attemptId === d.attemptId) || (d.parentAttemptId !== null && !records.some(r => r.attemptId === d.parentAttemptId))) fail("INVALID", "invalid reservation sequence");
            records.push({ ...d, owner: event.owner, state: "reserved", outcome: null });
          } else {
            shape(event, ["type", "owner", "attemptId", "outcome"]);
            const r = records.find(r => r.attemptId === event.attemptId);
            if (event.type !== "settle" || !r || r.state !== "reserved" || event.owner !== r.owner || !["completed", "failed", "cancelled"].includes(String(event.outcome))) fail("INVALID", "invalid settlement sequence");
            r.state = "settled"; r.outcome = String(event.outcome);
          }
          if (records.length > b.limits.maxAttempts || records.reduce((n, r) => n + r.inputBytes, 0) > b.limits.maxInputBytes || records.filter(r => r.state === "reserved").length > b.limits.maxConcurrent) fail("INVALID", "journal exceeds independently fixed limits");
        }
        let expectedSize = st.size;
        const unchanged = async () => {
          await checkRoot(); const current = await lstat(path, { bigint: true });
          if (`${current.dev}:${current.ino}` !== key || current.size !== expectedSize || (await file.stat({ bigint: true })).size !== expectedSize ||
            current.nlink !== 1n || (current.mode & 0o077n) !== 0n) fail("AUTHORITY_CHANGED", "budget journal changed under lock");
        };
        await unchanged();
        return await work(records, async event => {
          const line = JSON.stringify(event) + "\n";
          if (buffer.length + Buffer.byteLength(line) > 2 * 1024 * 1024) fail("EXHAUSTED", "journal capacity reached");
          await unchanged(); await file.writeFile(line); expectedSize += BigInt(Buffer.byteLength(line)); await file.sync(); await unchanged();
        });
      }, [{ label: "budget journal close failed", run: () => file.close() }]);
    }, { staleRecovery: "disabled" });
  }
  return Object.freeze({
    binding: b,
    async inspect(): Promise<Readonly<BudgetSnapshot>> {
      return transaction(async records => Object.freeze({ attempts: records.length, inputBytes: records.reduce((n, r) => n + r.inputBytes, 0),
        active: records.filter(r => r.state === "reserved").length, reservations: Object.freeze(records.map(r => Object.freeze({ ...r }))) }));
    },
    async reserve(input: AttemptDemand): Promise<Readonly<ResourcePermit>> {
      const d = demand(input);
      await transaction(async (records, append) => {
        if (records.some(r => r.attemptId === d.attemptId)) fail("DUPLICATE", "attempt identity already charged; never launch a redelivery");
        if (d.parentAttemptId !== null && !records.some(r => r.attemptId === d.parentAttemptId)) fail("INVALID", "parent attempt is not in this budget");
        if (records.length >= b.limits.maxAttempts || records.reduce((n, r) => n + r.inputBytes, 0) + d.inputBytes > b.limits.maxInputBytes ||
          records.filter(r => r.state === "reserved").length >= b.limits.maxConcurrent) fail("EXHAUSTED", "aggregate allowance exhausted");
        await append({ type: "reserve", owner, demand: d });
      });
      return Object.freeze({ attemptId: d.attemptId, async settle(outcome: "completed" | "failed" | "cancelled") {
        if (!["completed", "failed", "cancelled"].includes(outcome)) fail("INVALID", "invalid outcome");
        await transaction(async (records, append) => {
          const r = records.find(r => r.attemptId === d.attemptId);
          if (!r || r.owner !== owner) fail("OWNERSHIP_LOST", "only the reserving live host may settle this attempt");
          if (r.state === "settled") { if (r.outcome !== outcome) fail("INVALID", "contradictory late settlement"); return; }
          await append({ type: "settle", owner, attemptId: d.attemptId, outcome });
        });
      } });
    },
  });
}

export function resourceBindingDigest(b: BudgetBinding): string { return hash(JSON.stringify(binding(b))); }
