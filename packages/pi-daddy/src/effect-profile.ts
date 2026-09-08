import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runChild, type ChildRunResult } from "./run-child.ts";
import { runWithFinalizers } from "./finalization.ts";
import { beginExecutionRetention, retentionConfigurationDigest } from "./execution-retention.ts";
import { openResourceBudget, resourceBindingDigest, type AttemptDemand, type ResourcePermit, type GovernedBudgetBinding } from "./resource-budget.ts";
import { intentKey, type IntentAdmission } from "./intent-control.ts";
import { DIGEST_PROFILE, DIGEST_WORKER, digestNamespaceArgs, digestRuntime, type DigestRuntime } from "./effect-profile-runtime.ts";
export { DIGEST_PROFILE } from "./effect-profile-runtime.ts";

export interface DigestProfile { readonly profile: typeof DIGEST_PROFILE; readonly bindingDigest: string; readonly runtimeDigest: string }
export class EffectProfileUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "EffectProfileUnavailableError"; }
}
const profiles = new WeakMap<DigestProfile, { runtime: DigestRuntime; budget: ReturnType<typeof openResourceBudget> }>();
export const isDigestProfile = (value: unknown): value is DigestProfile => typeof value === "object" && value !== null && profiles.has(value as DigestProfile);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function requireClean(result: ChildRunResult): void {
  if (result.code !== 0 || result.spawnError || result.aborted || result.timedOut || result.truncated) throw new EffectProfileUnavailableError(`fixed native profile failed: ${result.spawnError ?? result.text ?? result.code}`);
}
const child = (runtime: DigestRuntime, code: string, args: string[], fixture?: string, signal?: AbortSignal) => runChild({
  command: "/usr/bin/bwrap", args: digestNamespaceArgs(runtime, code, args, fixture), cwd: "/", env: {},
  timeoutMs: 3000, killGraceMs: 50, hardDeadlineAt: Date.now() + 3500, maxOutputBytes: 4096, signal,
});

/** Actual bounded native probes, not an executable-presence flag. Trusted fixture code only. */
export async function prepareDigestProfile(binding: GovernedBudgetBinding): Promise<Readonly<DigestProfile>> {
  const budget = openResourceBudget(binding);
  await budget.inspect(); // Required admission state failures remain failures, not an unavailable fallback.
  const runtime = await digestRuntime();
  const root = await mkdtemp(join(budget.binding.directory, "profile-probe-")), input = join(root, "input");
  await mkdir(input, { mode: 0o700 }); await writeFile(join(input, "allowed"), "owned-readable", { mode: 0o600 });
  await writeFile(join(root, "outside"), "owned-outside", { mode: 0o600 });
  const net = await readlink("/proc/self/ns/net");
  const code = `const fs=require('node:fs');let failures=0;for(const fn of [()=>fs.readFileSync(${JSON.stringify(join(root, "outside"))}),()=>fs.writeFileSync('/input/denied','bad')]){try{fn()}catch(e){if(['ENOENT','EROFS'].includes(e.code))failures++}}if(failures!==2||fs.readFileSync('/input/allowed','utf8')!=='owned-readable'||fs.readlinkSync('/proc/self/ns/net')===${JSON.stringify(net)})process.exit(91);console.log('boundary-ok');`;
  const boundary = await child(runtime, code, [], input); requireClean(boundary);
  if (boundary.text.trim() !== "boundary-ok") throw new EffectProfileUnavailableError("native boundary probe did not establish its expected observations");
  const permission = await child(runtime, `try{require('node:child_process').spawnSync('/runtime/node',['-e','process.exit(92)']);process.exit(93)}catch(e){if(e.code!=='ERR_ACCESS_DENIED')process.exit(94);console.log('descendant-denied')}`, []);
  requireClean(permission);
  if (permission.text.trim() !== "descendant-denied") throw new EffectProfileUnavailableError("descendant tripwire unavailable");
  const sample = await child(runtime, DIGEST_WORKER, [Buffer.from("fixture").toString("base64")]); requireClean(sample);
  if (sample.text !== JSON.stringify({ bytes: 7, sha256: hash("fixture") }) + "\n") throw new EffectProfileUnavailableError("fixed worker probe mismatch");
  const result = Object.freeze({ profile: DIGEST_PROFILE, bindingDigest: resourceBindingDigest(budget.binding), runtimeDigest: retentionConfigurationDigest(runtime) });
  profiles.set(result, { runtime, budget });
  return result;
}

export interface DigestAttempt { attempt: Omit<AttemptDemand, "inputBytes" | "inputDigest">; bytes: Uint8Array; intent?: IntentAdmission }
/** A fixed, useful non-shell operation: hash at most 16 KiB. No writable destinations or provider calls.
 * The opaque profile is bound to one budget. A claimed profile name/receipt cannot authorize a launch. */
export async function runDigestProfile(profile: DigestProfile, request: DigestAttempt, signal?: AbortSignal): Promise<Readonly<{
  attemptId: string; output: ChildRunResult; digest: string | null;
}>> {
  const prepared = profiles.get(profile);
  if (!prepared || profile.profile !== DIGEST_PROFILE) throw new EffectProfileUnavailableError("unsupported or unprobed effect profile; no launch");
  const requestKeys = ["attempt", "bytes", ...(request && Object.hasOwn(request, "intent") ? ["intent"] : [])];
  if (!request || typeof request !== "object" || Reflect.ownKeys(request).length !== requestKeys.length ||
    !requestKeys.every(k => { const d = Object.getOwnPropertyDescriptor(request, k); return d && d.enumerable && Object.hasOwn(d, "value"); }) ||
    !(request.bytes instanceof Uint8Array) || request.bytes.byteLength > 16384) throw new TypeError("bounded byte-only request required; no destination, code, money or workspace override");
  const bytes = Buffer.from(request.bytes), inputDigest = hash(bytes);
  const selectedIntent: IntentAdmission | undefined = Object.hasOwn(request, "intent") ? JSON.parse(intentKey(request.intent)) : undefined;
  const descriptors = Object.getOwnPropertyDescriptors(request.attempt);
  const keys = ["attemptId", "orderId", "experimentId", "kind", "parentAttemptId"];
  if (Reflect.ownKeys(request.attempt).length !== keys.length || keys.some(k => !descriptors[k]?.enumerable || !Object.hasOwn(descriptors[k], "value"))) throw new TypeError("closed attempt identity required");
  const attempt = Object.fromEntries(keys.map(k => [k, descriptors[k].value])) as DigestAttempt["attempt"];
  if (signal?.aborted) throw new EffectProfileUnavailableError("cancelled before reservation/launch");
  if (retentionConfigurationDigest(await digestRuntime()) !== profile.runtimeDigest) throw new EffectProfileUnavailableError("runtime changed since the native profile probe");
  const permit = await prepared.budget.reserve({ ...attempt, inputBytes: bytes.length, inputDigest }, selectedIntent);
  return executeReserved(profile, prepared.runtime, attempt, bytes, permit, "digest", signal);
}

export type FixedDigestOperation = "digest" | "hold";
export interface ReservedDigestRun { readonly started: Promise<"spawned" | "settled-without-spawn">; run(signal?: AbortSignal): ReturnType<typeof runDigestProfile> }
/** Atomic all-attempt admission; only minted closures hold the original permits. No caller-supplied permit. */
export async function reserveDigestProfileBatch(profile: DigestProfile, requests: readonly { attempt: DigestAttempt["attempt"]; bytes: Uint8Array; operation: FixedDigestOperation }[]): Promise<readonly ReservedDigestRun[]> {
  const prepared = profiles.get(profile);
  if (!prepared || !Array.isArray(requests) || !requests.length || requests.length > 32 || Reflect.ownKeys(requests).length !== requests.length + 1 || Array.from({ length: requests.length }, (_, i) => Object.getOwnPropertyDescriptor(requests, String(i))).some(d => !d?.enumerable || !Object.hasOwn(d, "value"))) throw new EffectProfileUnavailableError("probed profile and bounded batch required");
  const detached = requests.map(r => {
    const descriptors = r && Object.getOwnPropertyDescriptors(r);
    if (!descriptors || Reflect.ownKeys(r).length !== 3 || ["attempt", "bytes", "operation"].some(k => !descriptors[k]?.enumerable || !Object.hasOwn(descriptors[k], "value"))) throw new TypeError("closed data variant required");
    if (!r || !["digest", "hold"].includes(r.operation) || !(r.bytes instanceof Uint8Array) || r.bytes.length > 16384 || Object.keys(r).sort().join() !== "attempt,bytes,operation") throw new TypeError("fixed byte-only variant required");
    return { attempt: JSON.parse(intentKey(r.attempt)) as DigestAttempt["attempt"], bytes: Buffer.from(r.bytes), operation: r.operation };
  });
  if (retentionConfigurationDigest(await digestRuntime()) !== profile.runtimeDigest) throw new EffectProfileUnavailableError("runtime changed before batch");
  const permits = await prepared.budget.reserveBatch(detached.map(r => ({ ...r.attempt, inputBytes: r.bytes.length, inputDigest: hash(r.bytes) })));
  return Object.freeze(detached.map((r, i) => {
    let used = false, resolveStarted!: (value: "spawned" | "settled-without-spawn") => void;
    const started = { promise: new Promise<"spawned" | "settled-without-spawn">(resolve => { resolveStarted = resolve; }), resolve: (value: "spawned" | "settled-without-spawn") => resolveStarted(value) };
    return Object.freeze({ started: started.promise, async run(signal?: AbortSignal) {
      if (used) throw new Error("reserved execution already consumed; no replay"); used = true;
      try { return await executeReserved(profile, prepared.runtime, r.attempt, r.bytes, permits[i], r.operation, signal, () => started.resolve("spawned")); }
      finally { started.resolve("settled-without-spawn"); } // Settled-without-spawn also unblocks waiters; never a spawn/identity claim.
    } });
  }));
}

async function executeReserved(profile: DigestProfile, runtime: DigestRuntime, attempt: DigestAttempt["attempt"], bytes: Buffer, permit: ResourcePermit, operation: FixedDigestOperation, signal?: AbortSignal, started?: () => void) {
  const inputDigest = hash(bytes), code = operation === "digest" ? DIGEST_WORKER : "setInterval(()=>{},1000);";
  // From this point every outcome costs the full reservation. No posthoc result refunds resources.
  const retention = beginExecutionRetention({ executionId: attempt.attemptId, parentExecutionId: attempt.parentAttemptId,
    childId: "digest", toolCallId: null, executor: "process", taskDigest: inputDigest, definitionDigest: hash(code),
    configurationDigest: retentionConfigurationDigest({ profile: profile.profile, binding: profile.bindingDigest, runtime: profile.runtimeDigest }), workspaceId: null });
  let output: ChildRunResult | undefined;
  let outcome: "completed" | "failed" | "cancelled" = "failed";
  let accountingFailed = false, spawned = false, exitObserved = false;
  return runWithFinalizers(async () => {
    if (!signal?.aborted && retentionConfigurationDigest(await digestRuntime()) !== profile.runtimeDigest) throw new EffectProfileUnavailableError("runtime changed after admission");
    output = await runChild({ command: "/usr/bin/bwrap", args: digestNamespaceArgs(runtime, code, [bytes.toString("base64")]),
      cwd: "/", env: {}, signal, timeoutMs: 3000, killGraceMs: 50, hardDeadlineAt: Date.now() + 3500, maxOutputBytes: 4096,
      onSpawn: pid => { spawned = true; retention.native({ pid }); started?.(); }, onObservation: (stream, data) => retention.capture(stream, data) });
    exitObserved = output.code !== null || Boolean(output.signal);
    if (spawned && !exitObserved) throw new Error("owned executor exit unknown; reservation retained");
    const completed = output.code === 0 && !output.aborted && !output.spawnError && !output.timedOut && !output.truncated;
    if (completed && output.text !== JSON.stringify({ bytes: bytes.length, sha256: inputDigest }) + "\n") throw new Error("fixed worker result mismatch");
    outcome = output.aborted && (!spawned || Boolean(output.signal)) ? "cancelled" : completed ? "completed" : "failed";
    retention.capture("result", Buffer.from(output.text), true);
    return Object.freeze({ attemptId: attempt.attemptId, output, digest: completed ? inputDigest : null });
  }, [{ label: "required resource settlement failed", run: async () => {
    // Only this live controller, after executor settlement, releases a slot. Cleanup failure still rejects.
    // Crashes/lost controllers keep their slots; reopening has no expiry, receipt-credit or reclaim API.
    try { if (spawned && !exitObserved) throw new Error("owned executor exit unknown; no settlement credit"); await permit.settle(outcome); } catch (error) { accountingFailed = true; throw error; }
  } }, { label: "retention observation failed", run: () => {
    retention.finish({ code: output?.code ?? null, signal: output?.signal ?? null, timedOut: output?.timedOut ?? false,
      aborted: output?.aborted ?? Boolean(signal?.aborted), truncated: output?.truncated ?? false, failed: outcome !== "completed" || accountingFailed });
  } }]);
}
