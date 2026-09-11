import assert from "node:assert/strict";
import { test,after } from "node:test";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { syncBuiltinESMExports } from "node:module";
import { readFile, appendFile, cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { hostWorld } from "./dashboard-host-world.ts";
import { hash } from "./debrief-durable-fixture.ts";
import { createDashboardHost, openDashboardHost, dashboardHostRequestDigest } from "../src/dashboard-host.ts";
import { openResourceBudget } from "../src/resource-budget.ts";
import { fixedIntentRequests } from "./intent-control-fixture.ts";
import { intentRequestDigest } from "../src/intent-control.ts";
import { serveDashboardHost, connectDashboardHost } from "../src/dashboard-host-transport.ts";
import { dashboardFrame, dashboardHostAction } from "../src/dashboard-cli.ts";
after(cleanupTempDirs);
test("actual dashboard consumes owned host projection without observing or steering on refresh",async()=>{
 const w=await hostWorld(),path=join(w.config.trustDirectory,"producer-host/events.jsonl"),before=await readFile(path);
 const rendered=await dashboardFrame({cwd:w.root,connected:w.host,dailyJson:true} as never);const view=JSON.parse(rendered);assert.equal(view.version,"producer-dashboard-frame-v1");assert.equal(view.workerInteractions,0);assert.equal(view.attention.attentionUsed,0);assert.equal(view.debrief,null);assert.deepEqual(await readFile(path),before);
});

const present=async(w:Awaited<ReturnType<typeof hostWorld>>,host=w.host)=>{const dispatchRevision=(await openResourceBudget(w.budget).controls(null).inspect()).revision;return host.action(await w.request("present",{userPresent:true,closing:true,evidenceDigest:w.presence.evidenceDigest,dispatchRevision}));};
test("real trust reservations and case/blind writers survive pause/reconnect; no automatic reveal or refill",async()=>{
 const w=await hostWorld();await w.pause();const prepared:any=await present(w);assert.equal(prepared.result.state,"prepared");
 const frame:any=await w.host.frame();assert.equal(frame.debrief.cards.length,5);assert.equal(frame.attention.attentionUsed,5);assert.equal(frame.debrief.cards.at(-1).revealed,null);
 await w.host.action(await w.request("presented",{frameDigest:prepared.result.frameDigest}));
 await dashboardHostAction(w.host,JSON.stringify(await w.request("debrief","label 1 skip")));assert.equal((await w.host.frame() as any).debrief.cards[0].resolution,"unresolved");
 const reopened=w.reopen();assert.equal((await reopened.frame()).debrief,null);await present(w,reopened);assert.equal((await reopened.frame() as any).debrief.cards.length,5);assert.equal(w.trust.inspect(Date.now()).attentionUsed,5);
 await reopened.action(await w.request("debrief","choose none"));assert.ok(w.api.openBlindIntervention(w.archiveRoot,w.config.blind!.comparisonId,"operator").quality());
 const reconnect=await w.request("present",{userPresent:true,closing:true,evidenceDigest:w.presence.evidenceDigest,dispatchRevision:1});
 const payload={root:w.root,modules:w.modules,config:w.config,budget:w.budget,authority:w.authority,presence:w.presence,request:reconnect};
 const code=`import{readFileSync}from'node:fs';import{loadDashboardHarness}from ${JSON.stringify(new URL("../src/dashboard-harness.ts",import.meta.url).href)};import{openDashboardHost}from ${JSON.stringify(new URL("../src/dashboard-host.ts",import.meta.url).href)};const p=JSON.parse(process.argv[1]),artifact=JSON.parse(readFileSync(p.root+'/harness-artifact.json'));const loaded=await loadDashboardHarness(p.modules,artifact,p.root),host=openDashboardHost({harness:loaded.api,config:p.config,budget:p.budget,authority:()=>p.authority,presence:()=>p.presence});await host.action(p.request);const f=await host.frame();console.log(JSON.stringify({used:f.attention.attentionUsed,cards:f.debrief.cards.length,quality:f.debrief.cards.at(-1).choiceConfirmed,revealed:f.debrief.cards.at(-1).revealed}));`;
 const env={...process.env};delete env.NODE_TEST_CONTEXT;const child=await promisify(execFile)(process.execPath,["--input-type=module","-e",code,JSON.stringify(payload)],{env,timeout:15000});assert.deepEqual(JSON.parse(child.stdout),{used:5,cards:5,quality:true,revealed:null});
 const again=w.reopen();await present(w,again);assert.equal((await again.frame() as any).debrief.cards.at(-1).revealed,null);await again.action(await w.request("debrief","reveal"));assert.ok((await again.frame() as any).debrief.cards.at(-1).revealed);
 assert.throws(()=>createDashboardHost(w.options),/EEXIST/);await assert.rejects(cp(w.config.trustDirectory,join(w.root,"copied-trust"),{recursive:true}).then(()=>openDashboardHost({...w.options,config:{...w.config,trustDirectory:join(w.root,"copied-trust")}})),/registration|binding|mismatch/);
});
test("host absence and uncertain close defer without attention, refreshed authority cannot be inferred",async()=>{
 const w=await hostWorld();await w.pause();w.presence.present=false;await present(w);assert.equal(w.trust.inspect(Date.now()).attentionUsed,0);assert.equal((await w.host.frame()).debrief,null);
 w.presence.present=true;await present(w);const bytes=await readFile(join(w.config.trustDirectory,"producer-host/events.jsonl"));w.presence.present=false;assert.equal((await w.host.frame()).debrief,null);assert.deepEqual(await readFile(join(w.config.trustDirectory,"producer-host/events.jsonl")),bytes);
 w.presence.present=true;w.authority=null;assert.equal((await w.host.frame()).debrief,null);
});
test("actual scoped source job captures checkpoints, nominates signals and projects current bytes without notes",async()=>{
 const w=await hostWorld(false);const captured:any=await w.host.action(await w.request("observe",{sourceId:"facts",previousCheckpointId:null,facts:null})),facts=captured.result.sourceManifestId;
 const r=await w.request("observe",{sourceId:"work",previousCheckpointId:null,facts});const result:any=await w.host.action(r);assert.ok(result.result.cases);const source:any=(await w.host.frame()).source;assert.equal(source.daily.obligations.length,2);assert.equal(source.daily.progress,null);assert.equal(source.observations.find((o:any)=>o.kind==="work").checkpointId,result.result.checkpointId);
 const journal=join(w.config.trustDirectory,"producer-host/events.jsonl"),before=await readFile(journal);await w.host.frame();assert.deepEqual(await readFile(journal),before);await w.host.action(r);assert.deepEqual(await readFile(journal),before);
 await appendFile(w.workPath,'{"partial":');const incomplete:any=await w.host.action(await w.request("observe",{sourceId:"work",previousCheckpointId:result.result.checkpointId,facts}));assert.equal(incomplete.result.cases,null);assert.ok(incomplete.result.metadata.semanticFailure);assert.equal((await w.host.frame() as any).source.daily.sources.work,"error");
});
test("dashboard routes real revision, priority and recorded alternative with native CAS and no grant expansion",async()=>{
 const w=await hostWorld(false),requests=fixedIntentRequests(w.budget);w.authority!.dispatch!.requestDigests=Object.values(requests).map(intentRequestDigest);
 await w.host.action(await w.request("intent",requests.revise));w.authority!.workContext={selectedSnapshot:w.w.selection(w.w.next),authority:null};
 assert.deepEqual((await openResourceBudget(w.budget).intentControls(null).inspect()).selection,w.w.selection(w.w.next));
 await w.host.action(await w.request("intent",requests.priority));await appendFile(w.workPath,w.w.recorded.map(e=>JSON.stringify(e)+"\n").join(""));
 await w.host.action(await w.request("intent",requests.alternative));w.authority!.workContext={selectedSnapshot:w.w.selection(w.w.alternative),authority:null};assert.deepEqual((await openResourceBudget(w.budget).intentControls(null).inspect()).selection,w.w.selection(w.w.alternative));
 const other=await hostWorld(false),expanded=fixedIntentRequests(other.budget).expand;other.authority!.dispatch!.requestDigests=[intentRequestDigest(expanded)];await assert.rejects(other.host.action(await other.request("intent",expanded)),/expansion/);assert.equal((await other.reopen().frame()).control,"failed");
});
test("concurrent exact host CAS admits one request; missing authority records denial without native action",async()=>{
 const w=await hostWorld(false),r=await w.request("defer",{reason:"weekly"},"one"),second={...r,requestId:"two"};w.authority!.requestDigests=[...w.authority!.requestDigests,dashboardHostRequestDigest(second)];
 const settled=await Promise.allSettled([w.host.action(r),w.reopen().action(second)]);assert.equal(settled.filter(r=>r.status==="fulfilled").length,1);
 const next=w.reopen(),request=await w.request("defer",{reason:"denied"});w.authority!.requestDigests=[];assert.equal((await next.action(request)).state,"denied");
});
test("human dashboard commands invoke only host-published exact approved actions",async()=>{
 const w=await hostWorld(false),request=await w.request("defer",{reason:"weekly"},"ui-defer");let current=request;w.authority!.requestDigests=[...w.authority!.requestDigests,dashboardHostRequestDigest(request)];
 const host=openDashboardHost({...w.options,humanActions:()=>[{key:"defer-weekly",label:"Defer cards until weekly review",request:current}]});
 const rendered=await dashboardFrame({cwd:w.root,connected:host} as never);assert.match(rendered,/defer-weekly — Defer cards until weekly review/);assert.doesNotMatch(rendered,/expectedTip|selectionDigest/);
 await assert.rejects(dashboardHostAction(host,"pause-everything"),/unknown dashboard action/);
 const remapped={...request,requestId:"ui-remapped",operation:"observe" as const,payload:{sourceId:"facts",previousCheckpointId:null,facts:null}};w.authority!.requestDigests=[...w.authority!.requestDigests,dashboardHostRequestDigest(remapped)];current=remapped;
 await assert.rejects(dashboardHostAction(host,"defer-weekly"),/displayed dashboard action changed/);
 current=request;const result:any=await dashboardHostAction(host,"defer-weekly");assert.equal(result.state,"acknowledged");
});

test("pre-effect stale CAS and immutable-ID refusals leave the original dashboard host usable",async()=>{
 const w=await hostWorld(false),stale=await w.request("defer",{reason:"stale"},"stale"),first=await w.request("defer",{reason:"first"},"first");await w.host.action(first);
 await assert.rejects(w.host.action(stale),/stale dashboard selection\/CAS/);assert.equal((await w.host.frame()).acknowledgement,"readback-only");await w.host.action(await w.request("defer",{reason:"after-stale"},"after-stale"));
 const original=await w.request("defer",{reason:"original"},"immutable");await w.host.action(original);const changed={...original,payload:{reason:"changed"}};w.authority!.requestDigests=[...w.authority!.requestDigests,dashboardHostRequestDigest(changed)];
 await assert.rejects(w.host.action(changed),/immutable dashboard request ID/);assert.equal((await w.host.frame()).acknowledgement,"readback-only");await w.host.action(await w.request("defer",{reason:"after-immutable"},"after-immutable"));
});
test("required final host sync failure remains failure after complete bytes and reconnect",async()=>{
 const w=await hostWorld(false),path=join(w.config.trustDirectory,"producer-host/events.jsonl"),original=fs.fsyncSync;let fired=false;
 fs.fsyncSync=((fd:number)=>{if(!fired&&fs.readlinkSync('/proc/self/fd/'+fd)===path&&fs.readFileSync(path,'utf8').trimEnd().split('\n').at(-1)!.includes('"result"')){fired=true;throw Error("fixture final host sync");}return original(fd);}) as typeof fs.fsyncSync;syncBuiltinESMExports();
 try{await assert.rejects(w.host.action(await w.request("defer",{reason:"weekly"})),/final host sync/);}finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 assert.ok(fired);assert.equal((await w.host.frame()).control,"failed");assert.equal((await w.reopen().frame()).control,"failed");assert.match(await readFile(path,"utf8"),/host-failure/);
});
test("private original-host socket serves actual dashboard frames and explicit approved requests",async()=>{
 const w=await hostWorld(false),short=await tempDir("pi-dh-","/tmp"),socket=join(short,"host.sock");await writeFile(join(w.root,"socket-location.json"),JSON.stringify({directory:short,socket}));
 const request=await w.request("defer",{reason:"weekly"},"socket-command");w.authority!.requestDigests=[...w.authority!.requestDigests,dashboardHostRequestDigest(request)];
 const host=openDashboardHost({...w.options,humanActions:()=>[{key:"defer-weekly",label:"Defer until weekly review",request}]});const server=await serveDashboardHost(socket,host);
 try{const remote=connectDashboardHost(socket),before=await readFile(join(w.config.trustDirectory,"producer-host/events.jsonl"));assert.equal(JSON.parse(await dashboardFrame({cwd:w.root,connected:remote,dailyJson:true})).version,"producer-dashboard-frame-v1");assert.deepEqual(await readFile(join(w.config.trustDirectory,"producer-host/events.jsonl")),before);
  const env={...process.env};delete env.NODE_TEST_CONTEXT;const cli=await promisify(execFile)(process.execPath,[new URL("../src/dashboard-cli.ts",import.meta.url).pathname,"--once","--daily-json","--host-socket",socket],{env,timeout:12000});assert.equal(JSON.parse(cli.stdout).version,"producer-dashboard-frame-v1");assert.deepEqual(await readFile(join(w.config.trustDirectory,"producer-host/events.jsonl")),before);
  const result=await dashboardHostAction(remote,"defer-weekly");assert.equal(result.state,"acknowledged");
 }finally{await server.close();}
});
