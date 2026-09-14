import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createResourceBudget, openResourceBudget, resourceBindingDigest } from "../src/resource-budget.ts";
import { createMeasuredOrder, measuredOrderAcknowledgementDigest, measuredOrderDigest, openMeasuredOrder, type MeasuredOrder, type MeasuredOrderAuthority } from "../src/measured-order.ts";
import { intentKey } from "../src/intent-control.ts";
import { MeasuredSessionFailure, type MeasuredSessionHost } from "../src/measured-session.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
const sha=(x:string)=>createHash("sha256").update(x).digest("hex"),authorityDigest="a".repeat(64);
const result=(output:string)=>({output,usage:{input:2,output:1,cacheRead:0,cacheWrite:0,reasoning:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},provider:"openai-codex" as const,model:"gpt-5.6-sol" as const,stopReason:"stop" as const});

test("bounded read-only dependent order recovers only after exact unknown acknowledgement and preserves original accounting",async()=>{
 const root=await tempDir("measured-order-"),budget=await createResourceBudget({directory:join(root,"budget"),authorityDigest,limits:{maxAttempts:3,maxInputBytes:4096,maxConcurrent:3}});
 const attempt=(attemptId:string,prompt:string,expected:string)=>({attemptId,model:"openai-codex/gpt-5.6-sol" as const,thinkingLevel:"high" as const,prompt,deadlineMs:1000,terminationGraceMs:100,maxRetainedOutputBytes:1024,maxOutputTokens:64,includeDependencies:false,qualification:{version:"measured-output-exact-v1" as const,expectedSha256:sha(expected)}});
 const order:MeasuredOrder={version:"measured-order-v1",orderId:"c07-order",authorityDigest,budgetDigest:resourceBindingDigest(budget),nodes:[
  {nodeId:"draft",dependencies:[],attempts:[attempt("draft:1","produce draft","unused"),attempt("draft:2","recover draft","draft-ok")]},
  {nodeId:"review",dependencies:["draft"],attempts:[attempt("review:1","review fixed draft","review-ok")]}
 ]};
 const binding=await createMeasuredOrder({directory:join(root,"order"),budget,order}),orderDigest=measuredOrderDigest(order);let launches=0;
 const unknownHost:MeasuredSessionHost={run:async()=>{launches++;return await new Promise(()=>{});}};
 const firstAuthority:MeasuredOrderAuthority={authorityDigest,orderDigests:[orderDigest],acknowledgementDigests:[]},first=openMeasuredOrder(binding,firstAuthority,unknownHost),owned=first.advance();
 while(!launches)await new Promise(resolve=>setTimeout(resolve,5));
 const restarted=openMeasuredOrder(binding,firstAuthority,{run:async()=>{launches++;return result("should-not-launch");}});let view=await restarted.inspect();assert.equal(view.nodes[0].state,"unknown");assert.equal(view.nodes[1].state,"dependency-blocked");assert.equal(launches,1);
 const claim=view.nodes[0].unknownClaim!,ack={version:"measured-order-ack-v1" as const,requestId:"ack:draft:1",bindingDigest:binding.digest,attemptId:"draft:1",claimOwner:claim.owner,claimDigest:claim.digest};
 await assert.rejects(restarted.acknowledgeUnknown(ack,firstAuthority),/authority/);
 const recoveryAuthority={...firstAuthority,acknowledgementDigests:[measuredOrderAcknowledgementDigest(ack)]};await restarted.acknowledgeUnknown(ack,recoveryAuthority);await owned;
 const duplicate={...ack,requestId:"ack:draft:duplicate"},duplicateAuthority={...firstAuthority,acknowledgementDigests:[measuredOrderAcknowledgementDigest(duplicate)]};await assert.rejects(restarted.acknowledgeUnknown(duplicate,duplicateAuthority),/current unknown/);
 const recovered=openMeasuredOrder(binding,recoveryAuthority,{run:async input=>{launches++;return result(input.prompt==="recover draft"?"draft-ok":"review-ok");}});
 view=await recovered.advance();assert.equal(view.nodes[0].state,"satisfied");assert.equal(view.nodes[1].state,"eligible");
 view=await recovered.advance();assert.equal(view.nodes[1].state,"satisfied");assert.equal(launches,3);assert.equal(view.acceptance,"not-assessed");
 const accounting=await openResourceBudget(budget).inspect();assert.equal(accounting.active,1);assert.deepEqual(accounting.reservations.map(x=>x.state),["reserved","settled","settled"]);assert.deepEqual(accounting.reservations.map(x=>x.outcome),[null,"completed","completed"]);
});

test("free-form qualified output is sealed into the dependent review prompt without a pre-known artifact digest",async()=>{
 const root=await tempDir("measured-order-freeform-"),budget=await createResourceBudget({directory:join(root,"budget"),authorityDigest,limits:{maxAttempts:2,maxInputBytes:4096,maxConcurrent:2}}),draft=JSON.stringify({overview:"Operator-readable bulletin",alerts:[{id:"alert-1",fact:"source fact",summary:"free-form explanation"}]}),review=JSON.stringify({summary:"Independent deterministic-contract review",findings:[{code:"OK",detail:"The supplied alert is complete."}]});
 const projection=(value:unknown)=>sha(intentKey(value)),contract=(requiredKeys:string[],textFields:string[],arrayField:string,itemRequiredFields:string[],projectionFields:string[],expected:unknown)=>({version:"measured-output-json-projection-v1" as const,requiredKeys,textFields,arrayField,minItems:1,maxItems:4,itemRequiredFields,projectionFields,expectedProjectionSha256:projection(expected)});
 const order:MeasuredOrder={version:"measured-order-v1",orderId:"freeform",authorityDigest,budgetDigest:resourceBindingDigest(budget),nodes:[
  {nodeId:"draft",dependencies:[],attempts:[{attemptId:"free:draft",model:"openai-codex/gpt-5.6-sol",thinkingLevel:"high",prompt:"Create bulletin JSON",deadlineMs:1000,terminationGraceMs:100,maxRetainedOutputBytes:1024,maxOutputTokens:128,includeDependencies:false,qualification:contract(["overview","alerts"],["overview"],"alerts",["id","fact","summary"],["id","fact"],[{id:"alert-1",fact:"source fact"}])}]},
  {nodeId:"review",dependencies:["draft"],attempts:[{attemptId:"free:review",model:"openai-codex/gpt-5.6-terra",thinkingLevel:"high",prompt:"Review the sealed bulletin",deadlineMs:1000,terminationGraceMs:100,maxRetainedOutputBytes:1024,maxOutputTokens:128,includeDependencies:true,qualification:contract(["summary","findings"],["summary"],"findings",["code","detail"],["code"],[{code:"OK"}])}]}
 ]};
 let sealedPrompt="";const host:MeasuredSessionHost={run:async input=>{if(input.model.endsWith("terra")){sealedPrompt=input.prompt;return{...result(review),model:"gpt-5.6-terra"};}return result(draft);}},binding=await createMeasuredOrder({directory:join(root,"order"),budget,order}),authority:MeasuredOrderAuthority={authorityDigest,orderDigests:[measuredOrderDigest(order)],acknowledgementDigests:[]},controller=openMeasuredOrder(binding,authority,host);
 let view=await controller.advance();assert.equal(view.nodes[0].state,"satisfied");view=await controller.advance();assert.equal(view.nodes[1].state,"satisfied");assert.equal(view.nodes[1].outputSha256,sha(review));assert.match(sealedPrompt,new RegExp(sha(draft)));assert.ok(sealedPrompt.includes(draft));assert.equal(view.acceptance,"not-assessed");
});

test("fractional public provider costs persist through mismatch recovery and sealed dependency progress",async()=>{
 const root=await tempDir("measured-order-fractional-"),budget=await createResourceBudget({directory:join(root,"budget"),authorityDigest,limits:{maxAttempts:3,maxInputBytes:4096,maxConcurrent:3}});
 // Public fields copied from retained result-1.json; no credentials or provider transport data.
 const realResult={output:"{\"summary\":\"Verify adding and completing a task.\",\"checks\":[{\"id\":\"add\",\"action\":\"Enter a task title and click Add.\",\"expected\":\"The new task appears in the task list.\"},{\"id\":\"complete\",\"action\":\"Click the new task’s completion control.\",\"expected\":\"The task is marked completed.\"}]}",usage:{input:114,output:114,cacheRead:0,cacheWrite:0,reasoning:45,totalTokens:228,cost:{input:0.00022799999999999999,output:0.001368,cacheRead:0,cacheWrite:0,total:0.001596}},provider:"openai-codex" as const,model:"gpt-5.6-terra" as const,stopReason:"stop" as const},retainedResult={version:"measured-session-result-v1",state:"completed",model:"openai-codex/gpt-5.6-terra",thinkingLevel:"low",output:realResult.output,usage:realResult.usage,stopReason:"stop",acceptance:"not-assessed",grantExpansion:false};
 const recovered=JSON.stringify({summary:"Verify adding, completing, and deleting a task.",checks:[{id:"add",action:"Add the named task.",expected:"The task appears."},{id:"complete",action:"Complete the named task.",expected:"The task is completed."},{id:"delete",action:"Delete the named task.",expected:"The task is removed."}]}),contract={version:"measured-output-json-projection-v1" as const,requiredKeys:["summary","checks"],textFields:["summary"],arrayField:"checks",minItems:3,maxItems:3,itemRequiredFields:["id","action","expected"],projectionFields:["id"],expectedProjectionSha256:sha(intentKey([{id:"add"},{id:"complete"},{id:"delete"}]))};
 const attempt=(attemptId:string,prompt:string,includeDependencies=false)=>({attemptId,model:"openai-codex/gpt-5.6-terra" as const,thinkingLevel:"low" as const,prompt,deadlineMs:1000,terminationGraceMs:100,maxRetainedOutputBytes:2048,maxOutputTokens:64,includeDependencies,qualification:contract});
 const order:MeasuredOrder={version:"measured-order-v1",orderId:"fractional",authorityDigest,budgetDigest:resourceBindingDigest(budget),nodes:[{nodeId:"draft",dependencies:[],attempts:[attempt("fractional:original","original"),attempt("fractional:recovery","recovery")]},{nodeId:"review",dependencies:["draft"],attempts:[attempt("fractional:review","review",true)]}]},binding=await createMeasuredOrder({directory:join(root,"order"),budget,order}),authority={authorityDigest,orderDigests:[measuredOrderDigest(order)],acknowledgementDigests:[]};
 let sealed="";const host:MeasuredSessionHost={run:async input=>{if(input.prompt==="original")return realResult;if(input.prompt==="recovery")return{...realResult,output:recovered};sealed=input.prompt;return{...realResult,output:recovered};}},controller=openMeasuredOrder(binding,authority,host);
 let view=await controller.advance();assert.equal(view.nodes[0].state,"eligible");assert.equal(view.nodes[0].attemptId,"fractional:recovery");
 const firstResult=JSON.parse((await readFile(join(root,"order","journal.jsonl"),"utf8")).trimEnd().split("\n")[1]);assert.deepEqual(firstResult.result,retainedResult);assert.equal(firstResult.outputSha256,sha(realResult.output));
 view=await controller.advance();assert.equal(view.nodes[0].state,"satisfied");assert.equal(view.nodes[1].state,"eligible");view=await controller.advance();assert.equal(view.nodes[1].state,"satisfied");assert.ok(sealed.includes(recovered));assert.ok(sealed.includes(sha(recovered)));
});

test("reflection-throwing result evidence is terminally rejected without a running or unknown replay",async()=>{
 const root=await tempDir("measured-order-reflection-"),budget=await createResourceBudget({directory:join(root,"budget"),authorityDigest,limits:{maxAttempts:1,maxInputBytes:32,maxConcurrent:1}}),attempt={attemptId:"reflection:1",model:"openai-codex/gpt-5.6-sol" as const,thinkingLevel:"high" as const,prompt:"x",deadlineMs:1000,terminationGraceMs:100,maxRetainedOutputBytes:32,maxOutputTokens:8,includeDependencies:false,qualification:{version:"measured-output-exact-v1" as const,expectedSha256:sha("ok")}},order:MeasuredOrder={version:"measured-order-v1",orderId:"reflection",authorityDigest,budgetDigest:resourceBindingDigest(budget),nodes:[{nodeId:"only",dependencies:[],attempts:[attempt]}]},binding=await createMeasuredOrder({directory:join(root,"order"),budget,order}),authority={authorityDigest,orderDigests:[measuredOrderDigest(order)],acknowledgementDigests:[]},evidence=new Proxy({},{getPrototypeOf(){throw Error("reflection must not escape");}});
 const controller=openMeasuredOrder(binding,authority,{run:async()=>{throw new MeasuredSessionFailure("invalid evidence",evidence);}}),view=await controller.advance();assert.equal(view.nodes[0].state,"exhausted");assert.notEqual(view.nodes[0].state,"running");assert.notEqual(view.nodes[0].state,"unknown");
 const rows=(await readFile(join(root,"order","journal.jsonl"),"utf8")).trimEnd().split("\n").map(line=>JSON.parse(line));assert.equal(rows.length,2);assert.equal(rows[1].type,"result");assert.equal(rows[1].state,"failed");assert.equal(rows[1].result.errorCode,"MEASURED_RESULT_SERIALIZATION_FAILED");
 const replay=await openMeasuredOrder(binding,authority,{run:async()=>result("must-not-launch")}).inspect();assert.equal(replay.nodes[0].state,"exhausted");assert.notEqual(replay.nodes[0].state,"running");assert.notEqual(replay.nodes[0].state,"unknown");
});

test("result append refuses a journal replaced after the owned claim",async()=>{
 const root=await tempDir("measured-order-midflight-"),budget=await createResourceBudget({directory:join(root,"budget"),authorityDigest,limits:{maxAttempts:1,maxInputBytes:32,maxConcurrent:1}}),attempt={attemptId:"rewrite:1",model:"openai-codex/gpt-5.6-sol" as const,thinkingLevel:"high" as const,prompt:"x",deadlineMs:1000,terminationGraceMs:100,maxRetainedOutputBytes:32,maxOutputTokens:8,includeDependencies:false,qualification:{version:"measured-output-exact-v1" as const,expectedSha256:sha("ok")}},order:MeasuredOrder={version:"measured-order-v1",orderId:"midflight",authorityDigest,budgetDigest:resourceBindingDigest(budget),nodes:[{nodeId:"write",dependencies:[],attempts:[attempt]}]},binding=await createMeasuredOrder({directory:join(root,"order"),budget,order}),authority={authorityDigest,orderDigests:[measuredOrderDigest(order)],acknowledgementDigests:[]},journal=join(root,"order","journal.jsonl");
 const controller=openMeasuredOrder(binding,authority,{run:async()=>{const bytes=await readFile(journal);await rm(journal);await writeFile(journal,bytes,{mode:0o600});return result("ok");}});await assert.rejects(controller.advance(),/binding changed/);assert.equal((await readFile(journal,"utf8")).includes('"type":"result"'),false);
});

test("measured order restart refuses a replaced journal even when bytes match",async()=>{
 const root=await tempDir("measured-order-replace-"),budget=await createResourceBudget({directory:join(root,"budget"),authorityDigest,limits:{maxAttempts:1,maxInputBytes:10,maxConcurrent:1}}),order:MeasuredOrder={version:"measured-order-v1",orderId:"replace",authorityDigest,budgetDigest:resourceBindingDigest(budget),nodes:[{nodeId:"only",dependencies:[],attempts:[{attemptId:"only:1",model:"openai-codex/gpt-5.6-sol",thinkingLevel:"high",prompt:"x",deadlineMs:1000,terminationGraceMs:100,maxRetainedOutputBytes:10,maxOutputTokens:1,includeDependencies:false,qualification:{version:"measured-output-exact-v1",expectedSha256:sha("x")} }]}]},binding=await createMeasuredOrder({directory:join(root,"order"),budget,order});
 const journal=join(root,"order","journal.jsonl");await rm(journal);await writeFile(journal,"",{mode:0o600});await assert.rejects(openMeasuredOrder(binding,null,{run:async()=>result("x")}).inspect(),/binding changed/);
});

test("measured orders refuse cycles, non-read-only models and undeclared recovery",async()=>{
 const root=await tempDir("measured-order-invalid-"),budget=await createResourceBudget({directory:join(root,"budget"),authorityDigest,limits:{maxAttempts:2,maxInputBytes:100,maxConcurrent:2}}),base:any={version:"measured-order-v1",orderId:"bad",authorityDigest,budgetDigest:resourceBindingDigest(budget),nodes:[{nodeId:"a",dependencies:["b"],attempts:[]},{nodeId:"b",dependencies:["a"],attempts:[]}]};
 await assert.rejects(createMeasuredOrder({directory:join(root,"cycle"),budget,order:base}),/cycle|attempt|recovery policy/);
 base.nodes=[{nodeId:"a",dependencies:[],attempts:[{attemptId:"a:1",model:"openai/gpt-5",thinkingLevel:"high",prompt:"x",deadlineMs:1,terminationGraceMs:1,maxRetainedOutputBytes:1,maxOutputTokens:1,includeDependencies:false,qualification:{version:"measured-output-exact-v1",expectedSha256:"0".repeat(64)}}]}];
 await assert.rejects(createMeasuredOrder({directory:join(root,"model"),budget,order:base}),/model/);
});
