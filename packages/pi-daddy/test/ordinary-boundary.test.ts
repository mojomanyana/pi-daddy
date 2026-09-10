import assert from "node:assert/strict";
import { test,after } from "node:test";
import { readFile } from "node:fs/promises";
import promises from "node:fs/promises";
import fs,{constants} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { ordinaryHostFixture } from "./ordinary-host-fixture.ts";
import { hostWorld } from "./dashboard-host-world.ts";
import { selectionProposal } from "./intent-selection-fixture.ts";
import { tempDir,cleanupTempDirs } from "./tmp.ts";
import { intentRequestDigest,type IntentRequest } from "../src/intent-control.ts";
import { openResourceBudget } from "../src/resource-budget.ts";
import { openDashboardHost } from "../src/dashboard-host.ts";
import { associateOrdinaryHost, holdOrdinaryDispatch, ordinaryChildrenFor, retainOrdinaryChild } from "../src/ordinary-children.ts";
after(cleanupTempDirs);
const occurrence=(executionId:string)=>({executionId:`exec:${executionId}`,parentExecutionId:null,toolCallId:null});
test("best-effort observation failure permits quiescence while required failure and unknown ownership refuse without a hold",()=>{
 const bestSession={},bestHost={};associateOrdinaryHost(bestHost,bestSession);const best=ordinaryChildrenFor(bestSession),observed=retainOrdinaryChild(best,occurrence("00000000-0000-4000-8000-000000000001"))!;
 observed.settle({ok:true},"failed","not-assessed");assert.equal(best.quiescent(),true);const ready=holdOrdinaryDispatch(best,"a".repeat(64));assert.equal(ready.ready(),true);ready.release();
 for(const [suffix,control] of [["2","failed"],["3","unknown"]] as const){const session={},host={};associateOrdinaryHost(host,session);const port=ordinaryChildrenFor(session),child=retainOrdinaryChild(port,occurrence(`00000000-0000-4000-8000-00000000000${suffix}`))!;child.settle({ok:false},control);
  assert.equal(port.quiescent(),false);assert.throws(()=>holdOrdinaryDispatch(port,"b".repeat(64)),/unavailable; no recovery/);assert.equal((port.inspect() as any).admission,"open");assert.ok(retainOrdinaryChild(port,occurrence(`00000000-0000-4000-8000-00000000001${suffix}`)),"an unavailable boundary must not install a global hold");}
});
test("P05 intent direction waits for actual attached ordinary child and explicit original-boundary reconciliation",async()=>{
 const child=await ordinaryHostFixture(await tempDir("ordinary-direction-"));try{
  const w=await hostWorld(false,"signals",child.port),p=selectionProposal(),done=child.run("held");await child.ready("held");const before=await readFile(w.workPath,"utf8");
  const native=JSON.parse(JSON.stringify({version:"intent-request-v2",requestId:"busy:direction",bindingDigest:w.config.budgetDigest,expectedRevision:0,expectedSelection:w.config.selection,action:"revise-selection",events:p.events,selection:p.selection,priorities:p.priorities})) as IntentRequest;
  w.authority!.dispatch!.requestDigests=[intentRequestDigest(native)];const request=await w.request("intent",native),pending=await w.host.action(request);
  assert.equal(await readFile(w.workPath,"utf8"),before,"a busy attached ordinary child must not receive an applied selection");assert.equal((pending.result as any).state,"pending-ordinary-boundary");
  const blocked=await child.run("blocked");assert.match(String(blocked.error),/ordinary dispatch held/,"new ordinary dispatch must remain held");assert.equal((child.port.inspect() as any).children.length,1);
  const framed=await w.host.frame();assert.ok(framed.requests.some(r=>r.type==="ordinary-intent-pending"&&r.nativeRequestId===native.requestId));await w.reopen().action(request);assert.equal(await readFile(w.workPath,"utf8"),before);assert.equal((await w.host.frame()).tip,framed.tip);
  await child.close();assert.equal((await done).error.code,"CHILD_CANCELLED");assert.equal(await readFile(w.workPath,"utf8"),before,"settlement does not auto-apply");
  const reconciled=await w.host.action(await w.request("intent-reconcile",native));assert.equal((reconciled.result as any).records[0].application,"applied");assert.notEqual(await readFile(w.workPath,"utf8"),before);assert.equal((child.port.inspect() as any).admission,"open");
 }finally{await child.close();}
});
async function direction(w:Awaited<ReturnType<typeof hostWorld>>){const p=selectionProposal(),native=JSON.parse(JSON.stringify({version:"intent-request-v2",requestId:"direction",bindingDigest:w.config.budgetDigest,expectedRevision:0,expectedSelection:w.config.selection,action:"revise-selection",events:p.events,selection:p.selection,priorities:p.priorities})) as IntentRequest;w.authority!.dispatch!.requestDigests=[intentRequestDigest(native)];return {native,request:await w.request("intent",native)};}
test("original admission remains held across awaited native work sync until final host acknowledgement",async()=>{
 const child=await ordinaryHostFixture(await tempDir("ordinary-atomic-")),original=promises.open;let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);let action:Promise<unknown>|undefined,hit=false;
 try{const w=await hostWorld(false,"signals",child.port),d=await direction(w);promises.open=(async(...args:Parameters<typeof promises.open>)=>{const h=await original(...args);if(String(args[0])===w.workPath&&typeof args[1]==="number"&&(args[1]&constants.O_APPEND)){const sync=h.sync.bind(h);h.sync=async()=>{await sync();if(!hit){hit=true;entered();await gate;}};}return h;}) as typeof promises.open;syncBuiltinESMExports();action=w.host.action(d.request);const observed=action.then(()=>{throw Error("native action settled before barrier");});void observed.catch(()=>{});await Promise.race([ready,observed]);
  assert.match(String((await child.run("blocked")).error),/ordinary dispatch held/);assert.equal((child.port.inspect() as any).admission,"held-by-original-owner");release();await action;assert.equal((child.port.inspect() as any).admission,"open");assert.equal((await child.run("fast")).value.details.exitCode,0);
 }finally{release();promises.open=original;syncBuiltinESMExports();await action?.catch(()=>{});await child.close();}
});
test("failed final host acknowledgement keeps original dispatch held despite applied P01 bytes and reconnect",async()=>{
 const child=await ordinaryHostFixture(await tempDir("ordinary-ack-")),original=fs.fsyncSync;let count=0;
 try{const w=await hostWorld(false,"signals",child.port),d=await direction(w),before=await readFile(w.workPath,"utf8");fs.fsyncSync=((fd:number)=>{original(fd);if(fs.readlinkSync('/proc/self/fd/'+fd)===w.config.trustDirectory+'/producer-host/events.jsonl'&&++count===2)throw Error("lost original boundary acknowledgement");}) as typeof fs.fsyncSync;syncBuiltinESMExports();
  await assert.rejects(w.host.action(d.request),/boundary acknowledgement/);fs.fsyncSync=original;syncBuiltinESMExports();assert.notEqual(await readFile(w.workPath,"utf8"),before);assert.equal((child.port.inspect() as any).admission,"held-by-original-owner");assert.match(String((await child.run("blocked")).error),/ordinary dispatch held/);await w.reopen().action(d.request);assert.equal((await w.reopen().frame()).control,"failed");assert.equal((child.port.inspect() as any).admission,"held-by-original-owner");
 }finally{fs.fsyncSync=original;syncBuiltinESMExports();await child.close();}
});
test("native reservation pending keeps ordinary admission held until both original boundaries and explicit reconcile",async()=>{
 const child=await ordinaryHostFixture(await tempDir("ordinary-resource-"));let settle:(()=>Promise<void>)|undefined,attempted=false;
 try{const w=await hostWorld(false,"signals",child.port),d=await direction(w),budget=openResourceBudget(w.budget),state=await budget.intentControls(null).inspect(),before=await readFile(w.workPath,"utf8");
  const permit=await budget.reserve({attemptId:"held",orderId:"order",experimentId:"experiment",kind:"primary",parentAttemptId:null,inputBytes:1,inputDigest:"a".repeat(64)},{selection:state.selection,revision:state.revision,obligation:state.nextObligation!});settle=()=>permit.settle("completed");
  const result=await w.host.action(d.request);assert.equal((result.result as any).records[0].application,"pending-or-unknown");assert.equal((child.port.inspect() as any).admission,"held-by-original-owner");assert.equal(await readFile(w.workPath,"utf8"),before);attempted=true;await settle();assert.equal(await readFile(w.workPath,"utf8"),before);
  await w.host.action(await w.request("intent-reconcile",d.native));assert.equal((child.port.inspect() as any).admission,"open");assert.notEqual(await readFile(w.workPath,"utf8"),before);
 }finally{if(settle&&!attempted)await settle();await child.close();}
});
test("reconciliation cannot create an unrequested direction merely because an ordinary child is busy",async()=>{
 const child=await ordinaryHostFixture(await tempDir("ordinary-no-request-"));try{const w=await hostWorld(false,"signals",child.port),d=await direction(w);const done=child.run("held");await child.ready("held");const before=await readFile(w.workPath,"utf8");
  await assert.rejects(w.host.action(await w.request("intent-reconcile",d.native)),/original pending intent required/);assert.equal(await readFile(w.workPath,"utf8"),before);assert.equal((child.port.inspect() as any).admission,"open");await child.close();assert.equal((await done).error.code,"CHILD_CANCELLED");
 }finally{await child.close();}
});
test("a pending-shaped journal row without its approved original request cannot authorize first application",async()=>{
 const child=await ordinaryHostFixture(await tempDir("ordinary-forged-pending-"));try{const w=await hostWorld(false,"signals",child.port),d=await direction(w),journal=w.api.learningJournal(w.config.trustDirectory+'/producer-host'),before=await readFile(w.workPath,"utf8");journal.append(journal.read().at(-1)!.id,{type:"ordinary-intent-pending",nativeRequestId:d.native.requestId,digest:intentRequestDigest(d.native),hostRequestId:"missing-original"});
  await assert.rejects(w.host.action(await w.request("intent-reconcile",d.native)),/unbound ordinary pending transport/);assert.equal(await readFile(w.workPath,"utf8"),before);assert.equal((child.port.inspect() as any).admission,"open");
 }finally{await child.close();}
});
for(const mode of ["missing-original","native-denied"] as const)test(`ordinary intent boundary refuses ${mode} without applying or inventing a handle`,async()=>{
 const child=await ordinaryHostFixture(await tempDir("ordinary-refuse-"));try{const w=await hostWorld(false,"signals",child.port),d=await direction(w),before=await readFile(w.workPath,"utf8");const host=mode==="missing-original"?openDashboardHost({...w.options,ordinary:undefined}):w.host;if(mode==="native-denied")w.authority!.dispatch=null;
  await assert.rejects(host.action(d.request),mode==="missing-original"?/original ordinary boundary unavailable/:/native intent authority/);assert.equal(await readFile(w.workPath,"utf8"),before);assert.equal((child.port.inspect() as any).admission,"open");
 }finally{await child.close();}
});
