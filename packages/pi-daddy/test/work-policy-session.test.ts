import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { workPolicyMenu } from "../extensions/work-policy-session.ts";
import { createWorkPolicyRegistry, openWorkPolicyRegistry, policyForSetup, workPolicyDigest, workPolicyActivationDigest, type WorkPolicyActivation } from "../src/work-policy-registry.ts";
import { recordWorkSetup, selectRecordedWork, workSetup } from "../src/work-setup.ts";
import { writeProductJson } from "../src/product-files.ts";
import { buildAdoptionBinding, authorizeAdoption, buildRollbackRequest, type RollbackRequest } from "../src/vendor/adoption.ts";
import type { LearningHarness, LearningWorkspace } from "../src/learning-connection.ts";
import type { FactoryAuthority } from "../src/factory-contract.ts";
import { experimentHash } from "../src/experiment-contract.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
const d = (c: string) => c.repeat(64);

async function fixture() {
  const cwd = await tempDir("policy-menu-"), setup = workSetup({version:"work-setup-v1",id:"review",outcome:"Review retained work",maxParallel:2,tasks:[
    {id:"read",outcome:"Read inputs",agent:"reader",model:"p/base-read",thinking:"low",dependencies:[]},
    {id:"check",outcome:"Check outputs",agent:"reviewer",model:"p/base-check",thinking:"medium",dependencies:["read"]},
  ]});
  const saved = await recordWorkSetup(cwd,setup), state = await selectRecordedWork(saved,null), base = policyForSetup(setup,state.selectedSnapshot.snapshot.digest,state.policy.digest);
  const binding = await createWorkPolicyRegistry({directory:join(cwd,"registry"),authorityId:"local-operator",baseline:base}), registry = openWorkPolicyRegistry(binding);
  await writeProductJson(join(cwd,".pi","work-policy-registry.json"),binding);
  let selected: WorkPolicyActivation, mode = "Activate adopted comparison for next orders", consent = true, failLink = false, preparedRollbacks = 0;
  const confirmations: {title:string;detail:string}[] = [], links: {operation:string;wrapper:any;view:any}[] = [], artifacts = new Map<string,unknown>();
  const authority = (r: WorkPolicyActivation): FactoryAuthority => ({id:"local-operator",orderDigests:[],decisionDigests:[],activationDigests:[workPolicyActivationDigest(r)],migrationDigests:[],adoption:{id:"local-operator",adoptions:[r.binding.id],rollbacks:[]},facts:[{bindingId:r.binding.id,facts:{experimentDigest:r.binding.experimentDigest,candidateDigest:r.binding.candidateDigest,scopeDigest:r.binding.scopeDigest,assessmentPolicyDigest:r.binding.assessmentPolicyDigest,eligible:true}}]});
  const proposal = async (name: string) => {
    const current = await registry.inspect(), candidate = {...base,profiles:base.profiles.map((p,i)=>({...p,model:`p/${name}-${p.taskId}`,thinking:i===0?"high" as const:"low" as const}))};
    const adoption = buildAdoptionBinding({hypothesisDigest:d("c"),experimentDigest:d("d"),candidateDigest:workPolicyDigest(candidate),rollbackCandidateDigest:current.candidateDigest,scopeDigest:base.scopeDigest,assessmentPolicyDigest:base.assessmentPolicyDigest,activationBoundary:"next-orders",expiresAt:Date.now()+600000});
    const facts = {experimentDigest:adoption.experimentDigest,candidateDigest:adoption.candidateDigest,scopeDigest:adoption.scopeDigest,assessmentPolicyDigest:adoption.assessmentPolicyDigest,eligible:true};
    const receipt = authorizeAdoption(adoption,{id:"local-operator",adoptions:[adoption.id],rollbacks:[]},facts,Date.now());
    selected = {version:"ordinary-work-activation-v1",requestId:`fixture-${name}`,expectedRevision:current.revision,expectedCandidateDigest:current.candidateDigest,candidate,binding:adoption,receipt};
    await writeProductJson(join(cwd,".pi","work-policies",`${workPolicyDigest(candidate)}.json`),{version:"named-work-policy-v1",name,policy:candidate});
    return selected;
  };
  const link = (operation: string, _name: string, id: string, authorized: string[]) => { assert.deepEqual(authorized,[id]); const wrapper = artifacts.get(id) as any, view = artifacts.get(wrapper.registryManifestId); links.push({operation,wrapper,view}); if(failLink)throw Error("fixture linkage unavailable"); };
  // Public workspace/UI boundary fixture, not independent quality/calibration or peer validation.
  const workspace = {
    configuration:()=>({archiveRoot:join(cwd,"archive")}), inspect:()=>({comparisons:[{name:"trial",title:"Retained trial",state:"ready"}]}),
    comparisonContext:()=>({adoptionBinding:selected.binding}), prepareAdoption:()=>selected.receipt, preparedAdoption:()=>selected.receipt,
    previewRollback:(_name:string,reason:RollbackRequest["reason"],evidence:string[],expiresAt:number)=>buildRollbackRequest(selected.receipt,reason,evidence,expiresAt),
    prepareRollback:()=>{preparedRollbacks++;}, linkActivation:(...args: [string,string,string[]])=>link("activate",...args), linkRollback:(...args:[string,string,string[]])=>link("rollback",...args),
  } as unknown as LearningWorkspace;
  const harness = {retainArchiveSource:(_root:string,input:{bytes:Buffer})=>{const value=JSON.parse(input.bytes.toString()),manifestId=experimentHash(value);artifacts.set(manifestId,value);return {manifestId};}} as unknown as LearningHarness;
  const ctx = {cwd,ui:{select:async(title:string,choices:string[])=>title.startsWith("Scoped settings")?mode:choices[0],confirm:async(title:string,detail:string)=>{confirmations.push({title,detail});return title==="Roll back NEXT orders?"?consent:true;},notify:()=>{}}} as unknown as ExtensionCommandContext;
  const run = () => workPolicyMenu(ctx,state,workspace,harness), journal = () => readFile(join(binding.directory,"control.jsonl"));
  return {base,binding,registry,authority,proposal,run,journal,confirmations,links,mode:(v:string)=>{mode=v;},consent:(v:boolean)=>{consent=v;},failLink:(v:boolean)=>{failLink=v;},select:(r:WorkPolicyActivation)=>{selected=r;},prepared:()=>preparedRollbacks};
}

function activationProof(link: {operation:string;wrapper:any;view:any}, receipt: WorkPolicyActivation["receipt"]) {
  const {wrapper,view} = link;
  assert.equal(wrapper.operation,"activate"); assert.equal(view.version,"factory-registry-view-v1"); assert.equal(view.profile,"ordinary-model-effort-v1");
  assert.equal(view.application,"applied"); assert.equal(view.requestId,wrapper.requestId);
  assert.deepEqual(view.lastChange,{operation:"activate",requestId:wrapper.requestId,adoptionId:receipt.id});
  assert.equal(view.activation.requestId,wrapper.requestId); assert.deepEqual(view.activation.receipt,receipt);
  for(const key of ["scopeDigest","candidateDigest","revision"])assert.equal(view[key],wrapper[key]);
  assert.equal(wrapper.adoptionId,receipt.id); assert.equal(view.acceptance,"not-assessed");
}

test("menu activation and post-pin learning recovery retain exact original request/adoption proof without replay", async () => {
  const f=await fixture(), proposal=await f.proposal("first"); f.failLink(true);
  await assert.rejects(f.run(), /Registry activated but learning link failed/);
  activationProof(f.links[0],proposal.receipt);
  const applied=await f.registry.inspect(); assert.notEqual(applied.requestId,proposal.requestId,"menu supplies its own original activation request");
  await f.registry.pin("after",f.authority(applied.activation!),{revision:applied.revision,candidateDigest:applied.candidateDigest});
  const before=await f.journal(); f.failLink(false); f.mode("Recover learning link (no registry change)"); await f.run();
  activationProof(f.links[1],proposal.receipt); assert.equal(f.links[1].wrapper.requestId,f.links[0].wrapper.requestId);
  assert.equal(f.links[1].view.orders[0].orderId,"after"); assert.deepEqual(await f.journal(),before,"recovery only reads the original registry");
  const wrong=await f.proposal("other"); f.select(wrong); await assert.rejects(f.run(), /does not belong to this comparison/);
  assert.equal(f.links.length,2); assert.deepEqual(await f.journal(),before);
});

test("nested rollback displays exact retained restore digest and every task profile before consent; refusal grants nothing", async () => {
  const f=await fixture(), first=await f.proposal("first"); await f.registry.activate(first,f.authority(first));
  const second=await f.proposal("second"); await f.registry.activate(second,f.authority(second));
  f.mode("Roll back active adoption"); f.consent(false); const before=await f.journal(); await f.run();
  const prompt=f.confirmations.find(p=>p.title==="Roll back NEXT orders?"); assert.ok(prompt);
  assert.ok(prompt.detail.includes(workPolicyDigest(first.candidate))); assert.ok(!prompt.detail.includes(workPolicyDigest(f.base)));
  for(const p of first.candidate.profiles)assert.ok(prompt.detail.includes(`${p.taskId}: ${p.model} / ${p.thinking}`),"all retained prior task/model/effort bytes must be shown");
  assert.equal(f.prepared(),0); assert.equal(f.links.length,0); assert.deepEqual(await f.journal(),before);
  f.consent(true); await f.run(); assert.equal(f.prepared(),1);
  const rolled=await f.registry.inspect(); assert.equal(rolled.candidateDigest,workPolicyDigest(first.candidate)); assert.equal(rolled.activation!.receipt.id,first.receipt.id);
  const link=f.links[0]; assert.equal(link.wrapper.operation,"rollback"); assert.equal(link.wrapper.adoptionId,second.receipt.id);
  assert.deepEqual(link.view.lastChange,{operation:"rollback",requestId:link.wrapper.requestId,adoptionId:second.receipt.id}); assert.equal(link.view.requestId,link.wrapper.requestId); assert.equal(link.view.application,"applied");
  f.mode("Recover learning link (no registry change)"); const restored=await f.journal(); await f.run(); assert.deepEqual(await f.journal(),restored);
  const {registryManifestId:_originalManifest,...originalWrapper}=link.wrapper,{registryManifestId:_readbackManifest,...readbackWrapper}=f.links[1].wrapper;
  assert.deepEqual(readbackWrapper,originalWrapper);
  const {grantExpansion,...originalView}=link.view; assert.equal(grantExpansion,false);
  assert.deepEqual(f.links[1].view,originalView,"inspect preserves original proof; only the direct rollback return adds grantExpansion:false");
});

test("rollback preview resolves validated journal lineage, stays read-only, and rejects missing or mismatched restore targets", async () => {
  const f=await fixture(), first=await f.proposal("first"); await f.registry.activate(first,f.authority(first));
  const request=buildRollbackRequest(first.receipt,"operator-request",[d("e")]),before=await f.journal();
  const preview=await f.registry.previewRollback(request); assert.equal(preview.restoreCandidateDigest,workPolicyDigest(f.base)); assert.deepEqual(preview.candidate,f.base);
  await assert.rejects(f.registry.previewRollback({...request,restoreCandidateDigest:d("f")}), /rollback/);
  await assert.rejects(f.registry.previewRollback({...request,adoptionId:d("a")}), /rollback/);
  assert.deepEqual(await f.journal(),before);
  await f.registry.rollback(request,{...f.authority(first),adoption:{id:"local-operator",adoptions:[],rollbacks:[request.id]}});
  await assert.rejects(f.registry.previewRollback(request), /rollback/);
});
