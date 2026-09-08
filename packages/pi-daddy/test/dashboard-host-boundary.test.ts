import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { after,test } from "node:test";
import { readFile,appendFile,rename } from "node:fs/promises";
import { join } from "node:path";
import { hostWorld } from "./dashboard-host-world.ts";
import { cleanupTempDirs } from "./tmp.ts";
import { openDashboardHost } from "../src/dashboard-host.ts";
import { dispatchRequestDigest,type DispatchRequest } from "../src/dispatch-control.ts";
import { openResourceBudget } from "../src/resource-budget.ts";
import { loadDashboardHarness } from "../src/dashboard-harness.ts";
import { prepareDigestProfile } from "../src/effect-profile.ts";
import { experimentBindingDigest,experimentCancellationDigest,type ExperimentCancellation } from "../src/experiment.ts";
after(cleanupTempDirs);
async function present(w:Awaited<ReturnType<typeof hostWorld>>,host=w.host){return host.action(await w.request("present",{userPresent:true,closing:true,evidenceDigest:w.presence.evidenceDigest,dispatchRevision:(await openResourceBudget(w.budget).controls(null).inspect()).revision}));}
test("zero-card coverage issues and original v2 writer both load through owned durable host",async()=>{
 const empty=await hostWorld(false,"zero");await empty.pause();await present(empty);const v:any=await empty.host.frame();assert.equal(v.debrief.cards.length,0);assert.ok(v.debrief.observation.issues.includes("scope-unresolved"));assert.equal(v.attention.attentionUsed,0);
 const old=await hostWorld(false,"v2");await old.pause();await present(old);const f:any=await old.host.frame();assert.equal(f.debrief.cards.length,1);assert.equal(f.debrief.observation,undefined);await old.host.action(await old.request("debrief","label 1 expected_behavior"));assert.equal((await old.host.frame() as any).debrief.cards[0].resolution,"label-recorded");
});
test("busy reservation yields pending pause, status cannot reconcile; explicit safe-boundary action applies once",async()=>{
 const w=await hostWorld(false),b=openResourceBudget(w.budget),intent=await b.intentControls(null).inspect(),permit=await b.reserve({attemptId:"busy",orderId:"order",experimentId:"manual",kind:"primary",parentAttemptId:null,inputBytes:1,inputDigest:"a".repeat(64)},{revision:intent.revision,selection:intent.selection,obligation:intent.nextObligation!});
 const revision=await w.pause();assert.equal((await b.controls(null).inspect()).admission,"blocked-pending");await permit.settle("completed");const bytes=await readFile(join(w.budget.directory,"budget.jsonl"));await w.host.frame();assert.deepEqual(await readFile(join(w.budget.directory,"budget.jsonl")),bytes);assert.equal((await b.controls(null).inspect()).paused,false);
 const native:DispatchRequest={version:"1.0",requestId:"pause:0",bindingDigest:w.config.budgetDigest,expectedRevision:revision-1,action:"pause-dispatch",targetExecutionId:null};await w.host.action(await w.request("dispatch-reconcile",native));assert.equal((await b.controls(null).inspect()).paused,true);
 const resume:DispatchRequest={...native,requestId:"resume",expectedRevision:revision,action:"resume-dispatch"};w.authority!.dispatch!.requestDigests=[...w.authority!.dispatch!.requestDigests,dispatchRequestDigest(resume)];await w.host.action(await w.request("dispatch",resume));assert.equal((await b.controls(null).inspect()).paused,false);
});
test("actual dashboard legacy cancellation reaches only original experiment handles and never retries a delivery",async()=>{
 const w=await hostWorld(false,"experiment"),original=w.experiment!,run=await original.controller.start(await prepareDigestProfile(original.budget));
 try{assert.deepEqual(await Promise.all(run.started),["spawned","spawned"]);const cancellation:ExperimentCancellation={version:"experiment-cancel-v1",requestId:"cancel:one",bindingDigest:experimentBindingDigest(original.controller.binding),executionId:"exec:1"};
  const legacy:DispatchRequest={version:"1.0",requestId:cancellation.requestId,bindingDigest:w.config.budgetDigest,expectedRevision:0,action:"cancel-execution",targetExecutionId:cancellation.executionId};w.authority!.dispatch!.requestDigests=[dispatchRequestDigest(legacy)];w.authority!.experiment!.cancellationDigests=[experimentCancellationDigest(cancellation)];
  const request=await w.request("cancel",{dispatch:legacy,cancellation});await w.host.action(request);const result=await run.completion;assert.equal(result.variants[1].state,"cancelled");assert.equal(result.budget!.active,0);assert.equal(result.budget!.attempts,2);assert.equal((await run.primary).state,"completed");
  const path=join(original.controller.binding.directory,"experiment.jsonl"),bytes=await readFile(path);await w.host.action(request);await w.reopen().frame();assert.deepEqual(await readFile(path),bytes);
  assert.throws(()=>openDashboardHost({...w.options,experiment:{...original.controller} as never}),/original controller/);
 }finally{await run.completion;}
});
test("actual case writer effect followed by lost acknowledgement does not become dashboard success",async()=>{
 const w=await hostWorld(false);await w.pause();const host=w.host;await present(w,host);let fired=false;const original=fs.fsyncSync;
 fs.fsyncSync=((fd:number)=>{const path=fs.readlinkSync('/proc/self/fd/'+fd);if(!fired&&path.startsWith(w.archiveRoot)&&path.endsWith('/history.jsonl')){fired=true;throw Error("fixture lost case acknowledgement");}return original(fd);}) as typeof fs.fsyncSync;syncBuiltinESMExports();
 try{await assert.rejects(host.action(await w.request("debrief","label 1 confirmed_defect")),/acknowledgement unknown/);}finally{fs.fsyncSync=original;syncBuiltinESMExports();}assert.ok(fired);assert.equal((await host.frame()).control,"failed");
 const first=w.api.createWorkSignalReviewer(w.archiveRoot,w.config.cases!.batchId,"operator").list(0,1).items[0];assert.equal(first.disposition,"confirmed_defect","effect remains independently readable despite failure");
});
test("ordinary public delegation retention reaches real archive semantic dashboard projection; missing bytes stay gaps",async()=>{
 const w=await hostWorld(false,"retention");const original=w.retention!,session=original.manifest.nativeSession.sessionPath!,sessionBytes=await readFile(session);
 const result:any=await w.host.action(await w.request("observe",{sourceId:"retention",previousCheckpointId:null,facts:null}));const view:any=await w.host.frame(),attempt=view.source.daily.attempts.find((a:any)=>a.executionId===original.manifest.identity.executionId);
 assert.ok(attempt);assert.equal(attempt.archive.runtime,"terminal");assert.equal(attempt.activeBranch,null);assert.equal(attempt.archive.toolCallIds[0],"call:retained");assert.ok(attempt.sourceAvailability.every((s:any)=>s.state==="available"));assert.equal(view.source.daily.progress,null);
 const snapshot=JSON.parse(w.api.readArchiveSource(w.archiveRoot,result.result.checkpointId).bytes.toString()),stdout=w.api.readArchiveSource(w.archiveRoot,snapshot.blobs.stdout);await rename(join(w.archiveRoot,"objects",stdout.reference.sha256),join(w.archiveRoot,"objects",stdout.reference.sha256+".preserved"));
 const changed:any=await w.host.frame();assert.ok(changed.source.daily.attempts[0].issues.some((s:string)=>/stdout|missing/.test(s)));await w.host.frame();assert.deepEqual(await readFile(session),sessionBytes);
});
test("exhausted existing trust budget defers weekly without refill or treating silence as a failed worker",async()=>{
 const w=await hostWorld(false);for(let i=0;i<5;i++)assert.equal(w.trust.expose('already-reserved:'+i,Date.now()).mode,'ask');await w.pause();const result:any=await present(w);assert.equal(result.result.state,'deferred');assert.equal(w.trust.inspect(Date.now()).attentionUsed,5);assert.equal((await w.host.frame()).control,'not-assessed');assert.equal((await w.reopen().frame()).debrief,null);
});
test("host requires actual loaded artifact identity, not a copied interface or caller pin",async()=>{
 const w=await hostWorld(false);assert.throws(()=>openDashboardHost({...w.options,harness:{...w.api}}),/verified loaded harness/);
 const manifest=JSON.parse(await readFile(join(w.root,"harness-artifact.json"),"utf8"));await appendFile(join(w.modules,"core.js"),"\n// changed owned artifact\n");await assert.rejects(loadDashboardHarness(w.modules,manifest,w.root),/digest mismatch/);
});
test("changed source policy refuses observation and stale exact dashboard request cannot steer",async()=>{
 const w=await hostWorld(false),r=await w.request("observe",{sourceId:"work",previousCheckpointId:null,facts:null});await appendFile(w.config.policyPath," ");await assert.rejects(w.host.action(r),/policy/);assert.equal((await w.reopen().frame()).control,"failed");
 const other=await hostWorld(false),stale=await other.request("defer",{reason:"old"});await other.host.action(await other.request("defer",{reason:"new"}));const bytes=await readFile(join(other.config.trustDirectory,"producer-host/events.jsonl"));await assert.rejects(other.reopen().action(stale),/stale/);assert.deepEqual(await readFile(join(other.config.trustDirectory,"producer-host/events.jsonl")),bytes);
});
