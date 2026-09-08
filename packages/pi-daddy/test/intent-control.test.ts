import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, writeFile, readFile, open, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Compile } from "typebox/compile";
import { tempDir } from "./tmp.ts";
import { bindWorkIntent } from "../src/intent-application.ts";
import { createIntentBudget, openResourceBudget } from "../src/resource-budget.ts";
import { intentRequestDigest, parseIntentRequest, type IntentRequest } from "../src/intent-control.ts";
import { appendWorkLedgerEvent, parseWorkLedgerText, projectWorkLedger } from "../src/work-ledger.ts";
import { readDailyView } from "../src/daily-view.ts";
import { prepareDigestProfile, runDigestProfile } from "../src/effect-profile.ts";
import { intentWorld, fixedIntentRequests, fixedIntentAuthority, hostDigest } from "./intent-control-fixture.ts";
async function fixture() {
  const root = await tempDir("intent-application-"); await chmod(root, 0o700);
  const w = intentWorld(), path = join(root, "work.jsonl"), grantPath = join(root, "grants.jsonl");
  await writeFile(path, w.text, { mode: 0o600 }); await writeFile(grantPath, "owned permission fixture: unchanged\n", { mode: 0o600 });
  const work = await bindWorkIntent({ path, grantLedgerPath: grantPath, selection: w.selection(w.base), priorities: w.priorities(w.obligations) });
  const binding = await createIntentBudget({ directory: join(root, "budget"), authorityDigest: hostDigest, limits: { maxAttempts: 8, maxInputBytes: 128, maxConcurrent: 2 } }, work);
  const budget = openResourceBudget(binding), controls = budget.intentControls(fixedIntentAuthority(binding));
  return { root, path, grantPath, binding, budget, controls, requests: fixedIntentRequests(binding), w };
}
const demand = (attemptId: string) => ({ attemptId, orderId: "order", experimentId: "experiment", kind: "primary" as const, parentAttemptId: null, inputBytes: 1, inputDigest: "a".repeat(64) });

test("actual P01 successor append, explicit priority application, and recorded alternative selection", async () => {
  const f = await fixture();
  const next = await f.controls.request(f.requests.revise);
  assert.equal(next.records[0].application, "applied"); assert.equal(next.records[0].outcome, "selection-applied");
  assert.deepEqual(next.records[0].resultSelection, f.w.selection(f.w.next)); assert.deepEqual(next.selection, f.w.selection(f.w.next));
  let text = await readFile(f.path, "utf8"); assert.equal(parseWorkLedgerText(text).events.length, 11);
  const projected = projectWorkLedger(text, { selectedSnapshot: next.selection, authority: null });
  assert.equal(projected.scopeState, "valid"); assert.equal(projected.obligations[0].binding.obligation.revision, 2);
  const view = await readDailyView({ workLedgerPath: f.path, workContext: { selectedSnapshot: next.selection, authority: null } });
  assert.equal(view.scope?.revision, 2); assert.equal(view.progress, null);
  assert.ok(projected.obligations.every(o => o.acceptance !== "accepted-under-supplied-authority"));
  assert.equal((await f.controls.inspect()).nextObligation?.id, "obligation-2");
  const priority = await f.controls.request(f.requests.priority);
  assert.equal(priority.records[1].application, "applied"); assert.equal(priority.records[1].outcome, "priority-applied"); assert.equal((await f.controls.inspect()).nextObligation?.id, "obligation-1");
  assert.equal(await readFile(f.path, "utf8"), text, "priority is explicit controller policy, not rewritten work or array ordering");
  for (const e of f.w.recorded) await appendWorkLedgerEvent({ path: f.path, grantLedgerPath: null }, e);
  text = await readFile(f.path, "utf8");
  const alternative = await f.controls.request(f.requests.alternative);
  assert.deepEqual(alternative.selection, f.w.selection(f.w.alternative)); assert.equal(await readFile(f.path, "utf8"), text);
  assert.equal(projectWorkLedger(text, { selectedSnapshot: alternative.selection, authority: null }).scopeState, "valid");
  assert.equal(await readFile(f.grantPath, "utf8"), "owned permission fixture: unchanged\n");
  for (const e of parseWorkLedgerText(text).events) if (e.event === "work_revision") assert.deepEqual(e.payload.revision.permittedEffects, e.payload.revision.kind === "policy" ? [] : ["read"]);
});

test("busy barrier waits for original live reservation; exact duplicate never applies and status never writes", async () => {
  const f = await fixture(); await f.controls.request(f.requests.revise);
  const state = await f.controls.inspect(), permit = await f.budget.reserve(demand("busy"), { selection: state.selection, revision: state.revision, obligation: state.nextObligation! });
  assert.equal((await f.controls.request(f.requests.priority)).records[1].application, "pending-or-unknown");
  await assert.rejects(f.budget.reserve(demand("blocked"), { selection: state.selection, revision: state.revision, obligation: state.nextObligation! }), { code: "DISPATCH_BLOCKED" });
  assert.equal((await f.controls.reconcile(f.requests.priority)).records[1].application, "pending-or-unknown");
  await permit.settle("completed");
  const files = [f.path, join(f.binding.directory, "budget.jsonl")], bytes = await Promise.all(files.map(p => readFile(p))), names = await readdir(f.binding.directory);
  for (let i = 0; i < 3; i++) await f.controls.inspect();
  await f.controls.request(f.requests.priority);
  assert.deepEqual(await Promise.all(files.map(p => readFile(p))), bytes); assert.deepEqual(await readdir(f.binding.directory), names);
  const restart = openResourceBudget(f.binding).intentControls(fixedIntentAuthority(f.binding));
  assert.equal((await restart.reconcile(f.requests.priority)).records[1].application, "applied");
  const after = await readFile(files[1]); await restart.reconcile(f.requests.priority); assert.deepEqual(await readFile(files[1]), after);
});

test("stale binding/selection/authority and permission expansion refuse without changing authoritative intent", async () => {
  const f = await fixture(), before = await readFile(f.path);
  await assert.rejects(f.controls.request(f.requests.expand), /permission expansion/);
  assert.deepEqual(await readFile(f.path), before);
  const altered = { ...f.requests.revise, requestId: "wire-approval", expectedSelection: f.w.selection(f.w.alternative) };
  assert.equal((await f.controls.request(altered)).records[0].decision, "authority-unavailable");
  await f.controls.request(f.requests.revise);
  assert.equal((await f.controls.request(f.requests.stale)).records.at(-1)?.decision, "stale");
  await assert.rejects(f.controls.request({ ...f.requests.priority, bindingDigest: "c".repeat(64) }), { code: "AUTHORITY_CHANGED" });
  await assert.rejects(f.controls.request({ ...f.requests.revise, selection: f.w.selection(f.w.base) }), { code: "DUPLICATE" });
});

test("reconciliation checks the complete original request against receipt references, not digest-shaped metadata alone", async () => {
  const f = await fixture(), state = await f.controls.inspect();
  const permit = await f.budget.reserve(demand("busy-projection"), { selection: state.selection, revision: state.revision, obligation: state.nextObligation! });
  await f.controls.request(f.requests.revise); await permit.settle("completed");
  const path = join(f.binding.directory, "budget.jsonl"), original = await readFile(path, "utf8");
  await writeFile(join(f.root, "original-controller-journal.jsonl"), original);
  const records = original.trim().split("\n").map(line => JSON.parse(line));
  records.find(r => r.type === "intent-request").receipt.priorities[0].rank = 99;
  await writeFile(path, records.map(r => JSON.stringify(r)).join("\n") + "\n");
  await assert.rejects(f.controls.request(f.requests.revise), /receipt projection/);
  await assert.rejects(f.controls.reconcile(f.requests.revise), /receipt projection/);
  assert.equal(await readFile(f.path, "utf8"), f.w.text);
});

test("actual fixed-profile dispatch consumes the explicit priority policy without expanding resource limits", async () => {
  const f = await fixture(); await f.controls.request(f.requests.revise); await f.controls.request(f.requests.priority);
  const profile = await prepareDigestProfile(f.binding), state = await f.controls.inspect();
  const a = { attemptId: "scheduled", orderId: "order", experimentId: "experiment", kind: "primary" as const, parentAttemptId: null };
  await assert.rejects(runDigestProfile(profile, { attempt: a, bytes: Buffer.from("x") }), /v3 reservations/);
  await assert.rejects(runDigestProfile(profile, { attempt: a, bytes: Buffer.from("x"), intent: { selection: state.selection, revision: state.revision, obligation: f.requests.priority.priorities[1].obligation } }), /out-of-priority/);
  assert.equal((await f.budget.inspect()).attempts, 0);
  const result = await runDigestProfile(profile, { attempt: a, bytes: Buffer.from("x"), intent: { selection: state.selection, revision: state.revision, obligation: state.nextObligation! } });
  assert.equal(result.output.code, 0); assert.ok(result.digest);
  assert.equal((await f.controls.inspect()).nextObligation?.id, "obligation-2");
  assert.deepEqual(f.binding.limits, { maxAttempts: 8, maxInputBytes: 128, maxConcurrent: 2 });
});

test("work append completed but controller receipt failed: unknown until exact request reconciliation, no duplicate intent", async t => {
  const f = await fixture(), handle = await open(f.path, "r"), proto = Object.getPrototypeOf(handle); await handle.close();
  const original = proto.writeFile;
  const fault = t.mock.method(proto, "writeFile", async function(this: unknown, data: unknown, ...args: unknown[]) {
    if (String(data).includes('"type":"intent-apply"')) throw new Error("owned application receipt failure");
    return original.call(this, data, ...args);
  });
  await assert.rejects(f.controls.request(f.requests.revise), /owned application receipt failure/); fault.mock.restore();
  const text = await readFile(f.path, "utf8"); assert.equal(parseWorkLedgerText(text).events.length, 11);
  const state = await f.controls.inspect(); assert.deepEqual(state.selection, f.w.selection(f.w.base)); assert.equal(state.records[0].application, "pending-or-unknown");
  assert.equal(state.records[0].outcome, "pending-or-unknown"); assert.equal(state.records[0].resultSelection, null);
  assert.equal((await f.controls.request(f.requests.revise)).records[0].application, "pending-or-unknown");
  const restart = openResourceBudget(f.binding).intentControls(fixedIntentAuthority(f.binding));
  await assert.rejects(restart.reconcile({ ...f.requests.revise, requestId: "wrong" }), { code: "DUPLICATE" });
  assert.equal((await restart.reconcile(f.requests.revise)).records[0].application, "applied");
  assert.equal(await readFile(f.path, "utf8"), text);
});

test("interrupted multi-record application resumes a complete prefix exactly once", async t => {
  const f = await fixture(), handle = await open(f.path, "r"), proto = Object.getPrototypeOf(handle); await handle.close();
  const original = proto.writeFile; let workWrites = 0;
  const fault = t.mock.method(proto, "writeFile", async function(this: unknown, data: unknown, ...args: unknown[]) {
    if (String(data).includes('"event":"work_revision"') && ++workWrites === 2) throw new Error("owned between-record interruption");
    return original.call(this, data, ...args);
  });
  await assert.rejects(f.controls.request(f.requests.revise), /owned between-record interruption/); fault.mock.restore();
  assert.equal(parseWorkLedgerText(await readFile(f.path, "utf8")).events.length, 7);
  await f.controls.reconcile(f.requests.revise);
  const events = parseWorkLedgerText(await readFile(f.path, "utf8")).events;
  assert.equal(events.length, 11); assert.equal(new Set(events.map(e => e.eventId)).size, 11);
});

test("torn work bytes and physical substitution fail closed without reset or alternate-store recovery", async () => {
  const f = await fixture(); await writeFile(f.path, f.w.text + '{"event":');
  await assert.rejects(f.controls.request(f.requests.revise), /incomplete/);
  assert.ok((await readFile(f.path, "utf8")).endsWith('{"event":'));
  const g = await fixture(); await rename(g.path, g.path + ".history"); await writeFile(g.path, g.w.text, { mode: 0o600 });
  await assert.rejects(g.controls.request(g.requests.revise), /binding changed/);
  await assert.rejects(g.controls.inspect(), /binding changed/);
});

test("real cross-process duplicate applications append one exact work revision set", async () => {
  const f = await fixture(), module = new URL("../src/resource-budget.ts", import.meta.url).href, fixtures = new URL("./intent-control-fixture.ts", import.meta.url).href;
  const code = `const {openResourceBudget}=await import(${JSON.stringify(module)});const {fixedIntentAuthority,fixedIntentRequests}=await import(${JSON.stringify(fixtures)});const b=JSON.parse(process.argv[1]);await openResourceBudget(b).intentControls(fixedIntentAuthority(b)).request(fixedIntentRequests(b).revise);`;
  await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(f.binding)], { env: { PATH: "", HOME: f.root, TMPDIR: f.root }, timeout: 10000 })));
  assert.equal(parseWorkLedgerText(await readFile(f.path, "utf8")).events.length, 11);
  assert.equal((await readFile(join(f.binding.directory, "budget.jsonl"), "utf8")).trim().split("\n").length, 3);
});

test("actual controller crash preserves pending receipts and non-expiring locks; status cannot reclaim them", async () => {
  const f = await fixture(), module = new URL("../src/resource-budget.ts", import.meta.url).href, fixtures = new URL("./intent-control-fixture.ts", import.meta.url).href;
  const code = `import{open}from'node:fs/promises';const {openResourceBudget}=await import(${JSON.stringify(module)});const {fixedIntentAuthority,fixedIntentRequests}=await import(${JSON.stringify(fixtures)});const b=JSON.parse(process.argv[1]);const h=await open(b.intent.path,'r'),p=Object.getPrototypeOf(h);await h.close();const original=p.writeFile;let n=0;p.writeFile=async function(data,...args){if(String(data).includes('"event":"work_revision"')&&++n===2)process.exit(73);return original.call(this,data,...args)};await openResourceBudget(b).intentControls(fixedIntentAuthority(b)).request(fixedIntentRequests(b).revise);`;
  await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(f.binding)], { env: { PATH: "", HOME: f.root, TMPDIR: f.root }, timeout: 10000 }), { code: 73 });
  const lockPath = join(f.binding.directory, "budget.jsonl.lock"), lock = await readFile(lockPath);
  assert.equal((await f.controls.inspect()).records[0].application, "pending-or-unknown");
  await assert.rejects(f.controls.reconcile(f.requests.revise), /locked/);
  assert.deepEqual(await readFile(lockPath), lock); assert.equal(parseWorkLedgerText(await readFile(f.path, "utf8")).events.length, 7);
});

test("wire parser is duplicate-aware, exact numeric and detached; control receipts retain references, not shadow intent", async () => {
  const f = await fixture(), wire = JSON.stringify(f.requests.revise);
  assert.equal(intentRequestDigest(parseIntentRequest(wire)), intentRequestDigest(f.requests.revise));
  const schema = JSON.parse(await readFile(new URL(import.meta.resolve("pi-daddy/contracts/intent-control/v1/request.schema.json")), "utf8"));
  const ledger = JSON.parse(await readFile(new URL("../contracts/ledger/v4/ledger-event.schema.json", import.meta.url), "utf8"));
  for (const [key, definition] of Object.entries(ledger.$defs)) assert.deepEqual(schema.$defs[`work_${key}`], JSON.parse(JSON.stringify(definition).replaceAll("#/$defs/", "#/$defs/work_")));
  const validator = Compile(schema);
  assert.equal(validator.Check(f.requests.revise), true);
  assert.equal(validator.Check({ ...f.requests.revise, authority: "claimed" }), false);
  assert.throws(() => parseIntentRequest(wire.replace('"expectedRevision":0', '"expectedRevision":0.00000000000000000001')));
  assert.throws(() => parseIntentRequest(wire.replace('"requestId":"revise"', '"requestId":"revise","requestId":"revise"')));
  const pending = f.controls.request(f.requests.revise); f.requests.revise.events.length = 0;
  assert.equal((await pending).records[0].application, "applied");
  const text = await readFile(join(f.binding.directory, "budget.jsonl"), "utf8");
  assert.equal(text.includes('"contentDigest"'), false); assert.equal(text.includes('"permittedEffects"'), false);
});
