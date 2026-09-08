import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withFileLock } from "./file-lock.ts";
import { parseWorkJson, freezeWork } from "./work-ledger-json.ts";
import { runWithFinalizers } from "./finalization.ts";
import { workIntentBinding, readIntentWork, resolveIntent, validateIntentApplication, applyIntentApplication } from "./intent-application.ts";
import { intentKey, intentRequest, intentRequestDigest, intentReceipt, matchesIntentReceipt, intentDecision, replayIntent, intentSnapshot,
  type WorkIntentBinding, type IntentState, type IntentRequest, type IntentAdmission } from "./intent-control.ts";
import { intentAdmission, nextIntent } from "./intent-scheduling.ts";
import { dispatchAuthority, dispatchRequest, dispatchRequestDigest, dispatchDecision, replayDispatch, freezeDispatch,
  type DispatchAuthority, type DispatchRequest, type DispatchState } from "./dispatch-control.ts";

export interface ResourceLimits { maxAttempts: number; maxInputBytes: number; maxConcurrent: number }
export interface BudgetBinding<V extends "1.0" | "2.0" | "3.0" | "4.0" = "1.0"> {
  version: V; directory: string; device: string; inode: string;
  journalDevice: string; journalInode: string; authorityDigest: string; limits: ResourceLimits; intent?: V extends "3.0" ? WorkIntentBinding : never;
}
export type DispatchBudgetBinding = BudgetBinding<"2.0">;
export type ExperimentBudgetBinding = BudgetBinding<"4.0">;
export type GovernedBudgetBinding = BudgetBinding<"1.0" | "2.0" | "3.0" | "4.0">;
export type IntentBudgetBinding = BudgetBinding<"3.0"> & { intent: WorkIntentBinding };
export interface AttemptDemand {
  attemptId: string; orderId: string; experimentId: string;
  kind: "primary" | "retry" | "shadow" | "descendant";
  parentAttemptId: string | null; inputBytes: number; inputDigest: string;
}
interface Reservation extends AttemptDemand { intent?: IntentAdmission; owner: string; state: "reserved" | "settled"; outcome: string | null }
export interface BudgetSnapshot { attempts: number; inputBytes: number; active: number; reservations: readonly Readonly<Reservation>[] }
export interface ResourcePermit { readonly attemptId: string; settle(outcome: "completed" | "failed" | "cancelled"): Promise<void> }
export class ResourceAdmissionError extends Error {
  readonly code: "INVALID" | "AUTHORITY_CHANGED" | "DUPLICATE" | "EXHAUSTED" | "OWNERSHIP_LOST" | "DISPATCH_BLOCKED";
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
function binding<T extends GovernedBudgetBinding>(x: T): Readonly<T> {
  shape(x, ["version", "directory", "device", "inode", "journalDevice", "journalInode", "authorityDigest", "limits", ...(Object.getOwnPropertyDescriptor(x ?? {}, "version")?.value === "3.0" ? ["intent"] : [])]);
  if (!["1.0", "2.0", "3.0", "4.0"].includes(x.version) || typeof x.directory !== "string" || !isAbsolute(x.directory) || resolve(x.directory) !== x.directory ||
    x.directory.length > 1024 || x.directory.split("/").includes(".pi") || ![x.device, x.inode, x.journalDevice, x.journalInode].every(v => typeof v === "string" && /^\d+$/.test(v)) || !digest(x.authorityDigest)) fail("INVALID", "invalid independent budget binding");
  return Object.freeze({ version: x.version, directory: x.directory, device: x.device, inode: x.inode, journalDevice: x.journalDevice, journalInode: x.journalInode, authorityDigest: x.authorityDigest, limits: limits(x.limits), ...(x.version === "3.0" ? { intent: freezeWork(workIntentBinding(x.intent!)) } : {}) }) as Readonly<T>;
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
type BudgetCreation = { directory: string; authorityDigest: string; limits: ResourceLimits };
export function createResourceBudget(input: BudgetCreation): Promise<Readonly<BudgetBinding>> { return createBudget(input, "1.0"); }
/** Explicit opt-in v2 journal; old readers refuse rather than ignore control events. */
export function createDispatchBudget(input: BudgetCreation): Promise<Readonly<DispatchBudgetBinding>> { return createBudget(input, "2.0"); }
export async function createIntentBudget(input: BudgetCreation, intent: Parameters<typeof readIntentWork>[0]): Promise<Readonly<IntentBudgetBinding>> {
  return createBudget(input, "3.0", JSON.parse(intentKey(intent)));
}
/** Explicit batch semantics. All queued slots remain conservatively active until original settlement. */
export function createExperimentBudget(input: BudgetCreation): Promise<Readonly<ExperimentBudgetBinding>> { return createBudget(input, "4.0"); }
function createBudget(input: BudgetCreation, version: "4.0"): Promise<Readonly<ExperimentBudgetBinding>>;
function createBudget(input: BudgetCreation, version: "1.0"): Promise<Readonly<BudgetBinding>>;
function createBudget(input: BudgetCreation, version: "2.0"): Promise<Readonly<DispatchBudgetBinding>>;
function createBudget(input: BudgetCreation, version: "3.0", intent: WorkIntentBinding): Promise<Readonly<IntentBudgetBinding>>;
async function createBudget(input: BudgetCreation, version: GovernedBudgetBinding["version"], intent?: WorkIntentBinding): Promise<Readonly<GovernedBudgetBinding>> {
  const initialIntent = version === "3.0" ? workIntentBinding(intent!) : undefined;
  shape(input, ["directory", "authorityDigest", "limits"]);
  const policy = limits(input.limits), directoryPath = input.directory, authorityDigest = input.authorityDigest;
  if (typeof directoryPath !== "string" || !isAbsolute(directoryPath) || resolve(directoryPath) !== directoryPath ||
    directoryPath.split("/").includes(".pi") || !digest(authorityDigest)) fail("INVALID", "invalid budget creation");
  if (initialIntent) resolveIntent(await readIntentWork(initialIntent), initialIntent.selection, initialIntent.priorities);
  await privateDirectory(dirname(directoryPath));
  await mkdir(directoryPath, { mode: 0o700 }); // EEXIST refuses even if its journal was deleted.
  const st = await privateDirectory(directoryPath);
  const file = await open(join(directoryPath, "budget.jsonl"), "wx", 0o600);
  const b = await runWithFinalizers(async () => {
    const journal = await file.stat({ bigint: true });
    const result = binding({ version, directory: directoryPath, device: String(st.dev), inode: String(st.ino),
      journalDevice: String(journal.dev), journalInode: String(journal.ino), authorityDigest, limits: policy, ...(initialIntent ? { intent: initialIntent } : {}) });
    await file.writeFile(JSON.stringify(result) + "\n"); await file.sync(); return result;
  }, [{ label: "budget creation close failed", run: () => file.close() }]);
  const directory = await open(b.directory, constants.O_RDONLY | constants.O_DIRECTORY);
  await runWithFinalizers(() => directory.sync(), [{ label: "budget directory close failed", run: () => directory.close() }]);
  return b;
}

/** Host-side arithmetic for this exact independently retained binding. Not a money/CPU/memory cap. */
export function openResourceBudget<T extends GovernedBudgetBinding>(input: T) {
  const b = binding(input), path = join(b.directory, "budget.jsonl"), owner = randomUUID();
  let pinnedFile: string | undefined;
  async function transaction<T>(work: (records: Reservation[], append: (event: unknown) => Promise<void>, control: DispatchState, intent: IntentState | null) => Promise<T>, readOnly = false): Promise<T> {
    const checkRoot = async () => {
      const st = await privateDirectory(b.directory);
      if (String(st.dev) !== b.device || String(st.ino) !== b.inode) fail("AUTHORITY_CHANGED", "budget root identity changed");
    };
    await checkRoot();
    const execute = async () => {
      await checkRoot();
      const file = await open(path, (readOnly ? constants.O_RDONLY : constants.O_RDWR | constants.O_APPEND) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
        if (lines.length > (b.version === "3.0" ? 2369 : b.version !== "1.0" ? 2305 : 2049) || JSON.stringify(binding(parseWorkJson(lines[0]) as unknown as GovernedBudgetBinding)) !== JSON.stringify(b)) fail("AUTHORITY_CHANGED", "budget header does not match independent authority");
        const records: Reservation[] = [], control: DispatchState = { revision: 0, paused: false, records: [] };
        const intent: IntentState | null = b.intent ? { revision: 0, selection: b.intent.selection, priorities: b.intent.priorities, records: [] } : null;
        for (const line of lines.slice(1)) {
          const event = parseWorkJson(line) as Record<string, unknown>;
          if (event.type === "intent-request" || event.type === "intent-apply") {
            if (!intent) fail("INVALID", "intent controls require explicit v3 binding");
            replayIntent(intent, event, records.filter(r => r.state === "reserved").length, control.records.some(r => r.application === "pending"));
          } else if (event.type === "control-request" || event.type === "control-apply") {
            if (b.version === "1.0") fail("INVALID", "controls require explicit v2/v3 binding");
            replayDispatch(control, event, resourceBindingDigest(b), records.filter(r => r.state === "reserved").length, Boolean(intent?.records.some(r => r.application === "pending-or-unknown")));
          } else if (event.type === "reserve-batch") {
            if (b.version !== "4.0") fail("INVALID", "batch requires explicit v4 budget");
            shape(event, ["type", "owner", "demands"]);
            if (!id(event.owner) || !Array.isArray(event.demands) || !event.demands.length || event.demands.length > 32 || control.paused || control.records.some(r => r.application === "pending")) fail("INVALID", "invalid batch");
            for (const value of event.demands) {
              const d = demand(value as AttemptDemand);
              if (records.some(r => r.attemptId === d.attemptId) || d.parentAttemptId !== null && !records.some(r => r.attemptId === d.parentAttemptId)) fail("INVALID", "invalid batch sequence");
              records.push({ ...d, owner: event.owner, state: "reserved", outcome: null });
            }
          } else if (event.type === "reserve") {
            if (control.paused || control.records.some(r => r.application === "pending") || intent?.records.some(r => r.application === "pending-or-unknown")) fail("INVALID", "reservation crossed dispatch barrier");
            shape(event, ["type", "owner", "demand", ...(intent ? ["intent"] : [])]);
            const d = demand(event.demand as AttemptDemand);
            if (!id(event.owner) || records.some(r => r.attemptId === d.attemptId) || (d.parentAttemptId !== null && !records.some(r => r.attemptId === d.parentAttemptId))) fail("INVALID", "invalid reservation sequence");
            if (intent && (d.kind !== "primary" || d.parentAttemptId !== null)) fail("INVALID", "v3 schedules primary dispatch only");
            const assigned = intent ? intentAdmission(intent, records, event.intent as IntentAdmission) : undefined;
            records.push({ ...d, ...(assigned ? { intent: assigned } : {}), owner: event.owner, state: "reserved", outcome: null });
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
          if (readOnly) fail("INVALID", "inspection cannot write");
          const line = JSON.stringify(event) + "\n";
          if (expectedSize + BigInt(Buffer.byteLength(line)) > 2n * 1024n * 1024n) fail("EXHAUSTED", "journal capacity reached");
          await unchanged(); await file.writeFile(line); expectedSize += BigInt(Buffer.byteLength(line)); await file.sync(); await unchanged();
        }, control, intent);
      }, [{ label: "budget journal close failed", run: () => file.close() }]);
    };
    return readOnly ? execute() : withFileLock(path, "resource budget", execute, { staleRecovery: "disabled" });
  }
  const permit = (attemptId: string): Readonly<ResourcePermit> => Object.freeze({ attemptId, async settle(outcome: "completed" | "failed" | "cancelled") {
    if (!["completed", "failed", "cancelled"].includes(outcome)) fail("INVALID", "invalid outcome");
    await transaction(async (records, append) => {
      const r = records.find(r => r.attemptId === attemptId);
      if (!r || r.owner !== owner) fail("OWNERSHIP_LOST", "only original live host may settle");
      if (r.state === "settled") { if (r.outcome !== outcome) fail("INVALID", "contradictory settlement"); return; }
      await append({ type: "settle", owner, attemptId, outcome });
    });
  } });
  return Object.freeze({
    binding: b,
    async reserveBatch(inputs: readonly AttemptDemand[]): Promise<readonly Readonly<ResourcePermit>[]> {
      if (b.version !== "4.0" || !Array.isArray(inputs) || !inputs.length || inputs.length > 32 || Reflect.ownKeys(inputs).length !== inputs.length + 1 || Array.from({ length: inputs.length }, (_, i) => Object.getOwnPropertyDescriptor(inputs, String(i))).some(d => !d?.enumerable || !Object.hasOwn(d, "value"))) fail("INVALID", "explicit v4 dense bounded batch required");
      const demands = Array.from(inputs, demand);
      await transaction(async (records, append, control) => {
        if (control.paused || control.records.some(r => r.application === "pending")) fail("DISPATCH_BLOCKED", "dispatch barrier");
        const ids = new Set(records.map(r => r.attemptId));
        for (const d of demands) {
          if (ids.has(d.attemptId)) fail("DUPLICATE", "batch identity already charged");
          if (d.parentAttemptId !== null && !ids.has(d.parentAttemptId)) fail("INVALID", "batch parent missing");
          ids.add(d.attemptId);
        }
        if (records.length + demands.length > b.limits.maxAttempts || records.reduce((n,r) => n+r.inputBytes,0) + demands.reduce((n,d) => n+d.inputBytes,0) > b.limits.maxInputBytes || records.filter(r => r.state === "reserved").length + demands.length > b.limits.maxConcurrent) fail("EXHAUSTED", "whole experiment exceeds aggregate allowance");
        await append({ type: "reserve-batch", owner, demands });
      });
      return Object.freeze(demands.map(d => permit(d.attemptId)));
    },
    intentControls(input: DispatchAuthority | null) {
      if (!b.intent) fail("INVALID", "intent controls require explicit v3 budget creation");
      const work = b.intent, authority = dispatchAuthority(input), scope = resourceBindingDigest(b);
      const authorized = (digest: string) => authority?.authorityDigest === b.authorityDigest && authority.requestDigests.includes(digest);
      const apply = async (request: ReturnType<typeof intentRequest>, records: Reservation[], append: (event: unknown) => Promise<void>, control: DispatchState, state: IntentState) => {
        const pending = state.records.find(r => r.requestId === request.requestId);
        if (!pending || pending.digest !== intentRequestDigest(request)) fail("DUPLICATE", "exact original intent request required");
        if (!matchesIntentReceipt(pending, request)) fail("INVALID", "intent receipt projection does not match original request");
        if (pending.application !== "pending-or-unknown" || !authorized(pending.digest) || records.some(r => r.state === "reserved") || control.records.some(r => r.application === "pending")) return;
        await applyIntentApplication(work, state, request);
        const event = { type: "intent-apply", requestId: request.requestId };
        await append(event); replayIntent(state, event, 0, false);
      };
      return Object.freeze({
        inspect: () => transaction(async (records, _append, control, state) => {
          resolveIntent(await readIntentWork(work), state!.selection, state!.priorities);
          const blocked = control.paused || control.records.some(r => r.application === "pending") || state!.records.some(r => r.application === "pending-or-unknown");
          return freezeWork({ ...intentSnapshot(state!, scope), dispatchPaused: control.paused, nextObligation: blocked ? null : nextIntent(state!, records) });
        }, true),
        async request(input: IntentRequest) {
          const request = intentRequest(input), digest = intentRequestDigest(request);
          if (request.bindingDigest !== scope) fail("AUTHORITY_CHANGED", "intent request is for another binding");
          return transaction(async (records, append, control, state) => {
            const prior = state!.records.find(r => r.requestId === request.requestId);
            if (prior) {
              if (prior.digest !== digest) fail("DUPLICATE", "immutable intent request identity");
              if (!matchesIntentReceipt(prior, request)) fail("INVALID", "intent receipt projection does not match original request");
              return intentSnapshot(state!, scope);
            }
            if (state!.records.length >= 32) fail("EXHAUSTED", "intent request capacity reached");
            const decision = intentDecision(state!, request, Boolean(authorized(digest)), control.records.some(r => r.application === "pending"));
            if (decision === "approved") await validateIntentApplication(work, state!, request);
            const event = { type: "intent-request", receipt: intentReceipt(request, decision) };
            await append(event); replayIntent(state!, event, records.filter(r => r.state === "reserved").length, control.records.some(r => r.application === "pending"));
            if (decision === "approved") await apply(request, records, append, control, state!);
            return intentSnapshot(state!, scope);
          });
        },
        async reconcile(input: IntentRequest) {
          const request = intentRequest(input);
          if (request.bindingDigest !== scope) fail("AUTHORITY_CHANGED", "intent request is for another binding");
          return transaction(async (records, append, control, state) => { await apply(request, records, append, control, state!); return intentSnapshot(state!, scope); });
        },
      });
    },
    controls(input: DispatchAuthority | null) {
      if (b.version === "1.0") fail("INVALID", "controls require explicit v2/v3 budget creation");
      const authority = dispatchAuthority(input), scope = resourceBindingDigest(b);
      const authorized = (digest: string) => authority?.authorityDigest === b.authorityDigest && authority.requestDigests.includes(digest);
      const apply = async (requestId: string, records: Reservation[], append: (event: unknown) => Promise<void>, control: DispatchState) => {
        const pending = control.records.find(r => r.request.requestId === requestId && r.application === "pending");
        if (!pending || !authorized(pending.digest) || records.some(r => r.state === "reserved")) return;
        const event = { type: "control-apply", requestId: pending.request.requestId };
        await append(event); replayDispatch(control, event, scope, 0);
      };
      return Object.freeze({
        inspect: () => transaction(async (_records, _append, control, intent) => freezeDispatch(control, scope, Boolean(intent?.records.some(r => r.application === "pending-or-unknown"))), true),
        async reconcile(requestId: string) {
          if (typeof requestId !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(requestId)) fail("INVALID", "exact request ID required for reconciliation");
          return transaction(async (records, append, control, intent) => { await apply(requestId, records, append, control); return freezeDispatch(control, scope, Boolean(intent?.records.some(r => r.application === "pending-or-unknown"))); });
        },
        async request(input: DispatchRequest) {
          const request = dispatchRequest(input), digest = dispatchRequestDigest(request);
          if (request.bindingDigest !== scope) fail("AUTHORITY_CHANGED", "request is for another binding");
          return transaction(async (records, append, control, intent) => {
            const previous = control.records.find(r => r.request.requestId === request.requestId);
            if (previous) {
              if (previous.digest !== digest) fail("DUPLICATE", "request ID cannot name another decision");
              // Redelivery is readback only, never a second effect or implicit reconciliation.
              return freezeDispatch(control, scope, Boolean(intent?.records.some(r => r.application === "pending-or-unknown")));
            }
            if (control.records.length >= 128) fail("EXHAUSTED", "control request capacity reached");
            const event = { type: "control-request", request, decision: dispatchDecision(control, request, Boolean(authorized(digest)), Boolean(intent?.records.some(r => r.application === "pending-or-unknown"))) };
            await append(event); replayDispatch(control, event, scope, records.filter(r => r.state === "reserved").length, Boolean(intent?.records.some(r => r.application === "pending-or-unknown")));
            if (event.decision === "approved") await apply(request.requestId, records, append, control);
            return freezeDispatch(control, scope, Boolean(intent?.records.some(r => r.application === "pending-or-unknown")));
          });
        },
      });
    },
    /** Explicit control-path synchronization; unlike inspect, this takes the existing journal lock. */
    async controlSnapshot(): Promise<Readonly<BudgetSnapshot>> {
      return transaction(async records => Object.freeze({ attempts: records.length, inputBytes: records.reduce((n,r)=>n+r.inputBytes,0), active: records.filter(r=>r.state==="reserved").length, reservations:Object.freeze(records.map(r=>freezeWork({...r}))) }));
    },
    async inspect(): Promise<Readonly<BudgetSnapshot>> {
      return transaction(async records => Object.freeze({ attempts: records.length, inputBytes: records.reduce((n, r) => n + r.inputBytes, 0),
        active: records.filter(r => r.state === "reserved").length, reservations: Object.freeze(records.map(r => freezeWork({ ...r }))) }), true);
    },
    async reserve(input: AttemptDemand, selection?: IntentAdmission): Promise<Readonly<ResourcePermit>> {
      const d = demand(input), selected: IntentAdmission | null = selection === undefined ? null : JSON.parse(intentKey(selection));
      if (Boolean(b.intent) !== Boolean(selected)) fail("INVALID", "v3 reservations require an exact scheduled intent; older bindings do not accept it");
      await transaction(async (records, append, control, intent) => {
        if (control.paused || control.records.some(r => r.application === "pending") || intent?.records.some(r => r.application === "pending-or-unknown")) fail("DISPATCH_BLOCKED", "dispatch paused or awaiting verified boundary");
        if (records.some(r => r.attemptId === d.attemptId)) fail("DUPLICATE", "attempt identity already charged; never launch a redelivery");
        if (d.parentAttemptId !== null && !records.some(r => r.attemptId === d.parentAttemptId)) fail("INVALID", "parent attempt is not in this budget");
        if (records.length >= b.limits.maxAttempts || records.reduce((n, r) => n + r.inputBytes, 0) + d.inputBytes > b.limits.maxInputBytes ||
          records.filter(r => r.state === "reserved").length >= b.limits.maxConcurrent) fail("EXHAUSTED", "aggregate allowance exhausted");
        if (intent) {
          if (d.kind !== "primary" || d.parentAttemptId !== null) fail("INVALID", "v3 schedules primary dispatch only");
          resolveIntent(await readIntentWork(b.intent!), intent.selection, intent.priorities);
          const assigned = intentAdmission(intent, records, selected!);
          await append({ type: "reserve", owner, demand: d, intent: assigned });
        } else await append({ type: "reserve", owner, demand: d });
      });
      return permit(d.attemptId);
    },
  });
}

export function resourceBindingDigest(b: GovernedBudgetBinding): string { return hash(JSON.stringify(binding(b))); }
