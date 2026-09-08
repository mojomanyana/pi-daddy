import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
import { createExperimentBudget, resourceBindingDigest } from "../src/resource-budget.ts";
import { createExperiment, openExperiment, experimentCharterDigest, type ExperimentCharter } from "../src/experiment.ts";
import { prepareDigestProfile } from "../src/effect-profile.ts";
import { byteHash } from "../src/experiment-contract.ts";
after(cleanupTempDirs);
async function fixture() {
  const root = await tempDir("controller-failure-"), bytes = Buffer.from("owned");
  const budget = await createExperimentBudget({ directory: join(root,"budget"), authorityDigest: "a".repeat(64), limits: {maxAttempts:2,maxInputBytes:100,maxConcurrent:2} });
  const charter: ExperimentCharter = {version:"fixed-experiment-v1",experimentId:"failure",orderId:"failure",budgetDigest:resourceBindingDigest(budget),profile:"linux-bwrap-digest-v1",common:{sha256:byteHash(bytes),bytes:bytes.length,work:null,workTextDigest:null},mode:"concurrent-shadow",deadlineMs:15000,variants:[0,1].map(i=>({variantId:"v"+i,executionId:"e"+i,kind:i?"shadow":"primary",parentExecutionId:i?"e0":null,suffixBase64:"",operation:"digest",configuration:{model:null,effort:null,skills:null}}))};
  const authority={authorityDigest:budget.authorityDigest,charterDigests:[experimentCharterDigest(charter)],cancellationDigests:[]};
  const binding=await createExperiment({directory:join(root,"experiment"),budget,charter,bytes,authority});return{root,binding,authority,profile:await prepareDigestProfile(budget)};
}
for (const fault of ["sync", "close", "release", "release-retained-lock", "failure-record-sync"] as const) test(`complete final records cannot conceal mandatory ${fault} failure`, async () => {
  const f=await fixture(), path=join(f.binding.directory,"experiment.jsonl"), sample=await fs.open(join(f.root,"sample"),"wx"), proto=Object.getPrototypeOf(sample);await sample.close();
  const original={sync:proto.sync,open:fs.open,rm:fs.rm};let hit=false;
  const last=async()=>!hit&&(await fs.readFile(path,"utf8")).split('"type":"result"').length===3;
  const matches=async(file:any)=>String((await file.stat({bigint:true})).ino)===f.binding.journalInode;
  proto.sync=async function(...args:any[]){if((fault==="sync"||fault==="failure-record-sync")&&await matches(this)&&await last()){hit=true;throw new Error("owned final sync failure");}if(fault==="failure-record-sync"&&await matches(this)&&(await fs.readFile(path,"utf8")).includes("controller-unknown"))throw new Error("owned failure record sync failure");return Reflect.apply(original.sync,this,args);};
  fs.open=(async function(...args:any[]){const file=await Reflect.apply(original.open,fs,args);if(String(args[0])===path&&typeof args[1]==="number"&&(args[1]&1)){const close=file.close.bind(file);file.close=async()=>{const inject=fault==="close"&&await last();await close();if(inject){hit=true;throw new Error("owned final close failure");}};}return file;}) as typeof fs.open;
  fs.rm=(async function(pathname:any,...args:any[]){if(String(pathname)===path+".lock"&&fault.startsWith("release")&&await last()){hit=true;if(fault==="release")await Reflect.apply(original.rm,fs,[pathname,...args]);throw new Error("owned final release failure");}return Reflect.apply(original.rm,fs,[pathname,...args]);}) as typeof fs.rm;syncBuiltinESMExports();
  const controller=openExperiment(f.binding,f.authority);let done:any;
  try{const run=await controller.start(f.profile);done=await run.completion;assert.equal((await run.primary).state,"completed");assert.deepEqual(await run.boundary,done);}
  finally{proto.sync=original.sync;fs.open=original.open;fs.rm=original.rm;syncBuiltinESMExports();}
  assert.ok(hit);assert.deepEqual(done.variants.map((v:any)=>v.state),["completed","completed"]);assert.equal(done.budget.active,0);assert.equal(done.budget.attempts,2);
  assert.equal(done.control,"failed");assert.ok(done.diagnostics.length);assert.equal((await controller.inspect() as any).control,"failed");
  if(fault==="failure-record-sync")assert.match(done.diagnostics.join(","),/unacknowledged/);
  const text=await fs.readFile(path,"utf8"), reopened:any=await openExperiment(f.binding,f.authority).inspect();
  if(fault!=="release-retained-lock"){assert.match(text,/controller-unknown/);assert.equal(reopened.control,"failed");}
  else{assert.doesNotMatch(text,/controller-unknown/);assert.match(done.diagnostics.join(","),/unacknowledged/);assert.equal(reopened.control,"not-assessed");assert.ok(await fs.readFile(path+".lock"));}
  for(const v of done.variants)assert.equal(byteHash(await controller.readArtifact(v.executionId)),v.artifactDigest);
});
