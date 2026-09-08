import assert from "node:assert/strict";
import { Compile } from "typebox/compile";
import promises from "node:fs/promises";
import { constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test,after } from "node:test";
import { writeFile,readFile } from "node:fs/promises";
import { join } from "node:path";
import { bindWorkIntent } from "../src/intent-application.ts";
import { createIntentBudget,openResourceBudget,resourceBindingDigest } from "../src/resource-budget.ts";
import { intentRequestDigest,type IntentRequest } from "../src/intent-control.ts";
import { selectionProposal } from "./intent-selection-fixture.ts";
import { hostDigest } from "./intent-control-fixture.ts";
import { tempDir,cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
test("versioned non-scope successors apply through original P01 controller without a fabricated scope revision",async()=>{
 const root=await tempDir("selection-apply-"),path=join(root,"work.jsonl"),p=selectionProposal();await writeFile(path,p.w.text,{mode:0o600});
 const intent=await bindWorkIntent({path,grantLedgerPath:null,selection:p.w.selection(p.w.base),priorities:p.w.priorities(p.w.obligations)});
 const budget=openResourceBudget(await createIntentBudget({directory:join(root,"budget"),authorityDigest:hostDigest,limits:{maxAttempts:4,maxInputBytes:100,maxConcurrent:2}},intent));
 const request={version:"intent-request-v2",requestId:"revise:entities",bindingDigest:resourceBindingDigest(budget.binding),expectedRevision:0,expectedSelection:intent.selection,action:"revise-selection",events:p.events,selection:p.selection,priorities:p.priorities} as unknown as IntentRequest;
 const schema=JSON.parse(await readFile(new URL("../contracts/intent-control/v2/request.schema.json",import.meta.url),"utf8")),legacy=JSON.parse(await readFile(new URL("../contracts/intent-control/v1/request.schema.json",import.meta.url),"utf8"));assert.deepEqual(schema.$defs,legacy.$defs);assert.ok(Compile(schema).Check(request));assert.equal(Compile(legacy).Check(request),false);
 const authority={authorityDigest:hostDigest,requestDigests:[intentRequestDigest(request)]};const controller=budget.intentControls(authority);
 const applied=await controller.request(request);assert.equal(applied.records[0].application,"applied");assert.deepEqual((await controller.inspect()).selection,p.selection);const bytes=await readFile(path,"utf8");
 assert.deepEqual(await controller.request(request),applied);assert.equal(await readFile(path,"utf8"),bytes);
 const old={...request,version:"intent-request-v1"};assert.throws(()=>intentRequestDigest(old as IntentRequest),/invalid/);
});
test("v2 still refuses permission/owner expansion and stale/denied authority; busy work needs original settlement",async t=>{
 for(const mode of ["effect","owner","stale","denied","busy"] as const)await t.test(mode,async()=>{
  const p=selectionProposal(mode==="effect"?{effect:"network"}:mode==="owner"?{owner:"other-owner"}:{}),root=await tempDir("selection-guard-"),path=join(root,"work");await writeFile(path,p.w.text,{mode:0o600});
  const initial=p.w.selection(p.w.base),priorities=p.w.priorities(p.w.obligations),intent=await bindWorkIntent({path,grantLedgerPath:null,selection:initial,priorities});
  const budget=openResourceBudget(await createIntentBudget({directory:join(root,"budget"),authorityDigest:hostDigest,limits:{maxAttempts:4,maxInputBytes:100,maxConcurrent:2}},intent));
  const request=JSON.parse(JSON.stringify({version:"intent-request-v2",requestId:mode,bindingDigest:resourceBindingDigest(budget.binding),expectedRevision:mode==="stale"?1:0,expectedSelection:initial,action:"revise-selection",events:p.events,selection:p.selection,priorities:p.priorities})) as IntentRequest;
  const controller=budget.intentControls({authorityDigest:hostDigest,requestDigests:mode==="denied"?[]:[intentRequestDigest(request)]});
  if(mode==="effect"||mode==="owner")await assert.rejects(controller.request(request),/expansion refused/);
  else if(mode==="busy"){
   const permit=await budget.reserve({attemptId:"held",orderId:"order",experimentId:"experiment",kind:"primary",parentAttemptId:null,inputBytes:1,inputDigest:"a".repeat(64)},{selection:initial,revision:0,obligation:priorities[0].obligation});
   let attempted=false;try{assert.equal((await controller.request(request)).records[0].application,"pending-or-unknown");assert.equal(await readFile(path,"utf8"),p.w.text);attempted=true;await permit.settle("completed");assert.equal((await controller.reconcile(request)).records[0].application,"applied");}finally{if(!attempted)await permit.settle("completed");}
  }else assert.equal((await controller.request(request)).records[0].decision,mode==="stale"?"stale":"authority-unavailable");
  if(mode!=="busy")assert.equal(await readFile(path,"utf8"),p.w.text);
 });
});
test("v2 required work sync failure retains complete prefix; duplicate reads and explicit native reconciliation differ",async()=>{
 const p=selectionProposal(),root=await tempDir("selection-sync-"),path=join(root,"work");await writeFile(path,p.w.text,{mode:0o600});const initial=p.w.selection(p.w.base),intent=await bindWorkIntent({path,grantLedgerPath:null,selection:initial,priorities:p.w.priorities(p.w.obligations)});
 const binding=await createIntentBudget({directory:join(root,"budget"),authorityDigest:hostDigest,limits:{maxAttempts:4,maxInputBytes:100,maxConcurrent:2}},intent),request=JSON.parse(JSON.stringify({version:"intent-request-v2",requestId:"sync",bindingDigest:resourceBindingDigest(binding),expectedRevision:0,expectedSelection:initial,action:"revise-selection",events:p.events,selection:p.selection,priorities:p.priorities})) as IntentRequest;
 const authority={authorityDigest:hostDigest,requestDigests:[intentRequestDigest(request)]},controller=openResourceBudget(binding).intentControls(authority),original=promises.open;let hit=false;
 promises.open=(async(...args:Parameters<typeof promises.open>)=>{const h=await original(...args);if(String(args[0])===path&&typeof args[1]==="number"&&(args[1]&constants.O_APPEND)){const sync=h.sync.bind(h);h.sync=async()=>{await sync();if(!hit){hit=true;throw Object.assign(Error("fixture lost successor sync"),{code:"EIO"});}};}return h;}) as typeof promises.open;syncBuiltinESMExports();
 try{await assert.rejects(controller.request(request),{code:"WORK_LEDGER_WRITE_FAILED"});}finally{promises.open=original;syncBuiltinESMExports();}
 assert.ok(hit);const prefix=await readFile(path,"utf8");assert.ok(prefix.length>p.w.text.length);assert.equal((await controller.request(request)).records[0].application,"pending-or-unknown");assert.equal(await readFile(path,"utf8"),prefix);
 const reopened=openResourceBudget(binding).intentControls(authority);assert.equal((await reopened.reconcile(request)).records[0].application,"applied");const complete=await readFile(path,"utf8");assert.ok(complete.startsWith(prefix));assert.equal((complete.match(/"eventId":"intent:goal:1:successor"/g)??[]).length,1);
});
