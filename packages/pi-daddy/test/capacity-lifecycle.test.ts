/** Actual process regressions: reservations precede overlapping/nested starts, and only owned settlement refunds. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCapacityAllocator, type CapacityAllocator, type CapacityReservation } from "../src/kernel/capacity.ts";
import { runOwnedChild } from "../src/executors/owned-worker.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);

function reserve(owner: CapacityAllocator, id: string, childAllowance = 0): CapacityReservation {
  const result = owner.reserve(id, childAllowance);
  assert.equal(result.ok, true);
  return result.reservation;
}
function request(root: string, reservation: CapacityReservation, code: string) {
  return {
    cwd: root,
    executionId: reservation.executionId,
    ownershipDir: join(root, reservation.executionId),
    command: process.execPath,
    args: ["--input-type=module", "-e", code],
    env: { ...process.env, PI_DADDY_FANOUT: String(reservation.childAllowance) },
    timeoutMs: 5000,
    killGraceMs: 60,
    onOwnership: (identity: Parameters<CapacityReservation["bindOwnership"]>[0]) => reservation.bindOwnership(identity),
  };
}
async function records(path: string): Promise<Array<{ phase: string; id: string; pid: number }>> {
  return (await readFile(path, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function eventually(check: () => Promise<boolean>) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail("bounded process observation did not arrive");
}

test("overlapping and nested actual starts conserve one root allowance including terminal inherited zero", async () => {
  const root = await tempDir("pi-capacity-nested-");
  const log = join(root, "actual.jsonl");
  const gate = join(root, "finish");
  const worker = join(root, "worker.mjs");
  const program = `
import assert from 'node:assert/strict';
import {appendFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createCapacityAllocator} from ${JSON.stringify(new URL("../src/kernel/capacity.ts", import.meta.url).href)};
import {budgetFromEnv} from ${JSON.stringify(new URL("../src/kernel/fanout.ts", import.meta.url).href)};
import {runOwnedChild} from ${JSON.stringify(new URL("../src/executors/owned-worker.ts", import.meta.url).href)};
const [role,id]=process.argv.slice(2);
const write=async phase=>appendFile(process.env.CAPACITY_LOG,JSON.stringify({phase,id,pid:process.pid})+'\\n');
await write('start');
const owner=createCapacityAllocator(budgetFromEnv(process.env.PI_DADDY_FANOUT));
if(role==='parent') {
  assert.equal(owner.total,1);
  const r=owner.reserve('grandchild',0); assert.ok(r.ok);
  assert.equal(owner.reserve('nested-extra',0).ok,false);
  await write('nested-refused');
  const result=await runOwnedChild({executionId:'grandchild',ownershipDir:join(process.cwd(),'grandchild-owner'),
    cwd:process.cwd(),command:process.execPath,args:[process.argv[1],'leaf','grandchild'],
    env:{...process.env,PI_DADDY_FANOUT:String(r.reservation.childAllowance)},timeoutMs:4000,killGraceMs:60,
    onOwnership:identity=>r.reservation.bindOwnership(identity)});
  assert.equal(result.cleanup.state,'settled'); assert.equal(result.code,0);
  assert.equal(r.reservation.finalize(result.cleanup),'released'); assert.equal(owner.available,1);
} else {
  assert.equal(owner.total,0); assert.equal(owner.reserve('zero-extra',0).ok,false);
  while(!(await access(process.env.CAPACITY_GATE).then(()=>true,()=>false))) await delay(10);
}
await write('end');
`;
  await writeFile(worker, program);
  const owner = createCapacityAllocator(3);
  const parent = reserve(owner, "parent", 1);
  const sibling = reserve(owner, "sibling", 0);
  assert.equal(owner.reserve("overlapping-extra", 0).ok, false);
  const start = (item: CapacityReservation, role: string) =>
    runOwnedChild({
      ...request(root, item, ""),
      args: [worker, role, item.executionId],
      env: { ...process.env, PI_DADDY_FANOUT: String(item.childAllowance), CAPACITY_LOG: log, CAPACITY_GATE: gate },
    });
  const pending = [start(parent, "parent"), start(sibling, "leaf")];
  await eventually(async () => (await records(log)).filter((x) => x.phase === "start").length === 3);
  const live = (await records(log)).filter((x) => x.phase === "start");
  assert.deepEqual(new Set(live.map((x) => x.id)), new Set(["parent", "sibling", "grandchild"]));
  for (const item of live) assert.doesNotThrow(() => process.kill(item.pid, 0), "all three sessions actually overlap");
  assert.equal(owner.available, 0);
  assert.equal(owner.reserve("late-overlap", 0).ok, false);
  await writeFile(gate, "release");
  const results = await Promise.all(pending);
  for (let index = 0; index < results.length; index++) {
    assert.equal(results[index].cleanup.state, "settled");
    assert.equal(results[index].code, 0);
    assert.equal([parent, sibling][index].finalize(results[index].cleanup), "released");
  }
  assert.equal(owner.available, 3);
  let active = 0,
    peak = 0;
  for (const item of await records(log)) {
    if (item.phase === "start") peak = Math.max(peak, ++active);
    if (item.phase === "end") active--;
  }
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

test("repeated settled actual children reuse capacity and double finalization never refunds twice", async () => {
  const root = await tempDir("pi-capacity-reuse-");
  const owner = createCapacityAllocator(1);
  for (let index = 0; index < 5; index++) {
    const item = reserve(owner, `repeated-${index}`);
    const result = await runOwnedChild(request(root, item, "process.stdout.write('actual child')"));
    assert.equal(result.text, "actual child");
    assert.equal(result.cleanup.state, "settled");
    assert.equal(item.finalize(result.cleanup), "released");
    assert.equal(item.finalize(result.cleanup), "released");
    assert.equal(owner.available, 1);
  }
});

test("failed, timed-out, cancelled and proven-not-started actual paths refund only their settled subtree", async () => {
  const root = await tempDir("pi-capacity-outcomes-");
  const owner = createCapacityAllocator(1);
  for (const mode of ["failure", "timeout", "cancelled", "not-started"] as const) {
    const item = reserve(owner, mode);
    const abort = new AbortController();
    if (mode === "not-started") abort.abort();
    const timer = mode === "cancelled" ? setTimeout(() => abort.abort(), 120) : undefined;
    const result = await runOwnedChild({
      ...request(
        root,
        item,
        mode === "failure" ? "process.exit(7)" : "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
      ),
      signal: abort.signal,
      timeoutMs: mode === "timeout" ? 100 : 3000,
    });
    if (timer) clearTimeout(timer);
    if (mode === "not-started") assert.equal(result.cleanup.state, "not-started");
    else assert.equal(result.cleanup.state, "settled");
    if (mode === "failure") assert.equal(result.code, 7);
    if (mode === "timeout") assert.equal(result.timedOut, true);
    if (mode === "cancelled") assert.equal(result.aborted, true);
    assert.equal(item.finalize(result.cleanup), "released");
    assert.equal(owner.available, 1);
  }
});

test("actual helper death retains capacity even when no command passed its ownership gate", async () => {
  const root = await tempDir("pi-capacity-unknown-");
  const owner = createCapacityAllocator(1);
  const item = reserve(owner, "unknown");
  const result = await runOwnedChild({
    ...request(root, item, "process.stdout.write('must not run')"),
    onOwnership(identity) {
      item.bindOwnership(identity);
      process.kill(identity.helperPid, "SIGKILL");
    },
  });
  assert.equal(result.text, "");
  assert.equal(result.cleanup.state, "unknown");
  assert.equal(item.finalize(result.cleanup), "retained");
  assert.equal(item.finalize({ state: "not-started", reason: "no stdout is not non-start proof" }), "retained");
  assert.equal(owner.available, 0);
  assert.equal(owner.reserve("unsafe-reuse", 0).ok, false);
});
