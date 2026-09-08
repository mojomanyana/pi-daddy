import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tempDir } from "./tmp.ts";
import { createResourceBudget, openResourceBudget, type AttemptDemand } from "../src/resource-budget.ts";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const request = (attemptId: string, more: Partial<AttemptDemand> = {}): AttemptDemand => ({ attemptId, orderId: "order-a", experimentId: "experiment-a", kind: "primary", parentAttemptId: null, inputBytes: 3, inputDigest: hash("abc"), ...more });
async function fixture(limits = { maxAttempts: 4, maxInputBytes: 12, maxConcurrent: 2 }) {
  const root = await tempDir("resource-budget-"); await chmod(root, 0o700);
  return createResourceBudget({ directory: join(root, "authority"), authorityDigest: hash("independent-policy"), limits });
}

test("creation detaches authority and destination before its first asynchronous boundary", async () => {
  const root = await tempDir("resource-create-"); await chmod(root, 0o700);
  const directory = join(root, "original"), authorityDigest = hash("original");
  const input = { directory, authorityDigest, limits: { maxAttempts: 4, maxInputBytes: 12, maxConcurrent: 2 } };
  const pending = createResourceBudget(input);
  input.directory = join(root, "redirected"); input.authorityDigest = hash("changed"); input.limits.maxAttempts = 8;
  const binding = await pending;
  assert.equal(binding.directory, directory); assert.equal(binding.authorityDigest, authorityDigest); assert.equal(binding.limits.maxAttempts, 4);
});

test("one exact authority reserves aggregate allowance across orders, experiments, retries and shadows", async () => {
  const binding = await fixture(), a = openResourceBudget(binding), b = openResourceBudget(binding);
  const first = await a.reserve(request("a"));
  const shadow = await b.reserve(request("b", { kind: "shadow", parentAttemptId: "a", orderId: "order-b", experimentId: "experiment-b" }));
  await assert.rejects(a.reserve(request("c")), { code: "EXHAUSTED" });
  await first.settle("cancelled");
  const retry = await b.reserve(request("c", { kind: "retry", parentAttemptId: "a" }));
  await shadow.settle("completed");
  const descendant = await a.reserve(request("d", { kind: "descendant", parentAttemptId: "c" }));
  await retry.settle("failed"); await descendant.settle("completed");
  await assert.rejects(a.reserve(request("e", { inputBytes: 0 })), { code: "EXHAUSTED" });
  const state = await b.inspect(); assert.equal(state.inputBytes, 12); assert.equal(state.attempts, 4); assert.equal(state.active, 0);
  assert.ok(Object.isFrozen(state.reservations[0])); assert.ok(Object.isFrozen(binding.limits));
});

test("restart retains outstanding reservations; duplicate and late receipts do not mint allowance", async () => {
  const binding = await fixture({ maxAttempts: 8, maxInputBytes: 12, maxConcurrent: 1 });
  const budget = openResourceBudget(binding), permit = await budget.reserve(request("lost"));
  const restarted = openResourceBudget(JSON.parse(JSON.stringify(binding)));
  await assert.rejects(restarted.reserve(request("retry")), { code: "EXHAUSTED" });
  await assert.rejects(restarted.reserve(request("lost")), { code: "DUPLICATE" });
  assert.equal("settle" in restarted, false, "receipt-shaped input is not a live permit");
  await permit.settle("cancelled"); const next = await restarted.reserve(request("next"));
  await permit.settle("cancelled"); assert.equal((await restarted.inspect()).active, 1);
  await assert.rejects(permit.settle("completed"), { code: "INVALID" });
  await next.settle("completed"); assert.equal((await restarted.inspect()).inputBytes, 6, "cancellation never refunds bytes");
});

test("real cross-process reservations serialize and exact redeliveries never launch twice", async () => {
  const binding = await fixture({ maxAttempts: 8, maxInputBytes: 24, maxConcurrent: 8 });
  const module = new URL("../src/resource-budget.ts", import.meta.url).href;
  const code = `const {openResourceBudget}=await import(${JSON.stringify(module)});try{await openResourceBudget(JSON.parse(process.argv[1])).reserve(JSON.parse(process.argv[2]));console.log('reserved')}catch(e){console.log(e.code)}`;
  const run = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(binding), JSON.stringify(request("duplicate"))], {
    env: { PATH: "", HOME: binding.directory, TMPDIR: binding.directory, PI_CODING_AGENT_DIR: binding.directory }, timeout: 10000,
  });
  const results = await Promise.all(Array.from({ length: 6 }, run));
  assert.equal(results.filter(r => r.stdout.trim() === "reserved").length, 1);
  assert.equal(results.filter(r => r.stdout.trim() === "DUPLICATE").length, 5);
  assert.equal((await openResourceBudget(binding).inspect()).active, 1, "exited owner does not imply completed work");
  const fresh = await fixture({ maxAttempts: 8, maxInputBytes: 24, maxConcurrent: 2 });
  const results2 = await Promise.all(Array.from({ length: 6 }, (_, i) => promisify(execFile)(process.execPath,
    ["--input-type=module", "-e", code, JSON.stringify(fresh), JSON.stringify(request(`parallel-${i}`))], { env: { PATH: "", HOME: fresh.directory, TMPDIR: fresh.directory }, timeout: 10000 })));
  assert.equal(results2.filter(r => r.stdout.trim() === "reserved").length, 2);
  assert.equal(results2.filter(r => r.stdout.trim() === "EXHAUSTED").length, 4);
});

test("byte exhaustion, malformed demands and parent references fail before a reservation", async () => {
  const b = openResourceBudget(await fixture({ maxAttempts: 8, maxInputBytes: 2, maxConcurrent: 2 }));
  await assert.rejects(b.reserve(request("large")), { code: "EXHAUSTED" });
  await assert.rejects(b.reserve(request("orphan", { inputBytes: 0, kind: "retry", parentAttemptId: "absent" })), { code: "INVALID" });
  await assert.rejects(b.reserve({ ...request("extra"), money: 0 } as AttemptDemand), { code: "INVALID" });
  await assert.rejects(b.reserve(request("nan", { inputBytes: NaN })), { code: "INVALID" });
  assert.equal((await b.inspect()).attempts, 0);
});

test("independent authority and physical root/journal pins reject mutable or alternate stores", async () => {
  const binding = await fixture(), budget = openResourceBudget(binding), permit = await budget.reserve(request("a"));
  await assert.rejects(openResourceBudget({ ...binding, limits: { ...binding.limits, maxAttempts: 5 } }).inspect(), { code: "AUTHORITY_CHANGED" });
  assert.throws(() => openResourceBudget({ ...binding, leaseStore: "elsewhere" } as typeof binding), { code: "INVALID" });
  const path = join(binding.directory, "budget.jsonl"), bytes = await readFile(path);
  await rename(path, path + ".old"); await writeFile(path, bytes, { mode: 0o600 });
  await assert.rejects(permit.settle("completed"), { code: "AUTHORITY_CHANGED" });
  await assert.rejects(openResourceBudget(binding).inspect(), { code: "AUTHORITY_CHANGED" });
  const another = await fixture();
  await assert.rejects(openResourceBudget({ ...binding, directory: another.directory }).inspect(), { code: "AUTHORITY_CHANGED" });
  await assert.rejects(createResourceBudget({ directory: binding.directory, authorityDigest: binding.authorityDigest, limits: binding.limits }), { code: "EEXIST" });
});

test("partial journals, aliases and unsafe permissions are unavailable rather than repaired", async () => {
  const binding = await fixture(), path = join(binding.directory, "budget.jsonl");
  await appendFile(path, '{"type":');
  await assert.rejects(openResourceBudget(binding).inspect(), { code: "INVALID" });
  assert.ok((await readFile(path, "utf8")).endsWith('{"type":'));
  const alias = binding.directory + "-alias"; await symlink(binding.directory, alias);
  await assert.rejects(openResourceBudget({ ...binding, directory: alias }).inspect());
  const unsafe = binding.directory + "-unsafe"; await mkdir(unsafe, { mode: 0o755 });
  await assert.rejects(createResourceBudget({ directory: join(unsafe, "new"), authorityDigest: binding.authorityDigest, limits: binding.limits }), { code: "INVALID" });
});
