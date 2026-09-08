import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, writeFile, readdir, rename, open } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
import { createDispatchBudget, createResourceBudget, openResourceBudget, resourceBindingDigest, type GovernedBudgetBinding } from "../src/resource-budget.ts";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import { dispatchRequestDigest, parseDispatchRequest, type DispatchRequest } from "../src/dispatch-control.ts";
import { prepareDigestProfile, runDigestProfile } from "../src/effect-profile.ts";
const authorityDigest = "a".repeat(64);
async function fixture() {
  const root = await tempDir("dispatch-controls-"); await chmod(root, 0o700);
  return createDispatchBudget({ directory: join(root, "budget"), authorityDigest, limits: { maxAttempts: 8, maxInputBytes: 128, maxConcurrent: 2 } });
}
const request = (b: GovernedBudgetBinding, requestId = "pause", expectedRevision = 0, action: DispatchRequest["action"] = "pause-dispatch"): DispatchRequest => ({
  version: "1.0", requestId, bindingDigest: resourceBindingDigest(b), expectedRevision, action, targetExecutionId: action === "cancel-execution" ? "attempt" : null,
});
// Independently reconstruct fixed test-world host decisions. Never authorize the received wire object.
const grant = (b: GovernedBudgetBinding) => ({ authorityDigest, requestDigests: [request(b), request(b, "resume", 1, "resume-dispatch"),
  request(b, "stale", 0, "resume-dispatch"), request(b, "second", 1, "resume-dispatch"),
  ...["cancel-execution", "revise-scope", "reprioritize", "select-alternative"].map((a, i) => request(b, `unsupported-${i}`, 0, a as DispatchRequest["action"]))].map(dispatchRequestDigest) });
const demand = (attemptId: string) => ({ attemptId, orderId: "order", experimentId: "experiment", kind: "primary" as const, parentAttemptId: null, inputBytes: 1, inputDigest: "b".repeat(64) });

test("strict versioned wire contract rejects duplicate members, lossy integer tokens and authority metadata", async () => {
  const b = await fixture(), r = request(b);
  const schema = JSON.parse(await readFile(new URL(import.meta.resolve("pi-daddy/contracts/dispatch-control/v1/request.schema.json")), "utf8"));
  const check = Compile(schema as TSchema);
  assert.ok(check.Check(r)); assert.deepEqual(parseDispatchRequest(JSON.stringify(r)), r);
  for (const bad of [{ ...r, version: "2.0" }, { ...r, authority: authorityDigest }, { ...r, targetExecutionId: "pane" }, { ...r, expectedRevision: 0.1 }]) {
    assert.equal(check.Check(bad), false); assert.throws(() => parseDispatchRequest(JSON.stringify(bad)));
  }
  assert.throws(() => parseDispatchRequest(JSON.stringify(r).replace('"expectedRevision":0', '"expectedRevision":1.000000000000000000001')));
  assert.throws(() => parseDispatchRequest(JSON.stringify(r).replace('"version":"1.0"', '"version":"1.0","version":"1.0"')));
});

test("exact host-authorized pause/resume changes the actual reservation gate, not work acceptance", async () => {
  const b = await fixture(), budget = openResourceBudget(b), pause = request(b), resume = request(b, "resume", 1, "resume-dispatch");
  const controls = budget.controls(grant(b));
  const state = await controls.request(pause);
  assert.equal(state.revision, 1); assert.equal(state.paused, true); assert.equal(state.records[0].outcome, "paused");
  await assert.rejects(budget.reserve(demand("blocked")), { code: "DISPATCH_BLOCKED" });
  const bytes = await readFile(join(b.directory, "budget.jsonl"));
  assert.deepEqual(await controls.request(pause), state); assert.deepEqual(await readFile(join(b.directory, "budget.jsonl")), bytes);
  assert.equal((await controls.request(resume)).paused, false);
  const permit = await budget.reserve(demand("allowed")); await permit.settle("completed");
  assert.equal((await budget.inspect()).attempts, 1); assert.ok(Object.isFrozen(state.records[0].request));
});

test("busy steering stays pending until original permits settle; restart/receipt/idle claims cannot manufacture a boundary", async () => {
  const b = await fixture(), budget = openResourceBudget(b), permit = await budget.reserve(demand("busy"));
  const pause = request(b), control = budget.controls(grant(b));
  const pending = await control.request(pause);
  assert.equal(pending.records[0].application, "pending"); assert.equal(pending.admission, "blocked-pending");
  assert.equal((await control.request(request(b, "second", 1, "resume-dispatch"))).records[1].decision, "busy");
  await assert.rejects(budget.reserve(demand("barrier")), { code: "DISPATCH_BLOCKED" });
  const restart = openResourceBudget(JSON.parse(JSON.stringify(b))).controls(grant(b));
  assert.equal((await restart.reconcile(pause.requestId)).records[0].application, "pending");
  assert.equal((await restart.request(pause)).paused, false, "redelivery never applies pending work");
  await permit.settle("completed");
  assert.equal((await openResourceBudget(b).controls(null).reconcile(pause.requestId)).records[0].application, "pending", "reconciliation needs independent authority again");
  assert.equal((await restart.reconcile("another-id")).records[0].application, "pending");
  const applied = await restart.reconcile(pause.requestId); assert.equal(applied.paused, true);
  const bytes = await readFile(join(b.directory, "budget.jsonl"));
  assert.deepEqual(await restart.reconcile(pause.requestId), applied); assert.deepEqual(await readFile(join(b.directory, "budget.jsonl")), bytes);
});

test("stale selections, conflicting IDs and unknown authority refuse without replacing newer decisions", async () => {
  const b = await fixture(), pause = request(b), stale = request(b, "stale", 0, "resume-dispatch");
  const c = openResourceBudget(b).controls(grant(b)); await c.request(pause);
  assert.equal((await c.request(stale)).records[1].decision, "stale");
  await assert.rejects(c.request({ ...pause, action: "resume-dispatch" }), { code: "DUPLICATE" });
  const unknown = request(b, "unknown", 1, "resume-dispatch");
  const denied = await c.request(unknown); // Matching host digest alone cannot approve an unlisted request.
  assert.equal((await openResourceBudget(b).controls(null).request(request(b, "no-authority", 1))).records[3].decision, "authority-unavailable");
  assert.equal(denied.records[2].decision, "authority-unavailable"); assert.equal(denied.paused, true); assert.equal(denied.revision, 1);
  await assert.rejects(c.request({ ...pause, authorityDigest } as DispatchRequest), /closed/);
  await assert.rejects(c.request({ ...pause, bindingDigest: "c".repeat(64) }), { code: "AUTHORITY_CHANGED" });
});

test("cancellation is a distinct refused route, never ordinary pending steering or terminal typing", async () => {
  const b = await fixture(), requests = ["cancel-execution", "revise-scope", "reprioritize", "select-alternative"].map((a, i) => request(b, `unsupported-${i}`, 0, a as DispatchRequest["action"]));
  const c = openResourceBudget(b).controls(grant(b));
  for (const r of requests) { const state = await c.request(r); assert.equal(state.records.at(-1)?.decision, "unsupported"); assert.equal(state.records.at(-1)?.application, "not-applied"); assert.equal(state.revision, 0); }
});

test("status reads have no journal, lock, directory or session/control side effects", async () => {
  const b = await fixture(), c = openResourceBudget(b).controls(null);
  const session = join(b.directory, "session.jsonl"); await writeFile(session, '{"message":"owned fixture"}\n');
  const names = await readdir(b.directory), before = await Promise.all(names.map(n => readFile(join(b.directory, n))));
  for (let i = 0; i < 4; i++) { await c.inspect(); await openResourceBudget(b).inspect(); }
  assert.deepEqual(await readdir(b.directory), names); assert.deepEqual(await Promise.all(names.map(n => readFile(join(b.directory, n)))), before);
});

test("real cross-process redelivery persists one request and one application", async () => {
  const b = await fixture(), r = request(b), module = new URL("../src/resource-budget.ts", import.meta.url).href;
  const code = `const {openResourceBudget}=await import(${JSON.stringify(module)});await openResourceBudget(JSON.parse(process.argv[1])).controls(JSON.parse(process.argv[2])).request(JSON.parse(process.argv[3]));`;
  await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(b), JSON.stringify(grant(b)), JSON.stringify(r)], { env: { PATH: "", HOME: b.directory, TMPDIR: b.directory }, timeout: 10000 })));
  const lines = (await readFile(join(b.directory, "budget.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 3); assert.equal((await openResourceBudget(b).controls(null).inspect()).revision, 1);
});

test("missing/partial/replaced mandatory journal fails closed; no receipt-shaped repair", async () => {
  const b = await fixture(), c = openResourceBudget(b).controls(grant(b));
  const file = join(b.directory, "budget.jsonl"), bytes = await readFile(file);
  await writeFile(file, bytes.subarray(0, bytes.length - 1));
  await assert.rejects(c.request(request(b)), /incomplete/);
  await writeFile(file, bytes); await rename(file, file + ".owned-history"); await writeFile(file, bytes, { mode: 0o600 });
  await assert.rejects(c.request(request(b)), { code: "AUTHORITY_CHANGED" });
  await assert.rejects(openResourceBudget(b).reserve(demand("denied")), { code: "AUTHORITY_CHANGED" });
});

test("failed mandatory request sync gives no application acknowledgement; only explicit reconciliation can finish", async t => {
  const b = await fixture(), r = request(b), c = openResourceBudget(b).controls(grant(b));
  const handle = await open(join(b.directory, "budget.jsonl"), "r"), prototype = Object.getPrototypeOf(handle); await handle.close();
  const sync = t.mock.method(prototype, "sync", async () => { throw new Error("owned mandatory sync failure"); });
  await assert.rejects(c.request(r), /owned mandatory sync failure/); sync.mock.restore();
  const state = await c.inspect(); assert.equal(state.records[0].application, "pending"); assert.equal(state.paused, false);
  const before = await readFile(join(b.directory, "budget.jsonl"));
  assert.equal((await c.request(r)).records[0].application, "pending"); assert.deepEqual(await readFile(join(b.directory, "budget.jsonl")), before);
  assert.equal((await c.reconcile(r.requestId)).records[0].application, "applied");
});

test("independent authority is detached; v1 journals cannot silently opt into control semantics", async () => {
  const b = await fixture(), r = request(b), a = grant(b), c = openResourceBudget(b).controls(a);
  a.authorityDigest = "d".repeat(64); a.requestDigests.length = 0;
  assert.equal((await c.request(r)).paused, true);
  const root = await tempDir("dispatch-legacy-"); await chmod(root, 0o700);
  const old = await createResourceBudget({ directory: join(root, "budget"), authorityDigest, limits: b.limits });
  const compatibleVersion: "1.0" = old.version;
  const compatibleOpenedVersion: "1.0" = openResourceBudget(old).binding.version;
  assert.equal(compatibleVersion, compatibleOpenedVersion); assert.throws(() => openResourceBudget(old).controls(null), /v2/);
});

test("actual probed fixed-digest execution obeys the same durable future-dispatch gate", async () => {
  const b = await fixture(), profile = await prepareDigestProfile(b), pause = request(b), resume = request(b, "resume", 1, "resume-dispatch");
  const c = openResourceBudget(b).controls(grant(b)); await c.request(pause);
  const attempt = { attemptId: "fixed", orderId: "order", experimentId: "experiment", kind: "primary" as const, parentAttemptId: null };
  await assert.rejects(runDigestProfile(profile, { attempt, bytes: Buffer.from("x") }), { code: "DISPATCH_BLOCKED" });
  assert.equal((await openResourceBudget(b).inspect()).attempts, 0);
  await c.request(resume); const result = await runDigestProfile(profile, { attempt, bytes: Buffer.from("x") });
  assert.equal(result.output.code, 0); assert.ok(result.digest); assert.equal((await openResourceBudget(b).inspect()).active, 0);
});
