import { after, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { runChild } from "../src/run-child.ts";
import { createHash } from "node:crypto";
import { openResourceBudget, type BudgetSnapshot } from "../src/resource-budget.ts";
import { cleanupTempDirs } from "./tmp.ts";
import { ipcWorld as world, withIpcChild, ipcEmitter, ipcReferences } from "./producer-ipc-fixture.ts";
after(cleanupTempDirs);
test("actual isolated producer child supplies the exact bound host stream; original reservation settles once", async () => {
  const w = await world(), caller = new AbortController(); let calls = 0, text = "", held:BudgetSnapshot|null=null;
  const host = w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async (frames,context) => {
    calls++; assert.deepEqual(context.binding,w.binding); assert.equal(context.signal.aborted,false);
    held=await w.owner.controlSnapshot();assert.equal(held.active,1);
    for await (const chunk of frames) text += chunk.toString();
    return {claimRef:"claim:one",responseRef:"response:one"};
  }});
  const run = await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:caller.signal,timeoutMs:10000});
  const done = await run.completion;
  assert.equal(await run.started,"spawned"); assert.equal(await run.readiness,"frame-ready"); assert.equal(calls,1);
  assert.equal(text,JSON.stringify({id:"subject-1",sequence:1})+"\n"); assert.equal(done.outcome,"completed");
  assert.equal(done.settlement,"acknowledged"); assert.equal(done.child?.code,0); assert.equal(done.child?.text,text);
  assert.deepEqual(done.references,{claimRef:"claim:one",responseRef:"response:one"}); assert.equal(done.acceptance,"not-assessed");
  const budget = await w.owner.controlSnapshot(); assert.equal(budget.attempts,1); assert.equal(budget.inputBytes,w.demand.inputBytes); assert.equal(budget.active,0);
  assert.equal(budget.reservations[0].attemptId,w.binding.executionId); assert.equal(budget.reservations[0].inputDigest,w.ipc.producerIpcBindingDigest(w.binding));
  const journal=await readFile(join(w.budget.directory,"budget.jsonl"),"utf8"); assert.equal(journal.split('"type":"settle"').length-1,1);
  assert.ok(Object.isFrozen(done)); assert.ok(Object.isFrozen(await run.child)); assert.deepEqual(run.inspect(),done);
  await writeFile(join(w.budget.directory,"..","actual-ipc-proof.json"),JSON.stringify({scope:"inert local host, actual namespace child; not live qualification",binding:w.binding,demand:w.demand,held,settled:budget,frameText:text,hostCalls:calls,done},null,2),{flag:"wx",mode:0o600});
});

for (const field of ["owner","host","permit","charterSha256","invocationId","executionId"] as const) test(`wrong or copied ${field} cannot dispatch the actual child or host`, async()=>{
  await withIpcChild(ipcEmitter,async children=>{
    const w=await world();let calls=0;
    const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async()=>{calls++;return ipcReferences;}});
    const options={owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000};
    if(field==="owner")options.owner=openResourceBudget(w.budget);
    else if(field==="host")options.host={...host};
    else if(field==="permit")options.permit={...w.permit};
    else options.binding={...w.binding,[field]:field==="charterSha256"?"c".repeat(64):field==="executionId"?"exec:11111111-1111-4111-8111-111111111111":"other"};
    await assert.rejects(w.ipc.startProducerIpc(options),/original/);assert.equal(children.length,0);assert.equal(calls,0);
    assert.equal((await w.owner.inspect()).active,1);await w.permit.settle("cancelled");
  });
});

for (const [label,code] of Object.entries({
  id:"process.stdout.write('{\"id\":\"other\",\"sequence\":1}\\n')",
  sequence:"process.stdout.write('{\"id\":\"subject-1\",\"sequence\":2}\\n')",
  repeated:"const b=Buffer.from(process.argv[1],'base64');process.stdout.write(Buffer.concat([b,b]));",
  oversized:"process.stdout.write('x'.repeat(1025));",
  malformed:"process.stdout.write('{');",
  invalidUtf8:"process.stdout.write(Buffer.from([255]));",
  missingLf:"process.stdout.write(Buffer.from(process.argv[1],'base64').subarray(0,-1));",
  extraField:"process.stdout.write('{\"id\":\"subject-1\",\"sequence\":1,\"model\":\"forbidden\"}\\n');",
  noReadiness:"void 0;",
})) test(`actual child ${label} frame is rejected before host effects and remains charged`,async()=>{
  await withIpcChild(code,async children=>{
    const w=await world();let calls=0;
    const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async()=>{calls++;return ipcReferences;}});
    const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000});
    const done=await run.completion;assert.equal(children.length,1);assert.equal(await run.started,"spawned");assert.equal(await run.readiness,"not-ready");
    assert.equal(calls,0);assert.equal(done.outcome,"failed");assert.equal(done.settlement,"acknowledged");
    const state=await w.owner.controlSnapshot();assert.equal(state.attempts,1);assert.equal(state.inputBytes,w.demand.inputBytes);assert.equal(state.active,0);assert.equal(state.reservations[0].outcome,"failed");
    assert.deepEqual(JSON.parse(Buffer.from(children[0].argv.at(-1)!,"base64").toString()),{id:"subject-1",sequence:1});assert.deepEqual(children[0].env,{});
    for(const secret of [w.binding.charterSha256,w.binding.budgetDigest,w.binding.executionId])assert.equal(children[0].argv.some(a=>a.includes(secret)),false);
  });
});

test("complete-looking actual bytes without original EOF observation cannot dispatch",async()=>{
  await withIpcChild(ipcEmitter,async()=>{
    const w=await world();let calls=0;const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async()=>{calls++;return ipcReferences;}});
    const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000});
    const done=await run.completion;assert.equal(done.child?.code,0);assert.equal(done.child?.text,JSON.stringify({id:"subject-1",sequence:1})+"\n");assert.equal(done.reason,"FRAME_INVALID");assert.equal(calls,0);
  },{dropEof:true});
});

test("the reserved input bytes and digest name the complete parent binding, not a differently hashed child frame",async()=>{
  const w=await world(),bytes=Buffer.from(JSON.stringify(w.ipc.producerIpcBinding(w.binding)));
  assert.equal(w.demand.inputBytes,bytes.length);assert.equal(w.demand.inputDigest,createHash("sha256").update(bytes).digest("hex"));
  await w.permit.settle("cancelled");
});

test("opt-in root and subpath exports expose the same original bridge, without a model/runtime option",async()=>{
  const w=await world(),root=await import("../src/index.ts"),pkg=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8"));
  assert.equal("createProducerIpcHost" in root,true);assert.deepEqual(pkg.exports["./producer-ipc"],{types:"./dist/producer-ipc.d.ts",default:"./dist/producer-ipc.js"});
  const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async()=>ipcReferences});
  await assert.rejects(w.ipc.startProducerIpc({...{owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000},model:"forbidden"} as Parameters<typeof w.ipc.startProducerIpc>[0]),/closed/);
  for(const bad of [{...w.binding,invocationId:"x".repeat(129)},{...w.binding,sequence:1},{...w.binding,charterSha256:"unbound"}])assert.throws(()=>w.ipc.producerIpcBinding(bad));
  await w.permit.settle("cancelled");
});

test("already settled original reservations cannot be reassigned to a fresh host port",async()=>{
  await withIpcChild(ipcEmitter,async children=>{
    const w=await world();await w.permit.settle("completed");
    const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async()=>ipcReferences});
    await assert.rejects(w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000}),/original/);assert.equal(children.length,0);assert.equal((await w.owner.inspect()).attempts,1);
  });
});

test("an original reservation for different input cannot be relabelled as an IPC capability",async()=>{
  const w=await world(),binding={...w.binding,executionId:"exec:22222222-2222-4222-8222-222222222222"},demand={...w.ipc.producerIpcDemand(binding),inputDigest:"c".repeat(64)};
  const [permit]=await w.owner.reserveBatch([demand]),host=w.ipc.createProducerIpcHost({owner:w.owner,binding,exchange:async()=>ipcReferences});
  await assert.rejects(w.ipc.startProducerIpc({owner:w.owner,permit,binding,host,signal:new AbortController().signal,timeoutMs:10000}),/original/);
  assert.equal((await w.owner.inspect()).active,2);await permit.settle("cancelled");await w.permit.settle("cancelled");
});

test("EOF observers cannot replace the ordinary original result when they throw",async()=>{
  let ends=0;const child=await runChild({command:process.execPath,args:["-e","process.stdout.write('ordinary')"],env:{},cwd:"/",timeoutMs:3000,onStreamEnd:()=>{ends++;throw Error("inert observer");}});
  assert.equal(ends,2);assert.equal(child.code,0);assert.equal(child.text,"ordinary");assert.equal(child.aborted,false);
});

test("binding identifiers and hashes cannot hide a final line terminator",async()=>{
  const w=await world();
  for(const field of ["charterSha256","budgetDigest","executionId","invocationId","orderId","experimentId"] as const)assert.throws(()=>w.ipc.producerIpcBinding({...w.binding,[field]:w.binding[field]+"\n"}));
  await w.permit.settle("cancelled");
});

test("host reference byte bounds include a final line terminator after actual IPC",async()=>{
  const w=await world();const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async frames=>{for await(const _ of frames){}return {claimRef:"c",responseRef:"r".repeat(128)+"\n"};}});
  const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000});
  const done=await run.completion;assert.equal(done.reason,"HOST_FAILED");assert.equal(done.references,null);assert.equal(done.child?.code,0);
});

test("host references alone cannot substitute consumption of the actual frame stream",async()=>{
  const w=await world();const host=w.ipc.createProducerIpcHost({owner:w.owner,binding:w.binding,exchange:async()=>ipcReferences});
  const run=await w.ipc.startProducerIpc({owner:w.owner,permit:w.permit,binding:w.binding,host,signal:new AbortController().signal,timeoutMs:10000});
  const done=await run.completion;assert.equal(done.outcome,"failed");assert.equal(done.reason,"HOST_FAILED");assert.deepEqual(done.references,ipcReferences);
});
