import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, chmod, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
import { createExperimentBudget, openResourceBudget, resourceBindingDigest } from "../src/resource-budget.ts";
import { DIGEST_PROFILE, prepareDigestProfile } from "../src/effect-profile.ts";
import { createExperiment, openExperiment, experimentBindingDigest, experimentCharterDigest, experimentCancellationDigest, type ExperimentCharter, type ExperimentCancellation } from "../src/experiment.ts";
import { byteHash } from "../src/experiment-contract.ts";
import { readExperimentFile } from "../src/experiment-store.ts";
import { MAX_CHILDREN_PER_CALL } from "../src/fanout.ts";
import { bindWorkIntent } from "../src/intent-application.ts";
import { intentWorld } from "./intent-control-fixture.ts";
const authorityDigest = "a".repeat(64);
async function fixture(n = 2, hold = false, deadlineMs = 15000) {
  const root = await tempDir("p11-experiment-"), bytes = Buffer.from("common"); await chmod(root, 0o700);
  const budget = await createExperimentBudget({ directory: join(root, "budget"), authorityDigest, limits: { maxAttempts: 32, maxInputBytes: 65536, maxConcurrent: 32 } });
  const charter: ExperimentCharter = { version: "fixed-experiment-v1", experimentId: "experiment:fixture", orderId: "order:fixture", budgetDigest: resourceBindingDigest(budget), profile: DIGEST_PROFILE,
    common: { sha256: byteHash(bytes), bytes: bytes.length, work: null, workTextDigest: null }, mode: n === 2 ? "concurrent-shadow" : "bounded-waves", deadlineMs,
    variants: Array.from({ length: n }, (_, i) => ({ variantId: `variant:${i}`, executionId: `execution:${i}`, kind: i ? "shadow" : "primary", parentExecutionId: i ? "execution:0" : null,
      suffixBase64: Buffer.from(String(i)).toString("base64"), operation: hold && i === 1 ? "hold" : "digest", configuration: { model: null, effort: null, skills: null } })) };
  const authority = { authorityDigest, charterDigests: [experimentCharterDigest(charter)], cancellationDigests: [] as string[] };
  const binding = await createExperiment({ directory: join(root, "experiment"), budget, charter, bytes, authority });
  return { root, bytes, budget, charter, authority, binding };
}
const resultPath = (f: Awaited<ReturnType<typeof fixture>>, i: number) => join(f.binding.directory, "variant-" + byteHash(`execution:${i}`), "result.json");

test("append-only journal reads retain the exact prefix snapshot while strict artifact reads still reject growth", async () => {
  const root = await tempDir("experiment-read-race-");
  const originalOpen = fsPromises.open;
  const exercise = async (name: string, appendOnly: boolean) => {
    const path = join(root, name); await writeFile(path, "before\n"); await chmod(path, 0o600); let injected = false;
    fsPromises.open = (async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === path) {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await read(...readArgs);
          if (!injected) { injected = true; await appendFile(path, "after\n"); }
          return result;
        }) as typeof handle.read;
      }
      return handle;
    }) as typeof fsPromises.open;
    syncBuiltinESMExports();
    try {
      if (appendOnly) assert.equal((await readExperimentFile(path, 1024, { appendOnly: true })).toString(), "before\n");
      else await assert.rejects(readExperimentFile(path, 1024), /experiment source changed/);
    } finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
    assert.equal(injected, true);
  };
  await exercise("journal", true);
  await exercise("artifact", false);
});


import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

test("cancel readback waits for real settlement under the existing control locks", async () => {
  const f = await fixture(2, true), profile = await prepareDigestProfile(f.budget);
  const request: ExperimentCancellation = { version: "experiment-cancel-v1", requestId: "cancel:locked", bindingDigest: experimentBindingDigest(f.binding), executionId: "execution:1" };
  const c = openExperiment(f.binding, { ...f.authority, cancellationDigests: [experimentCancellationDigest(request)] });
  const run = await c.start(profile); await Promise.all(run.started); assert.equal((await run.primary).state, "completed");
  assert.equal((await c.inspect()).variants[1].spawned, true);
  const path = join(f.budget.directory, "budget.jsonl"), storeLock = join(f.binding.directory, "experiment.jsonl.lock");
  const sample = await open(path, "r"), proto = Object.getPrototypeOf(sample); await sample.close();
  const original = { open: fsPromises.open, writeFile: proto.writeFile, sync: proto.sync };
  let held!: () => void, release!: () => void, waited!: () => void, acquired = 0;
  const holding = new Promise<void>(resolve => { held = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { waited = resolve; });
  const owners = new WeakSet<object>(), settlements = new WeakSet<object>();
  let timer: ReturnType<typeof setTimeout>;
  const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("control readback did not wait for original settlement")), 5000); });
  fsPromises.open = (async (...args: any[]) => {
    if (String(args[0]) === storeLock && acquired > 0) await holding;
    if (String(args[0]) === path + ".lock" && settlementsSeen) { waited(); release(); }
    const file = await Reflect.apply(original.open, fsPromises, args);
    if (String(args[0]) === storeLock) acquired++;
    if (String(args[0]) === path) owners.add(file);
    return file;
  }) as typeof fsPromises.open;
  let settlementsSeen = false;
  proto.writeFile = async function(data: unknown, ...args: any[]) {
    const result = await Reflect.apply(original.writeFile, this, [data, ...args]);
    if (owners.has(this) && String(data).includes('"type":"settle"') && String(data).includes('"attemptId":"execution:1"')) settlements.add(this);
    return result;
  };
  proto.sync = async function(...args: any[]) {
    if (settlements.has(this)) { settlementsSeen = true; held(); await proceed; }
    return Reflect.apply(original.sync, this, args);
  };
  syncBuiltinESMExports();
  let cancellation: Promise<unknown> | undefined;
  try {
    cancellation = c.cancel(request); void cancellation.catch(() => {});
    await Promise.race([waiting, bound]);
    await cancellation;
    assert.ok(acquired >= 2, "request and coherent control readback both own the experiment lock");
  } finally {
    clearTimeout(timer!); release(); held(); fsPromises.open = original.open; proto.writeFile = original.writeFile; proto.sync = original.sync; syncBuiltinESMExports();
    await cancellation?.catch(() => {}); await run.completion;
  }
  const done = await run.completion; assert.equal(done.variants[1].state, "cancelled"); assert.equal(done.budget!.active, 0);
  const before = await readFile(join(f.binding.directory, "experiment.jsonl")); await c.cancel(request); assert.deepEqual(await readFile(join(f.binding.directory, "experiment.jsonl")), before);
});
