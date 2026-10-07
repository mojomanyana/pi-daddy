/** Production regressions: single/all/chain must share reservations before gates and retain them across reloads. */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";
import grants from "../extensions/grants.ts";
import { bindReloadLifecycle } from "../extensions/reload-environment.ts";
import { runOwnedChild } from "../src/executors/owned-worker.ts";
import { reconcileDelegationCapacity } from "../extensions/session-capacity.ts";
import { piFixtureScript } from "./pi-fixture.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);

type Result = { isError?: boolean; content: { text: string }[]; details: any };
async function harness(t: import("node:test").TestContext, capacity: string, mode = "gate") {
  const root = await tempDir("pi-capacity-callers-");
  const prior = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
  });
  for (const key of Object.keys(process.env)) if (/^PI_(DADDY|GRANTS)_/.test(key)) delete process.env[key];
  const bin = join(root, "bin"),
    log = join(root, "starts.jsonl"),
    gate = join(root, "release");
  await mkdir(bin);
  Object.assign(process.env, {
    PI_DADDY_FANOUT: capacity,
    PI_DADDY_GRANT: "tool:read,tool:delegate",
    PI_DADDY_GATED: "",
    PI_DADDY_HERDR: "0",
    PI_DADDY_MAX_DEPTH: "5",
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PATH: `${bin}:${process.env.PATH}`,
    CAPACITY_TEST_LOG: log,
    CAPACITY_TEST_GATE: gate,
    CAPACITY_TEST_MODE: mode,
  });
  await writeFile(
    join(bin, "pi"),
    piFixtureScript(`
const fs=require('node:fs');
fs.appendFileSync(process.env.CAPACITY_TEST_LOG,JSON.stringify({pid:process.pid,allowance:process.env.PI_DADDY_FANOUT,task:process.argv.at(-1)})+'\\n');
if(process.env.CAPACITY_TEST_MODE==='unknown') {process.kill(process.ppid,'SIGKILL');setTimeout(()=>process.exit(0),250);}
else if(process.env.CAPACITY_TEST_MODE==='instant') process.stdout.write('complete '+process.env.PI_DADDY_FANOUT);
else {const timer=setInterval(()=>{if(fs.existsSync(process.env.CAPACITY_TEST_GATE)){clearInterval(timer);process.stdout.write('complete '+process.env.PI_DADDY_FANOUT);}},10);}
`),
  );
  await chmod(join(bin, "pi"), 0o700);
  const owner = {};
  const notices: string[] = [];
  const context = {
    cwd: root,
    sessionManager: owner,
    ui: { notify: (text: string) => notices.push(text), select: async () => undefined },
    modelRegistry: { find: () => undefined },
  };
  async function load() {
    const hooks = new Map<string, any>(),
      tools = new Map<string, any>();
    const active = new Set(["read", "delegate"]);
    grants({
      on: (name: string, fn: any) => hooks.set(name, fn),
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: () => {},
      getAllTools: () => ["read", "delegate"].map((name) => ({ name })),
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => {
        active.clear();
        names.forEach((name) => active.add(name));
      },
    } as never);
    await hooks.get("session_start")({}, context);
    return {
      call: (name: string, args: unknown) =>
        tools.get(name).execute("call", args, undefined, undefined, context) as Promise<Result>,
    };
  }
  const readStarts = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const untilStarts = async (count: number) => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      if ((await readStarts()).length >= count) return;
      await delay(10);
    }
    assert.fail("actual child start missing");
  };
  return {
    root,
    log,
    gate,
    load,
    notices,
    readStarts,
    untilStarts,
    ...(await load()),
    capacity: bindReloadLifecycle(owner, { root: {} }).lifecycle.capacity!.allocator,
  };
}
const task = { task: "fixture", tools: ["read"] };
const exhausted = (error: unknown) =>
  Boolean(error && typeof error === "object" && "code" in error && error.code === "FANOUT_EXCEEDED");

test("single caller spends its own slot, blocks overlapping calls before approval, and settled calls reuse capacity", async (t) => {
  const h = await harness(t, "1");
  const pending = h.call("delegate", task);
  await h.untilStarts(1);
  assert.equal((await h.readStarts())[0].allowance, "0");
  await assert.rejects(h.call("delegate", task), exhausted);
  await assert.rejects(h.call("delegate_all", { children: [task] }), exhausted);
  await assert.rejects(h.call("delegate_chain", { steps: [task, task] }), exhausted);
  assert.equal((await h.readStarts()).length, 1);
  await writeFile(h.gate, "go");
  const first = await pending;
  assert.equal(first.isError, false, JSON.stringify(first));
  assert.equal(first.details.cleanup.state, "settled");
  for (let i = 0; i < 3; i++) assert.equal((await h.call("delegate", task)).isError, false);
  assert.equal((await h.readStarts()).length, 4);
});

test("parallel calls reserve disjoint shares and a sequential chain counts one actual step at a time", async (t) => {
  const h = await harness(t, "3");
  const parallel = h.call("delegate_all", { children: [task, task] });
  await h.untilStarts(2);
  const third = h.call("delegate", task);
  await h.untilStarts(3);
  await assert.rejects(h.call("delegate", task), exhausted);
  assert.deepEqual(
    (await h.readStarts()).map((x) => x.allowance),
    ["0", "0", "0"],
  );
  await writeFile(h.gate, "go");
  assert.equal((await parallel).isError, false);
  assert.equal((await third).isError, false);
  const chain = await h.call("delegate_chain", { steps: [task, task, task, task] });
  assert.equal(chain.isError, false, JSON.stringify(chain));
  assert.equal(chain.details.completed, 4);
  assert.deepEqual(
    (await h.readStarts()).slice(3).map((x) => x.allowance),
    ["2", "2", "2", "2"],
  );
});

test("same-owner reload including explicit root replacement cannot mint permits for running work", async (t) => {
  const h = await harness(t, "1");
  const pending = h.call("delegate", task);
  await h.untilStarts(1);
  const reload = await h.load();
  await assert.rejects(reload.call("delegate", task), exhausted);
  process.env.PI_DADDY_FANOUT = "99";
  const changed = await h.load();
  await assert.rejects(changed.call("delegate", task), /existing owner/);
  await writeFile(h.gate, "go");
  assert.equal((await pending).isError, false);
  await assert.rejects(changed.call("delegate", task), /existing owner/);
  process.env.PI_DADDY_FANOUT = "1";
  const restored = await h.load();
  assert.equal((await restored.call("delegate", task)).isError, false);
  assert.equal((await h.readStarts()).length, 2);
});

test("inherited zero and malformed capacity refuse loudly without starting a child", async (t) => {
  const h = await harness(t, "0", "instant");
  await assert.rejects(h.call("delegate", task), exhausted);
  assert.deepEqual(await h.readStarts(), []);
  process.env.PI_DADDY_FANOUT = "malformed";
  const malformed = await h.load();
  await assert.rejects(malformed.call("delegate", task), /PI_DADDY_FANOUT/);
  assert.ok(h.notices.some((x) => x.includes("PI_DADDY_FANOUT")));
  assert.deepEqual(await h.readStarts(), []);
});

test("real captured helper death retains production capacity and blocks later dispatch", async (t) => {
  const h = await harness(t, "1", "unknown");
  const result = await h.call("delegate", task);
  assert.equal(result.isError, true);
  assert.equal(result.details.cleanup.state, "unknown");
  await assert.rejects(h.call("delegate", task), exhausted);
  await delay(350); // Fixture owns its bounded self-exit after the intentionally killed helper.
  assert.equal((await h.readStarts()).length, 1);
});

test("prelaunch planning refusals release the reservation before a later valid production call", async (t) => {
  const h = await harness(t, "1", "instant");
  await assert.rejects(h.call("delegate", { task: "denied", tools: ["write"] }));
  assert.equal((await h.call("delegate", task)).isError, false);
  assert.equal((await h.readStarts()).length, 1);
});

for (const name of ["delegate", "delegate_all", "delegate_chain"] as const) {
  test(`${name} recovers retained capacity only after an exact durable receipt arrives`, async (t) => {
    const h = await harness(t, "1", "instant");
    const reserved = h.capacity.reserve("late-proof", 0);
    assert.equal(reserved.ok, true);
    const item = reserved.reservation;
    const completed = await runOwnedChild({
      executionId: item.executionId,
      ownershipDir: join(h.root, "late-proof"),
      cwd: h.root,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      env: process.env,
      timeoutMs: 5000,
      onOwnership: (identity) => item.bindOwnership(identity),
    });
    assert.equal(completed.cleanup.state, "settled");
    const identity = item.identity!;
    const saved = identity.receiptPath + ".delayed";
    await rename(identity.receiptPath, saved);
    assert.equal(item.finalize({ state: "unknown", identity, reason: "receipt not observed" }), "retained");
    const args = name === "delegate" ? task : name === "delegate_all" ? { children: [task] } : { steps: [task] };
    await assert.rejects(h.call(name, args), exhausted);
    assert.equal(h.capacity.available, 0);
    const receipt = JSON.parse(await readFile(saved, "utf8"));
    await writeFile(identity.receiptPath, JSON.stringify({ ...receipt, identity: { ...identity, nonce: "wrong" } }));
    await assert.rejects(h.call(name, args), exhausted);
    assert.equal(h.capacity.available, 0);
    await rename(saved, identity.receiptPath);
    assert.equal((await h.call(name, args)).isError, false);
    assert.equal(item.state, "released");
    await Promise.all([reconcileDelegationCapacity(h), reconcileDelegationCapacity(h)]);
    assert.equal(h.capacity.available, 1);
    assert.deepEqual(h.capacity.retainedReservations, []);
    assert.equal((await h.readStarts()).length, 1, "only the call after verified proof starts");
    assert.equal(completed.cleanup.state, "settled");
  });
}
