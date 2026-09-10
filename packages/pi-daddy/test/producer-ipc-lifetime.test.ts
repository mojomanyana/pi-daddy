import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import type { Readable } from "node:stream";
import { dispatchRequestDigest, type DispatchRequest } from "../src/dispatch-control.ts";
import { ipcWorld, withIpcChild, ipcEmitter, ipcReferences } from "./producer-ipc-fixture.ts";
import { cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
const drain=async(frames:Readable)=>{for await(const _ of frames){/* inert host consumes the original bounded pipe replay */}};
function gate<T>() {let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const pauseFor=(w:Awaited<ReturnType<typeof ipcWorld>>):DispatchRequest=>({version:"1.0",requestId:"pause-ipc",bindingDigest:w.binding.budgetDigest,expectedRevision:0,action:"pause-dispatch",targetExecutionId:null});

test("pre-aborted original caller launches nothing and the existing failed attempt is not refunded",async()=>{
  await withIpcChild(ipcEmitter,async children=>{
    const w=await ipcWorld(),caller=new AbortController();caller.abort();let calls=0;
    const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async()=>{calls++;return ipcReferences;}});
    const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:caller.signal,timeoutMs:10000});
    const done=await run.completion;assert.equal(done.outcome,"cancelled");assert.equal(done.child,null);assert.equal(await run.started,"not-spawned");assert.equal(await run.readiness,"not-ready");assert.equal(calls,0);assert.equal(children.length,0);
    const state=await w.owner.inspect();assert.equal(state.attempts,1);assert.equal(state.inputBytes,w.demand.inputBytes);assert.equal(state.active,0);
  });
});

for(const trigger of ["cancelled","timed-out"] as const)test(`actual live child remains held after ${trigger} observation until original exit`,async()=>{
  await withIpcChild("setInterval(()=>{},1000);",async children=>{
    const w=await ipcWorld(),caller=new AbortController();let calls=0;
    const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async()=>{calls++;return ipcReferences;}});
    const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:caller.signal,timeoutMs:3000});
    assert.equal(await run.started,"spawned");assert.equal(children.length,1);if(trigger==="cancelled")caller.abort();
    const observed=await run.result;assert.equal(observed.outcome,trigger);assert.equal(observed.childState,"pending");assert.equal(observed.settlement,"pending");
    assert.equal(children[0].child.exitCode,null);assert.equal(children[0].child.signalCode,null);assert.doesNotThrow(()=>process.kill(children[0].child.pid!,0));
    assert.equal((await w.owner.controlSnapshot()).active,1);await assert.rejects(w.permit.settle("completed"),/handed to IPC/);
    assert.equal((await w.owner.inspect()).active,1);assert.equal(calls,0);
    children[0].release();const done=await run.completion;assert.equal(done.outcome,trigger);assert.equal(done.child?.signal,"SIGKILL");assert.equal(done.child?.aborted,true);assert.equal(done.settlement,"acknowledged");assert.equal(await run.readiness,"not-ready");
    assert.equal((await w.owner.inspect()).active,0);assert.equal((await w.owner.inspect()).attempts,1);assert.equal(children.length,1);
  },{deferKills:true});
});

test("host timeout retains the resource hold after actual child exit; late acknowledgement cannot upgrade failure",async()=>{
  const w=await ipcWorld(),entered=gate<AbortSignal>(),finish=gate<typeof ipcReferences>();let calls=0;
  const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async(frames,context)=>{calls++;await drain(frames);entered.resolve(context.signal);return finish.promise;}});
  const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:3000});
  try {
    const signal=await entered.promise;assert.equal((await run.child)?.code,0);assert.equal(await run.readiness,"frame-ready");
    const observed=await run.result;assert.equal(observed.outcome,"timed-out");assert.equal(observed.hostState,"pending");assert.equal(signal.aborted,true);
    assert.equal((await w.owner.controlSnapshot()).active,1);assert.equal(calls,1);
  } finally {finish.resolve(ipcReferences);}
  const done=await run.completion;assert.equal(done.outcome,"timed-out");assert.deepEqual(done.references,ipcReferences);assert.equal(done.hostState,"acknowledged");assert.equal(done.settlement,"acknowledged");assert.equal((await w.owner.inspect()).reservations[0].outcome,"failed");
  assert.equal((await run.result).references,null);assert.equal((await w.owner.inspect()).attempts,1);
});

test("original source cancellation reaches host I/O; busy admission reconciliation waits for acknowledgement",async()=>{
  const w=await ipcWorld(),caller=new AbortController(),entered=gate<AbortSignal>(),finish=gate<typeof ipcReferences>();let calls=0;
  const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async(frames,context)=>{calls++;await drain(frames);entered.resolve(context.signal);return finish.promise;}});
  const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:caller.signal,timeoutMs:10000});
  const request=pauseFor(w),control=w.owner.controls({authorityDigest:w.budget.authorityDigest,requestDigests:[dispatchRequestDigest(request)]});
  try {
    const signal=await entered.promise;const pending=await control.request(request);assert.equal(pending.records[0].application,"pending");
    caller.abort();assert.equal((await run.result).outcome,"cancelled");assert.equal(signal.aborted,true);
    assert.equal((await control.reconcile(request.requestId)).records[0].application,"pending");assert.equal((await w.owner.controlSnapshot()).active,1);
    await assert.rejects(w.owner.reserve({...w.demand,attemptId:"another-attempt"}),{code:"DISPATCH_BLOCKED"});
  } finally {finish.resolve(ipcReferences);}
  const done=await run.completion;assert.equal(done.outcome,"cancelled");assert.equal(done.child?.code,0);assert.deepEqual(done.references,ipcReferences);assert.equal(calls,1);
  assert.equal((await control.inspect()).records[0].application,"pending");assert.equal((await control.reconcile(request.requestId)).paused,true);
  await assert.rejects(w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:caller.signal,timeoutMs:10000}),/original/);
  await assert.rejects(w.owner.reserveBatch([w.demand]));assert.equal((await w.owner.inspect()).attempts,1);
});

test("a pending original admission barrier prevents launch of an already reserved IPC attempt",async()=>{
  await withIpcChild(ipcEmitter,async children=>{
    const w=await ipcWorld(),request=pauseFor(w),control=w.owner.controls({authorityDigest:w.budget.authorityDigest,requestDigests:[dispatchRequestDigest(request)]});
    await control.request(request);let calls=0;const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async()=>{calls++;return ipcReferences;}});
    const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000});
    const done=await run.completion;assert.equal(done.reason,"ADMISSION_FAILED");assert.equal(done.child,null);assert.equal(children.length,0);assert.equal(calls,0);
    assert.equal((await w.owner.inspect()).attempts,1);assert.equal((await w.owner.inspect()).reservations[0].outcome,"failed");assert.equal((await control.inspect()).records[0].application,"pending");
    assert.equal((await control.reconcile(request.requestId)).paused,true);
  });
});

for(const operation of ["sync","close"] as const)test(`required settlement ${operation} failure survives complete journal bytes and successful IPC`,async()=>{
  const w=await ipcWorld(),original=fs.open,path=join(w.budget.directory,"budget.jsonl");let armed=false,forced=0;
  fs.open=(async(...args:Parameters<typeof fs.open>)=>{
    const file=await original(...args);
    if(armed&&String(args[0])===path){armed=false;const perform=file[operation].bind(file);file[operation]=async()=>{await perform();forced++;throw Error("inert required accounting failure");};}
    return file;
  }) as typeof fs.open;syncBuiltinESMExports();
  try {
    const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async frames=>{await drain(frames);armed=true;return ipcReferences;}});
    const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000}),done=await run.completion;
    assert.equal(forced,1);assert.equal(done.outcome,"completed");assert.equal(done.settlement,"failed-or-unknown");assert.deepEqual(done.references,ipcReferences);assert.equal(done.child?.code,0);
    assert.equal((await w.owner.inspect()).active,0,"visible bytes are not acknowledgement");assert.equal(run.inspect().settlement,"failed-or-unknown");
    const bytes=await fs.readFile(path,"utf8");assert.equal(bytes.split('"type":"settle"').length-1,1);await assert.rejects(w.permit.settle("completed"),/handed to IPC/);
    assert.equal((await w.owner.inspect()).attempts,1);
  } finally {fs.open=original;syncBuiltinESMExports();}
});

test("in-progress original settlement cannot race an IPC handoff",async()=>{
  const w=await ipcWorld(),host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async()=>ipcReferences});
  const settling=w.permit.settle("failed");
  try {await assert.rejects(w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000}),/original/);} finally {await settling;}
  assert.equal((await w.owner.inspect()).attempts,1);
});

test("changed persisted input digest refuses original admission before actual child or host dispatch",async()=>{
  await withIpcChild(ipcEmitter,async children=>{
    const w=await ipcWorld(),path=join(w.budget.directory,"budget.jsonl"),before=await fs.readFile(path,"utf8");let calls=0;
    const after=before.replace(w.demand.inputDigest,"d".repeat(64));assert.notEqual(after,before);await fs.writeFile(path,after);
    const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async frames=>{calls++;await drain(frames);return ipcReferences;}});
    const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000}),done=await run.completion;
    assert.equal(done.reason,"ADMISSION_FAILED");assert.equal(children.length,0);assert.equal(calls,0);assert.equal((await w.owner.inspect()).attempts,1);
  });
});

test("an actual spawn error is not labelled as an observed child exit and never invokes the host",async()=>{
  await withIpcChild(ipcEmitter,async children=>{
    const w=await ipcWorld();let calls=0;const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async()=>{calls++;return ipcReferences;}});
    const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000}),done=await run.completion;
    assert.equal(children.length,1);assert.equal(children[0].child.pid,undefined);assert.match(done.child?.spawnError??"",/ENOENT/);
    assert.equal(await run.started,"not-spawned");assert.equal(done.childState,"not-spawned");assert.equal(done.outcome,"failed");assert.equal(calls,0);assert.equal((await w.owner.inspect()).attempts,1);
  },{spawnError:true});
});

test("an exception after actual spawn cannot fabricate settlement or release the reservation",async()=>{
  await withIpcChild(ipcEmitter,async children=>{
    const w=await ipcWorld();let calls=0;const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async()=>{calls++;return ipcReferences;}});
    const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000}),done=await run.completion;
    assert.equal(await run.started,"spawned");assert.equal(children.length,1);assert.equal(done.reason,"RUNTIME_FAILED");assert.equal(done.child,null);
    assert.equal(done.childState,"unknown");assert.equal(done.settlement,"failed-or-unknown");assert.equal((await w.owner.controlSnapshot()).active,1);assert.equal(calls,0);
    await assert.rejects(w.permit.settle("completed"),/handed to IPC/);
  },{afterSpawnFailure:true});
});

test("host failure preserves actual child output and cannot retry or reinterpret a reservation",async()=>{
  const w=await ipcWorld();let calls=0;const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async frames=>{calls++;await drain(frames);throw Error("inert host failure");}});
  const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000});
  const done=await run.completion;assert.equal(done.reason,"HOST_FAILED");assert.equal(done.child?.code,0);assert.equal(done.child?.text,JSON.stringify({id:"subject-1",sequence:1})+"\n");assert.equal(calls,1);
  const freshHost=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async()=>{calls++;return ipcReferences;}});
  await assert.rejects(w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host:freshHost,signal:new AbortController().signal,timeoutMs:10000}),/original/);
  await assert.rejects(w.owner.reserveBatch([w.demand]),{code:"DUPLICATE"});assert.equal(calls,1);
});
