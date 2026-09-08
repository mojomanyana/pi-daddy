import { test, after } from "node:test";
import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDirs } from "./tmp.ts";
import { fixture } from "./factory-quality-fixture.ts";
import { createFactoryOrder, openFactoryOrder, factoryOrderDigest, fixedPolicyDigest, activationRequestDigest, openFactoryRegistry } from "../src/factory-order.ts";
import { factoryRegistryStore, replayRegistry, validateActivePolicy } from "../src/factory-registry.ts";
import { prepareDigestProfile } from "../src/effect-profile.ts";
import { byteHash } from "../src/experiment-contract.ts";
import { buildAdoptionBinding, authorizeAdoption, buildRollbackRequest } from "../src/vendor/adoption.ts";
after(cleanupTempDirs);
test("factory boundary and completion preserve final controller failure with real successful worker artifacts", async()=>{
  const f=await fixture(),charter={...f.charter,nodes:f.charter.nodes.map((n,i)=>({...n,attempts:n.attempts.slice(0,1),expectedDigest:byteHash("common"+i),dependencies:[],decision:null}))},authority={...f.authority,orderDigests:[factoryOrderDigest(charter)]};
  const binding=await createFactoryOrder(f.registry,charter,authority),controller=await openFactoryOrder(f.registry,charter.orderId,authority),profile=await prepareDigestProfile(f.budget),path=join(binding.directory,"experiment.jsonl");
  const file=await open(path,"r"),proto=Object.getPrototypeOf(file);await file.close();const original=proto.sync;let hit=false;
  proto.sync=async function(...args:any[]){if(!hit&&String((await this.stat({bigint:true})).ino)===binding.journalInode&&(await readFile(path,"utf8")).split('"type":"result"').length===5){hit=true;throw new Error("owned factory final sync failure");}return Reflect.apply(original,this,args);};
  let done:any,boundary:any;try{const run=await controller.advance(profile);[done,boundary]=await Promise.all([run.completion,run.boundary]);}finally{proto.sync=original;}
  assert.ok(hit);for(const view of [done,boundary,await controller.inspect()]){assert.equal(view.control,"failed");assert.ok(view.diagnostics.length);assert.equal(view.dispatchAuthorized,false);assert.equal(view.resources.active,0);assert.ok(view.nodes.every((n:any)=>n.action!=="dispatch"));}
  for(const v of binding.charter.variants)assert.ok(JSON.parse(Buffer.from(await controller.readArtifact(v.executionId)).toString()).digest);
});
test("failed order dispatch bookkeeping drains original unused reservations and started waiters",async()=>{
  const f=await fixture(),charter={...f.charter,nodes:f.charter.nodes.map(n=>({...n,attempts:n.attempts.slice(0,1),dependencies:[],decision:null}))},authority={...f.authority,orderDigests:[factoryOrderDigest(charter)]};
  const binding=await createFactoryOrder(f.registry,charter,authority),controller=await openFactoryOrder(f.registry,charter.orderId,authority),profile=await prepareDigestProfile(f.budget),path=join(binding.directory,"experiment.jsonl");
  const file=await open(path,"r"),proto=Object.getPrototypeOf(file);await file.close();const sync=proto.sync;let hit=false;
  proto.sync=async function(...args:any[]){if(!hit&&String((await this.stat({bigint:true})).ino)===binding.journalInode&&(await readFile(path,"utf8")).includes('"type":"dispatch"')){hit=true;throw new Error("owned dispatch sync failure");}return Reflect.apply(sync,this,args);};
  try{const run=await controller.advance(profile),done=await run.completion;assert.ok(hit);assert.equal(done.control,"failed");assert.equal(done.resources?.active,0);
    let timer:NodeJS.Timeout|undefined;try{const values=await Promise.race([Promise.all(run.started),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("unsettled started waiter")),1000);})]);assert.equal(values.length,4);}finally{clearTimeout(timer);}
  }finally{proto.sync=sync;}
});
test("stacked repeated candidates restore exact adoption lineage and subsequent order revalidation",async()=>{
  const f=await fixture(),registry=openFactoryRegistry(f.registry),requests:any[]=[],facts:any[]=[],adoptions:string[]=[],rollbacks:string[]=[];let authority={...f.authority,adoption:{id:f.authority.id,adoptions,rollbacks},facts,activationDigests:[] as string[]};
  for(const [i,suffix]of ["A","B","A"].entries()){
    const state=await registry.inspect(),candidate={...f.baseline,suffixBase64:Buffer.from(suffix).toString("base64")};
    const binding=buildAdoptionBinding({hypothesisDigest:byteHash("h"+i),experimentDigest:byteHash("e"+i),candidateDigest:fixedPolicyDigest(candidate),scopeDigest:state.scopeDigest,assessmentPolicyDigest:candidate.acceptancePolicyDigest,rollbackCandidateDigest:state.candidateDigest,activationBoundary:"next-orders",expiresAt:Date.now()+60000});
    const fact={experimentDigest:binding.experimentDigest,candidateDigest:binding.candidateDigest,scopeDigest:binding.scopeDigest,assessmentPolicyDigest:binding.assessmentPolicyDigest,eligible:true};adoptions.push(binding.id);facts.push({bindingId:binding.id,facts:fact});
    const receipt=authorizeAdoption(binding,authority.adoption,fact,Date.now()),request={version:"factory-activation-v1" as const,requestId:"activate"+i,expectedRevision:state.revision,expectedCandidateDigest:state.candidateDigest,candidate,binding,receipt};authority.activationDigests.push(activationRequestDigest(request));await registry.activate(request,authority);requests.push(request);
  }
  const rollback=async(index:number)=>{const request=buildRollbackRequest(requests[index].receipt,"operator-request",[byteHash("rollback"+index)],Date.now()+60000);rollbacks.push(request.id);await registry.rollback(request,authority);return request;};
  const rb2=await rollback(2);let state=replayRegistry(f.registry,(await factoryRegistryStore(f.registry).read()).events);assert.equal(state.activation?.receipt.id,requests[1].receipt.id);
  await rollback(1);state=replayRegistry(f.registry,(await factoryRegistryStore(f.registry).read()).events);assert.equal(state.activation?.receipt.id,requests[0].receipt.id);assert.equal(state.candidateDigest,fixedPolicyDigest(requests[0].candidate));
  const stale=buildRollbackRequest(requests[2].receipt,"operator-request",[byteHash("stale")],Date.now()+60000);rollbacks.push(stale.id);await assert.rejects(registry.rollback(stale,authority),/rollback binding changed or expired/);
  // Exact duplicate reports the recorded operation, without applying it to the new head again.
  const revision=state.revision;await registry.rollback(rb2,authority);assert.equal((await registry.inspect()).revision,revision);
  const charter={...f.charter,pin:{revision,candidateDigest:state.candidateDigest}},allowed={...authority,orderDigests:[factoryOrderDigest(charter)]};
  await assert.rejects(createFactoryOrder(f.registry,charter,{...allowed,adoption:null}),/authority/);
  await assert.rejects(createFactoryOrder(f.registry,charter,{...allowed,facts:[]}),/facts/);
  await assert.rejects(createFactoryOrder(f.registry,charter,{...allowed,facts:facts.map(f=>({...f,facts:{...f.facts,eligible:false}}))}),/eligible/);
  const clock=Date.now;try{Date.now=()=>requests[0].binding.expiresAt+1;await assert.rejects(createFactoryOrder(f.registry,charter,allowed),/expired/);}finally{Date.now=clock;}
  validateActivePolicy(state,authority);await createFactoryOrder(f.registry,charter,allowed);const order=await openFactoryOrder(f.registry,charter.orderId,allowed);assert.equal(order.pin.adoptionId,requests[0].receipt.id);
  await rollback(0);state=replayRegistry(f.registry,(await factoryRegistryStore(f.registry).read()).events);assert.equal(state.activation,null);assert.equal(state.candidateDigest,fixedPolicyDigest(f.baseline));
});
