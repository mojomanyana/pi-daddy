import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { appendDeclaredWorkOccurrence, declareWork, type DeclaredWorkState } from "../src/work-command.ts";
import { parseWorkLedgerText } from "../src/work-ledger.ts";
import { adoptDashboardHarnessBridge } from "../src/dashboard-harness.ts";
import { startDailyDashboardHost } from "../src/daily-dashboard-host.ts";
import { connectDashboardHost } from "../src/dashboard-host-transport.ts";
import { connectedHarness } from "./dashboard-host-fixture.ts";
import { ordinaryHostFixture } from "./ordinary-host-fixture.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { intentWorld } from "./intent-control-fixture.ts";
import { fixtureText } from "./work-ledger-fixtures.ts";
after(cleanupTempDirs);

test("supported daily host command composition publishes fresh work and pauses only new ordinary dispatch", async () => {
  const root=await tempDir("daily-dashboard-production-"),declared=await declareWork({cwd:root,id:"daily-owned",outcome:"Exercise current work while steering only new dispatch"});
  const child=await ordinaryHostFixture(root),loadedRoot=join(root,"loaded");await mkdir(loadedRoot,{mode:0o700});const loaded=await connectedHarness(loadedRoot);
  const harness=adoptDashboardHarnessBridge({version:"skill-harness-dashboard-bridge-v1",sourceCommit:"d123257e53d48a2cad6919708976b5371dc7590e",api:loaded.api});
  const running=await startDailyDashboardHost({id:"validation-01",cwd:root,directory:join(root,"host"),declared,ordinary:child.port,harness,author:"operator"});
  try {
    const remote=connectDashboardHost(running.socketPath),first=await remote.frame() as any;
    assert.equal(first.source.daily.obligations.length,1);assert.equal(first.source.daily.attempts.length,0);assert.equal(first.source.observations.length,2);assert.equal(first.source.unobservedSources.length,0);
    assert.match(first.source.observations.find((x:any)=>x.sourceId==='work').metadata.runtimeFactsManifestId,/^[a-f0-9]{64}$/);
    const active=child.run("hold");await child.ready("hold");assert.deepEqual(first.actions.map((x:any)=>x.key),["pause-new-dispatch","refresh-current-work"]);await remote.humanAction("refresh-current-work");assert.equal((await remote.frame() as any).source.daily.attempts.length,1);
    await remote.humanAction("pause-new-dispatch");
    assert.match(String((await child.run("blocked")).error),/ordinary dispatch held/);assert.equal((child.port.inspect() as any).children.find((x:any)=>x.target.toolCallId==="call:hold").state,"active");
    assert.deepEqual((await remote.frame() as any).actions.map((x:any)=>x.key).slice(0,2),["resume-dispatch","refresh-current-work"]);await remote.humanAction("resume-dispatch");
    assert.equal((await child.run("fast")).value.details.exitCode,0);await active;
  } finally {await running.close();await child.close();}
});

test("daily host exposes friendly scope, priority and approved-alternative actions through exact intent authority",async()=>{
 const root=await tempDir("daily-dashboard-intent-"),pi=join(root,".pi");await mkdir(pi,{mode:0o700});const w=intentWorld();
 await writeFile(join(pi,"work.jsonl"),fixtureText([...w.initial,...w.changes,...w.recorded]),{mode:0o600});
 const declared:any={version:"pi-daddy-declared-work-v1",id:"daily-intent",outcomeDigest:"0".repeat(64),ledgerPath:join(pi,"work.jsonl"),statePath:join(pi,"work-current.json"),grantLedgerPath:null,selectedSnapshot:w.selection(w.base),scope:w.base.payload.snapshot.scope,intent:w.base.payload.snapshot.bindings[0].intent,obligation:w.base.payload.snapshot.bindings[0].obligation,policy:w.base.payload.snapshot.bindings[0].policy};const {statePath:_statePath,...stored}=declared;await writeFile(declared.statePath,JSON.stringify(stored)+"\n",{mode:0o600});let rebound:DeclaredWorkState|null=null;
 const child=await ordinaryHostFixture(root),loadedRoot=join(root,"loaded");await mkdir(loadedRoot,{mode:0o700});const loaded=await connectedHarness(loadedRoot),harness=adoptDashboardHarnessBridge({version:"skill-harness-dashboard-bridge-v1",sourceCommit:"d123257e53d48a2cad6919708976b5371dc7590e",api:loaded.api});
 const running=await startDailyDashboardHost({id:"validation-intent",cwd:root,directory:join(root,"host"),declared,ordinary:child.port,harness,author:"operator",priorities:w.priorities(w.obligations),onDeclaredWorkChanged:state=>{rebound=state;}});
 try{
  const remote=connectDashboardHost(running.socketPath);let frame=await remote.frame() as any,priority=frame.actions.find((x:any)=>/Put obligation-2 first/.test(x.label)),scope=frame.actions.find((x:any)=>/Select recorded scope next/.test(x.label));assert.ok(priority);assert.ok(scope);
  await remote.humanAction(priority.key);frame=await remote.frame() as any;assert.deepEqual(frame.controls.intent.priorities.map((x:any)=>x.rank),[0,1]);assert.equal(frame.controls.intent.priorities[0].obligation.id,"obligation-2");
  scope=frame.actions.find((x:any)=>/Select recorded scope next/.test(x.label));await remote.humanAction(scope.key);frame=await remote.frame() as any;assert.equal(frame.controls.intent.selection.snapshot.id,"next");assert.equal(rebound!.obligation.digest,w.obligations2[0].payload.revision.digest);assert.match(frame.actions.find((x:any)=>x.key==="refresh-current-work").label,/next dispatch uses next/);await appendDeclaredWorkOccurrence(rebound!,{executionId:"exec:12345678-1234-4123-8123-123456789abc",parentExecutionId:null,childId:null,variantId:null,toolCallId:"call:rebound",taskId:null,workspaceId:null,definitionDigest:null,configurationDigest:null,modelId:null,effortId:null,now:new Date("2026-09-11T21:00:00Z")},"running");const occurrence=parseWorkLedgerText(await readFile(declared.ledgerPath,"utf8")).events.at(-1) as any;assert.equal(occurrence.payload.obligation.digest,w.obligations2[0].payload.revision.digest);const alternative=frame.actions.find((x:any)=>/Select recorded alternative alternative/.test(x.label));assert.ok(alternative);
  await remote.humanAction(alternative.key);frame=await remote.frame() as any;assert.equal(frame.controls.intent.selection.snapshot.id,"alternative");assert.equal(frame.actions.some((x:any)=>x.key===alternative.key),false);
 }finally{await running.close();await child.close();}
});

test("daily host offers case preparation only at explicit quiescent closing pause and defers without trust policy",async()=>{
 const root=await tempDir("daily-dashboard-closing-"),declared=await declareWork({cwd:root,id:"daily-closing",outcome:"Review retained cases only at an explicit closing pause"}),child=await ordinaryHostFixture(root),loadedRoot=join(root,"loaded");await mkdir(loadedRoot,{mode:0o700});const loaded=await connectedHarness(loadedRoot),harness=adoptDashboardHarnessBridge({version:"skill-harness-dashboard-bridge-v1",sourceCommit:"d123257e53d48a2cad6919708976b5371dc7590e",api:loaded.api}),evidence="e".repeat(64);
 const running=await startDailyDashboardHost({id:"validation-closing",cwd:root,directory:join(root,"host"),declared,ordinary:child.port,harness,author:"operator",presence:()=>({present:true,closing:true,evidenceDigest:evidence,expiresAt:Date.now()+60_000})});
 try{const remote=connectDashboardHost(running.socketPath);let frame=await remote.frame() as any;assert.equal(frame.actions.some((x:any)=>x.key==="prepare-case-cards"),false);await remote.humanAction("pause-new-dispatch");frame=await remote.frame() as any;const prepare=frame.actions.find((x:any)=>x.key==="prepare-case-cards");assert.ok(prepare);const prepared=await running.host.humanAction(prepare.key) as any;assert.equal(prepared.result.state,"deferred");assert.equal(prepared.result.reason,"policy-unavailable");frame=await remote.frame() as any;assert.equal(frame.debrief,null);assert.equal(frame.attention.attentionUsed,0);assert.equal(frame.actions.some((x:any)=>x.key==="acknowledge-case-cards"),false);}
 finally{await running.close();await child.close();}
});

test("daily host publishes deliberate cancellation for an exact active attempt", async () => {
  const root=await tempDir("daily-dashboard-cancel-"),declared=await declareWork({cwd:root,id:"daily-cancel",outcome:"Cancel only the selected running attempt"});
  const child=await ordinaryHostFixture(root),loadedRoot=join(root,"loaded");await mkdir(loadedRoot,{mode:0o700});const loaded=await connectedHarness(loadedRoot);
  const harness=adoptDashboardHarnessBridge({version:"skill-harness-dashboard-bridge-v1",sourceCommit:"d123257e53d48a2cad6919708976b5371dc7590e",api:loaded.api});
  const running=await startDailyDashboardHost({id:"validation-cancel",cwd:root,directory:join(root,"host"),declared,ordinary:child.port,harness,author:"operator"});
  try {
    const remote=connectDashboardHost(running.socketPath),active=child.run("hold");await child.ready("hold");
    const frame=await remote.frame() as any,cancel=frame.actions.find((x:any)=>String(x.key).startsWith("cancel-exec-"));
    assert.ok(cancel,"an active retained attempt must have a deliberate cancellation action");
    assert.match(cancel.label,/cancel running attempt/i);
    await remote.humanAction(cancel.key);
    assert.match(String((await active).error),/cancelled|aborted/i);
    assert.equal((await remote.frame() as any).actions.some((x:any)=>x.key===cancel.key),false);
  } finally {await running.close();await child.close();}
});
