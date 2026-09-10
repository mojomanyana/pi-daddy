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

test("N=2/N=3 actual fixed workers retain distinct immutable outputs and one experiment", async () => {
  for (const n of [2, 3]) {
    const f = await fixture(n), profile = await prepareDigestProfile(f.budget), controller = openExperiment(f.binding, f.authority);
    f.bytes.fill(0); const run = await controller.start(profile), view = await run.completion;
    assert.equal((await run.primary).state, "completed"); assert.equal(view.variants.length, n);
    assert.deepEqual(view.variants.map(v => v.state), Array(n).fill("completed"));
    const hashes = [];
    for (let i = 0; i < n; i++) { const r = JSON.parse(await readFile(resultPath(f, i), "utf8")); assert.equal(r.digest, byteHash("common" + i)); assert.equal(r.output.code, 0); hashes.push(r.digest); }
    const returned = await controller.readArtifact("execution:0"); returned.fill(0);
    assert.deepEqual(Buffer.from(await controller.readArtifact("execution:0")), await readFile(resultPath(f, 0)));
    await assert.rejects(controller.readArtifact("not-in-charter"), /unavailable/);
    assert.equal(new Set(hashes).size, n); assert.equal(view.budget!.attempts, n); assert.equal(view.budget!.active, 0);
    assert.equal(view.acceptance, "not-assessed"); assert.equal(view.configuration.model, null);
    const before = await readFile(join(f.binding.directory, "experiment.jsonl"));
    const again = await openExperiment(f.binding, f.authority).start(profile); assert.deepEqual((await again.completion).variants, view.variants);
    assert.deepEqual(await readFile(join(f.binding.directory, "experiment.jsonl")), before); assert.equal((await controller.start(profile)).completion, run.completion);
    if (n === 2) {
      const module = new URL("../src/experiment.ts", import.meta.url).href, profiles = new URL("../src/effect-profile.ts", import.meta.url).href;
      const code = `import{openExperiment}from ${JSON.stringify(module)};import{prepareDigestProfile}from ${JSON.stringify(profiles)};const b=${JSON.stringify(f.binding)},a=${JSON.stringify(f.authority)};const run=await openExperiment(b,a).start(await prepareDigestProfile(b.budget));console.log(JSON.stringify(await run.completion));`;
      const restarted = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { env: process.env, timeout: 15000 });
      assert.deepEqual(JSON.parse(restarted.stdout).variants, view.variants);
      assert.deepEqual(await readFile(join(f.binding.directory, "experiment.jsonl")), before);
      assert.equal((await openResourceBudget(f.budget).inspect()).attempts, 2);
    }
  }
});

test("real bounded stalled shadow does not delay primary; exact owned cancellation observes settlement", async () => {
  const f = await fixture(2, true), profile = await prepareDigestProfile(f.budget);
  const request: ExperimentCancellation = { version: "experiment-cancel-v1", requestId: "cancel:shadow", bindingDigest: experimentBindingDigest(f.binding), executionId: "execution:1" };
  const authority = { ...f.authority, cancellationDigests: [experimentCancellationDigest(request)] }, c = openExperiment(f.binding, authority);
  const run = await c.start(profile); assert.deepEqual(await Promise.all(run.started), ["spawned", "spawned"]);
  const primary = await run.primary; assert.equal(primary.state, "completed");
  assert.equal((await c.inspect()).variants[1].state, "running");
  const primaryBytes = await readFile(resultPath(f, 0));
  await assert.rejects(openExperiment(f.binding, f.authority).cancel(request), /authority/);
  await c.cancel(request); const view = await run.completion;
  assert.equal(view.variants[1].state, "cancelled"); assert.equal(view.cancellations[0].outcome, "observed-cancelled");
  const raw = JSON.parse(await readFile(resultPath(f, 1), "utf8")); assert.equal(raw.output.aborted, true); assert.ok(raw.output.signal);
  assert.deepEqual(await readFile(resultPath(f, 0)), primaryBytes); assert.equal(view.budget!.active, 0); assert.equal(view.budget!.attempts, 2);
  const before = await readFile(join(f.binding.directory, "experiment.jsonl")); await c.cancel(request); assert.deepEqual(await readFile(join(f.binding.directory, "experiment.jsonl")), before);
});

test("unknown old owned work stays unknown on reopen and is never relaunched or refunded", async () => {
  const f = await fixture(2, true), profile = await prepareDigestProfile(f.budget), c = openExperiment(f.binding, f.authority), run = await c.start(profile);
  await Promise.all(run.started); await run.primary;
  const reopened = openExperiment(f.binding, f.authority), old = await reopened.start(profile);
  assert.equal((await old.completion).variants[1].state, "unknown"); assert.equal((await reopened.reconcile()).budget!.active, 1);
  const completed = await run.completion; assert.equal(completed.variants[1].state, "timed-out");
  assert.equal((await reopened.reconcile()).variants[1].state, "timed-out"); assert.equal(completed.budget!.attempts, 2);
});

test("larger N uses existing cap in complete bounded waves, not enlarged fan-out", async () => {
  const f = await fixture(MAX_CHILDREN_PER_CALL + 1), run = await openExperiment(f.binding, f.authority).start(await prepareDigestProfile(f.budget));
  const view = await run.completion; assert.ok(view.variants.every(v => v.state === "completed"));
  const events = (await readFile(join(f.binding.directory, "experiment.jsonl"), "utf8")).trim().split("\n").slice(1).map(x => JSON.parse(x).event);
  const secondWave = events.findIndex(e => e.type === "dispatch" && e.executionId === `execution:${MAX_CHILDREN_PER_CALL}`);
  for (let i = 0; i < MAX_CHILDREN_PER_CALL; i++) assert.ok(events.findIndex(e => e.type === "result" && e.executionId === `execution:${i}`) < secondWave);
  assert.equal(view.budget!.attempts, MAX_CHILDREN_PER_CALL + 1);
});

test("whole-experiment deadline cancels owned workers without waiting for a judge", async () => {
  const f = await fixture(2, true, 1000), run = await openExperiment(f.binding, f.authority).start(await prepareDigestProfile(f.budget));
  const view = await run.completion; assert.equal(view.variants[1].state, "timed-out"); assert.equal(view.budget!.active, 0);
});

test("pre-reserved retries wait for their parent and successful parents do not trigger extra effects", async () => {
  for (const retryParent of [0, 1]) {
    const f = await fixture(3, true), charter: ExperimentCharter = { ...f.charter, variants: f.charter.variants.map((v, i) => i === 2 ? { ...v, kind: "retry", parentExecutionId: `execution:${retryParent}` } : v) };
    const authority = { ...f.authority, charterDigests: [experimentCharterDigest(charter)] };
    const b = await createExperiment({ directory: join(f.root, "retry-experiment"), budget: f.budget, charter, authority, bytes: Buffer.from("common") });
    const run = await openExperiment(b, authority).start(await prepareDigestProfile(f.budget)), view = await run.completion;
    assert.equal(view.variants[2].state, retryParent ? "completed" : "cancelled"); assert.equal(view.variants[2].spawned, Boolean(retryParent));
    assert.equal(view.budget!.attempts, 3); assert.equal(view.budget!.active, 0);
  }
});

test("cross-process batch contenders retain unknown orphan slots without exceeding total limits", async () => {
  const root = await tempDir("p11-process-race-"); await chmod(root, 0o700);
  const b = await createExperimentBudget({ directory: join(root, "budget"), authorityDigest, limits: { maxAttempts: 3, maxInputBytes: 100, maxConcurrent: 3 } });
  const module = new URL("../src/resource-budget.ts", import.meta.url).href;
  const results = await Promise.all([0, 1].map(n => promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import{openResourceBudget}from ${JSON.stringify(module)};const b=${JSON.stringify(b)};try{await openResourceBudget(b).reserveBatch([0,1].map(i=>({attemptId:'p${n}:'+i,orderId:'order',experimentId:'e${n}',kind:i?'shadow':'primary',parentAttemptId:i?'p${n}:0':null,inputBytes:7,inputDigest:'a'.repeat(64)})));console.log('charged')}catch(e){if(e.code!=='EXHAUSTED')throw e;console.log('exhausted')}`], { env: process.env, timeout: 10000 })));
  assert.deepEqual(results.map(r => r.stdout.trim()).sort(), ["charged", "exhausted"]);
  const snapshot = await openResourceBudget(b).inspect(); assert.equal(snapshot.attempts, 2); assert.equal(snapshot.active, 2);
});

test("simultaneous atomic batch admission cannot race the aggregate budget", async () => {
  const f = await fixture(), root = await tempDir("p11-race-"); await chmod(root, 0o700);
  const budget = await createExperimentBudget({ directory: join(root, "budget"), authorityDigest, limits: { maxAttempts: 3, maxInputBytes: 100, maxConcurrent: 3 } });
  const profile = await prepareDigestProfile(budget);
  const controllers = await Promise.all([0, 1].map(async n => {
    const charter: ExperimentCharter = { ...f.charter, experimentId: `experiment:${n}`, budgetDigest: resourceBindingDigest(budget), variants: f.charter.variants.map((v, i) => ({ ...v, executionId: `race:${n}:${i}`, parentExecutionId: i ? `race:${n}:0` : null })) };
    const authority = { ...f.authority, charterDigests: [experimentCharterDigest(charter)] };
    return openExperiment(await createExperiment({ directory: join(root, `experiment-${n}`), budget, charter, authority, bytes: Buffer.from("common") }), authority);
  }));
  const starts = await Promise.allSettled(controllers.map(c => c.start(profile)));
  assert.equal(starts.filter(x => x.status === "fulfilled").length, 1);
  for (const result of starts) if (result.status === "fulfilled") await result.value.completion;
  const state = await openResourceBudget(budget).inspect(); assert.equal(state.attempts, 2); assert.equal(state.inputBytes, 14); assert.equal(state.active, 0);
});

test("common-byte and actual pinned P01 input drift refuse before effects; unknown configuration is refused", async () => {
  const f = await fixture(), profile = await prepareDigestProfile(f.budget);
  await chmod(join(f.binding.directory, "common.bin"), 0o600); await writeFile(join(f.binding.directory, "common.bin"), "drift!");
  await assert.rejects(openExperiment(f.binding, f.authority).start(profile), /drift/); assert.equal((await openResourceBudget(f.budget).inspect()).attempts, 0);
  const w = intentWorld(), path = join(f.root, "work.jsonl"); await writeFile(path, w.text, { mode: 0o600 });
  const work = await bindWorkIntent({ path, grantLedgerPath: null, selection: w.selection(w.base), priorities: w.priorities(w.obligations) });
  const charter: ExperimentCharter = { ...f.charter, common: { ...f.charter.common, work, workTextDigest: byteHash(w.text) } };
  const authority = { ...f.authority, charterDigests: [experimentCharterDigest(charter)] };
  const binding = await createExperiment({ directory: join(f.root, "work-experiment"), budget: f.budget, charter, authority, bytes: Buffer.from("common") });
  await appendFile(path, w.text); await assert.rejects(openExperiment(binding, authority).start(profile), /P01 work drift/);
  const bad = JSON.parse(JSON.stringify(f.charter)); bad.variants[0].configuration.model = "unknown-model";
  await assert.rejects(createExperiment({ directory: join(f.root, "refused"), budget: f.budget, charter: bad, authority: f.authority, bytes: Buffer.from("common") }), /configuration/);
  await assert.rejects(openExperiment(f.binding, null).start(profile), /authority/);
});

test("complete batch append with failed sync acknowledgement charges all, launches none and never retries", async () => {
  const f = await fixture(), profile = await prepareDigestProfile(f.budget), handle = await open(join(f.root, "owned-handle"), "wx");
  const proto = Object.getPrototypeOf(handle), original = proto.sync; let injected = false;
  proto.sync = async function () { await original.call(this); const s = await this.stat({ bigint: true }); if (!injected && String(s.ino) === f.budget.journalInode) { injected = true; throw new Error("owned complete append acknowledgement failure"); } };
  try { await assert.rejects(openExperiment(f.binding, f.authority).start(profile), /acknowledgement/); }
  finally { proto.sync = original; await handle.close(); }
  assert.equal(injected, true); const state = await openResourceBudget(f.budget).inspect(); assert.equal(state.attempts, 2); assert.equal(state.active, 2);
  const c = openExperiment(f.binding, f.authority); await c.start(profile); assert.equal((await c.inspect()).variants[0].state, "unknown");
  for (const v of f.charter.variants) assert.deepEqual(await readdir(join(f.binding.directory, "variant-" + byteHash(v.executionId))), []);
});

test("read-only reconciliation verifies real artifact bytes and refuses torn controller history", async () => {
  const f = await fixture(), c = openExperiment(f.binding, f.authority), run = await c.start(await prepareDigestProfile(f.budget)); await run.completion;
  const path = join(f.binding.directory, "experiment.jsonl"), before = await readFile(path), budget = await readFile(join(f.budget.directory, "budget.jsonl"));
  await c.inspect(); await c.reconcile(); assert.deepEqual(await readFile(path), before); assert.deepEqual(await readFile(join(f.budget.directory, "budget.jsonl")), budget);
  await chmod(resultPath(f, 1), 0o600); await writeFile(resultPath(f, 1), "wrong"); assert.equal((await c.inspect()).variants[1].state, "unknown");
  await appendFile(path, "{"); await assert.rejects(c.reconcile(), /torn/); assert.equal((await readFile(path)).at(-1), 123);
});
