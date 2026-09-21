import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, test } from "node:test";
import { createDailyDashboardSession } from "../extensions/daily-dashboard-session.ts";
import { associateOrdinaryHost, ordinaryChildrenFor, retainOrdinaryChild } from "../src/products/ordinary-children.ts";
import { declareWork } from "../src/products/work-command.ts";
import { connectDashboardHost, ENV_DASHBOARD_HOST_SOCKET } from "../src/products/dashboard-host-transport.ts";
import { dispatchRequestDigest, type DispatchRequest } from "../src/products/dispatch-control.ts";
import { openResourceBudget } from "../src/products/resource-budget.ts";
import { openDashboardHost } from "../src/products/dashboard-host.ts";
import { connectedHarness } from "./dashboard-host-fixture.ts";
import { hostWorld } from "./dashboard-host-world.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
const port = () => { const host = {}, session = {}; associateOrdinaryHost(host, session); return ordinaryChildrenFor(session); };
const target = (n: number) => ({ executionId: `exec:00000000-0000-4000-8000-${String(n).padStart(12,"0")}`, parentExecutionId: null, toolCallId: `call:${n}` });
const resume = async (w: Awaited<ReturnType<typeof hostWorld>>, approved = true) => {
  const state = await openResourceBudget(w.budget).controls(null).inspect();
  const native: DispatchRequest = { version: "1.0", requestId: `resume:${approved}`, bindingDigest: w.config.budgetDigest, expectedRevision: state.revision, action: "resume-dispatch", targetExecutionId: null };
  w.authority!.dispatch!.requestDigests = approved ? [dispatchRequestDigest(native)] : [];
  return w.request("dispatch", native);
};

test("paused session stop refuses without losing the original socket, cancellation or resume; fresh host stays usable", async () => {
  const cwd = await tempDir("host-stop-"), declared = await declareWork({ cwd, id: "stop", outcome: "Keep the original admission owner" });
  const loadedRoot = join(cwd,"loaded"); await mkdir(loadedRoot,{mode:0o700}); const loaded = await connectedHarness(loadedRoot), ordinary = port();
  const symbol = Symbol.for("skill-harness.dashboard-host.v1"), globals = globalThis as Record<PropertyKey,unknown>, old = globals[symbol];
  globals[symbol] = { version: "skill-harness-dashboard-bridge-v1", sourceCommit: "d123257e53d48a2cad6919708976b5371dc7590e", api: loaded.api };
  const env: Record<string,string|undefined> = {}, session = createDailyDashboardSession({ ordinary: () => ordinary, declared: () => declared, rebind: () => {}, cwd: () => cwd, env, author: "operator", home: cwd });
  let child: ReturnType<typeof retainOrdinaryChild> | undefined;
  try {
    await session.run("first"); child = retainOrdinaryChild(ordinary, target(1)); await session.choose("pause-new-dispatch");
    const socket = env[ENV_DASHBOARD_HOST_SOCKET]!, before = await session.frame();
    await assert.rejects(session.run("stop"), /resume.*first/i);
    assert.equal(session.running,true); assert.equal(env[ENV_DASHBOARD_HOST_SOCKET],socket);
    assert.equal((await connectDashboardHost(socket).frame()).tip,before.tip,"refused stop is non-writing and leaves the original endpoint live");
    assert.throws(() => retainOrdinaryChild(ordinary,target(2)), /dispatch held/); assert.equal(child.signal.aborted,false);
    const cancel = (await session.frame()).actions.find(a => a.operation === "ordinary-cancel"); assert.ok(cancel);
    await session.choose(cancel.key); assert.equal(child.signal.aborted,true); child.settle({state:"cancelled"},"not-assessed"); child = undefined;
    await session.choose("resume-dispatch"); assert.equal((ordinary.inspect() as any).admission,"open");
    await session.run("stop"); assert.equal(session.running,false); assert.equal(env[ENV_DASHBOARD_HOST_SOCKET],undefined);
    await session.run("second"); const next = retainOrdinaryChild(ordinary,target(3)); next.settle({state:"settled"},"not-assessed");
    await session.choose("pause-new-dispatch"); await session.choose("resume-dispatch"); await session.run("stop");
  } finally { child?.settle({state:"settled"},"not-assessed"); await session.close(); old === undefined ? delete globals[symbol] : globals[symbol] = old; }
});

test("a denied resume cannot release an earlier applied ordinary pause", async () => {
  const ordinary = port(), w = await hostWorld(false,"signals",ordinary); await w.pause();
  const result = await w.host.action(await resume(w,false)); assert.equal((result.result as any).application,"not-applied");
  assert.equal((ordinary.inspect() as any).admission,"held-by-original-owner");
  await assert.rejects(w.host.stop(), /resume.*first/i);
  await w.host.action(await resume(w)); await w.host.stop(); assert.equal((ordinary.inspect() as any).admission,"open");
});

test("lost final resume acknowledgement keeps the hold and refuses stop even after native resume applied", async () => {
  const ordinary = port(), w = await hostWorld(false,"signals",ordinary); await w.pause(); const request = await resume(w);
  const path = join(w.config.trustDirectory,"producer-host/events.jsonl"), original = fs.fsyncSync; let fired = false;
  fs.fsyncSync = ((fd: number) => { original(fd); if (!fired && fs.readlinkSync(`/proc/self/fd/${fd}`) === path && fs.readFileSync(path,"utf8").trimEnd().split("\n").at(-1)!.includes('"result"')) { fired = true; throw Error("lost final resume acknowledgement"); } }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try { await assert.rejects(w.host.action(request), /lost final resume acknowledgement/); }
  finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert.ok(fired); assert.equal((await openResourceBudget(w.budget).controls(null).inspect()).paused,false);
  assert.equal((ordinary.inspect() as any).admission,"held-by-original-owner");
  const before = await readFile(path); await assert.rejects(w.host.stop(), /acknowledgement unknown/);
  assert.deepEqual(await readFile(path),before); assert.equal((await w.host.frame()).control,"failed");
  w.host.endSession(); assert.equal((ordinary.inspect() as any).admission,"held-by-original-owner","session disposal disconnects; it must not release or claim reconciliation");
});

test("safe stop refuses in-flight effects and atomically excludes new actions after admission checking starts", async () => {
  const w = await hostWorld(false); let enter!: () => void, release!: () => void;
  const ready = new Promise<void>(r => enter = r), gate = new Promise<void>(r => release = r);
  const host = openDashboardHost({...w.options,beforeObservation:async () => { enter(); await gate; }});
  const action = host.action(await w.request("observe",{sourceId:"facts",previousCheckpointId:null,facts:null}));
  try { await ready; await assert.rejects(host.stop(), /operation busy/); }
  finally { release(); await action; }
  const request = await w.request("defer",{reason:"stop race"}), before = await readFile(join(w.config.trustDirectory,"producer-host/events.jsonl"));
  const stopping = host.stop(); await assert.rejects(host.action(request), /busy|stopped/); await stopping;
  assert.deepEqual((await host.frame()).actions,[]); await assert.rejects(host.action(request), /stopped/);
  assert.deepEqual(await readFile(join(w.config.trustDirectory,"producer-host/events.jsonl")),before);
});

test("pending original dispatch cannot be discarded; only explicit reconciliation and resume permit stop", async () => {
  const w = await hostWorld(false), budget = openResourceBudget(w.budget), intent = await budget.intentControls(null).inspect();
  const permit = await budget.reserve({attemptId:"held",orderId:"order",experimentId:"manual",kind:"primary",parentAttemptId:null,inputBytes:1,inputDigest:"a".repeat(64)},{revision:intent.revision,selection:intent.selection,obligation:intent.nextObligation!});
  await w.pause(); await assert.rejects(w.host.stop(), /pending.*reconcil/i); await permit.settle("completed");
  await assert.rejects(w.host.stop(), /pending.*reconcil/i);
  const native: DispatchRequest = {version:"1.0",requestId:"pause:0",bindingDigest:w.config.budgetDigest,expectedRevision:0,action:"pause-dispatch",targetExecutionId:null};
  await w.host.action(await w.request("dispatch-reconcile",native)); await w.host.action(await resume(w)); await w.host.stop();
});
