import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { createResourceBudget, openResourceBudget, resourceBindingDigest } from "../src/resource-budget.ts";
import { createMeasuredOrder, measuredOrderAcknowledgementDigest, measuredOrderDigest, openMeasuredOrder, type MeasuredOrder, type MeasuredOrderAuthority } from "../src/measured-order.ts";
import { intentKey } from "../src/intent-control.ts";
import type { MeasuredSessionHost } from "../src/measured-session.ts";
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
