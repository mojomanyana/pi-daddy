import { byteHash, cloneExperiment, experimentCharterDigest, experimentHash } from "./experiment-contract.ts";
import { createExperiment, openExperiment, type ExperimentView } from "./experiment.ts";
import { experimentBindingDigest, experimentStore } from "./experiment-store.ts";
import { readIntentWork } from "./intent-application.ts";
import { freezeWork } from "./work-ledger-json.ts";
import { compileFactoryOrder, factoryAuthority, factoryCharter, factoryOrderDigest, fixedPolicyDigest, requireFactoryAuthority, type FactoryOrderCharter, type FactoryAuthority } from "./factory-contract.ts";
import { factoryRegistryStore, replayRegistry, validateActivePolicy, type FactoryRegistryBinding, type PinnedOrder } from "./factory-registry.ts";
import type { ExperimentCancellation } from "./experiment-contract.ts";
import type { FactoryDecision } from "./order-schedule.ts";
import type { DigestProfile } from "./effect-profile.ts";
export { migrateFactoryOrder, factoryMigrationDigest, type FactoryMigration } from "./factory-migration.ts";
export { createFactoryRegistry, openFactoryRegistry, type FactoryRegistryBinding } from "./factory-registry.ts";
export { parseFactoryOrder, factoryOrderDigest, fixedPolicyDigest, factoryDecisionDigest, activationRequestDigest, type FactoryOrderCharter, type FactoryAuthority, type FixedPolicy, type ActivationRequest } from "./factory-contract.ts";
function lowerAuthority(p:PinnedOrder,a:FactoryAuthority|null){return a?.orderDigests.includes(factoryOrderDigest(p.charter))?{authorityDigest:p.charter.budget.authorityDigest,charterDigests:[p.compiledDigest],cancellationDigests:a.cancellationDigests??[]}:null;}
export async function createFactoryOrder(inputRegistry:FactoryRegistryBinding,input:FactoryOrderCharter,host:FactoryAuthority|null){
  const registry=factoryRegistryStore(inputRegistry).binding;
  const c=factoryCharter(input),a=requireFactoryAuthority(factoryAuthority(host),registry.initial.authorityId),store=factoryRegistryStore(registry);
  if(!a.orderDigests.includes(factoryOrderDigest(c)))throw new Error("independent order authority required");
  let pinned!:PinnedOrder,existing=false;
  await store.transaction(async(events,append)=>{
    const state=replayRegistry(registry,events),old=state.orders.get(c.orderId);
    if(old){if(factoryOrderDigest(old.charter)!==factoryOrderDigest(c))throw new Error("conflicting order identity");pinned=old;existing=true;return;}
    if(c.scopeDigest!==registry.initial.scopeDigest)throw new Error("changed registry scope");
    if(c.pin.revision!==state.revision||c.pin.candidateDigest!==state.candidateDigest)throw new Error("stale order policy pin");validateActivePolicy(state,a);
    const compiled=await compileFactoryOrder(c,state.candidate),event={type:"order-pin",charter:c,candidate:state.candidate,compiledDigest:experimentCharterDigest(compiled),adoptionId:state.activation?.receipt.id??null};
    replayRegistry(registry,[...events,event]);await append(event);pinned={charter:c,candidate:state.candidate,compiledDigest:event.compiledDigest,adoptionId:event.adoptionId,binding:null};
  });
  if(existing){if(!pinned.binding)throw new Error("order materialization pending-or-unknown; no retry effects");await experimentStore(pinned.binding).read();return pinned.binding;}
  const charter=await compileFactoryOrder(c,pinned.candidate);
  const binding=await createExperiment({directory:c.directory,budget:c.budget,charter,bytes:Buffer.from(c.commonBase64,"base64"),authority:lowerAuthority(pinned,a)});
  await store.transaction(async(events,append)=>{const event={type:"order-materialized",orderId:c.orderId,binding};replayRegistry(registry,[...events,event]);await append(event);});return binding;
}
export async function openFactoryOrder(inputRegistry:FactoryRegistryBinding,orderId:string,host:FactoryAuthority|null){
  const registry=factoryRegistryStore(inputRegistry).binding;
  const a=factoryAuthority(host),store=factoryRegistryStore(registry),state=replayRegistry(registry,(await store.read()).events),p=state.orders.get(orderId);
  if(!p?.binding)throw new Error("order materialization missing or unknown");
  const binding=p.binding;await experimentStore(binding).read();
  if(experimentCharterDigest(binding.charter)!==p.compiledDigest)throw new Error("compiled order identity mismatch");
  const admitted=a?.id===registry.initial.authorityId?lowerAuthority(p,a):null,controller=openExperiment(binding,admitted);
  const inspect=async()=>{
    const result=await controller.orderView();let scope:"pinned"|"changed-or-unavailable"="pinned";
    try{if(byteHash(await readIntentWork(p.charter.work))!==p.charter.workTextDigest)scope="changed-or-unavailable";}catch{scope="changed-or-unavailable";}
    const nodes=result.superseded?result.nodes.map(n=>({...n,state:"superseded" as const,action:"none" as const})):scope==="pinned"?result.nodes:result.nodes.map(n=>({...n,state:"unknown" as const,action:"stakeholder" as const}));
    return freezeWork({version:"factory-order-view-v1",orderId,scope,policyPin:{revision:p.charter.pin.revision,candidateDigest:fixedPolicyDigest(p.candidate),adoptionId:p.adoptionId},orderDigest:factoryOrderDigest(p.charter),nodes:nodes.map(n=>({...n,obligation:p.charter.nodes.find(o=>o.nodeId===n.nodeId)!.obligation})),resources:result.view.budget,control:result.view.control,diagnostics:result.view.diagnostics,superseded:result.superseded,dispatchAuthorized:Boolean(admitted)&&result.view.control==="not-assessed",modelTransport:"not-used-fixed-profile",acceptance:"not-assessed",freshness:"snapshot-unknown"});
  };
  const settledView = async (completed: ExperimentView) => { const view = await inspect().catch(() => freezeWork({version:"factory-order-view-v1",orderId,scope:"changed-or-unavailable",policyPin:{revision:p.charter.pin.revision,candidateDigest:fixedPolicyDigest(p.candidate),adoptionId:p.adoptionId},orderDigest:factoryOrderDigest(p.charter),nodes:p.charter.nodes.map(n=>({nodeId:n.nodeId,obligation:n.obligation,state:"unknown",action:"stakeholder",executionId:null,evidenceDigest:null})),resources:null,superseded:null,dispatchAuthorized:false,modelTransport:"not-used-fixed-profile",acceptance:"not-assessed",freshness:"snapshot-unknown",control:"unknown"}));
    return completed.control === "not-assessed" ? view : freezeWork({...view,control:completed.control,diagnostics:completed.diagnostics,dispatchAuthorized:false,nodes:view.nodes.map(n=>({...n,action:"stakeholder" as const}))});
  };
  return Object.freeze({bindingDigest:experimentBindingDigest(binding),binding,pin:freezeWork({revision:p.charter.pin.revision,candidateDigest:fixedPolicyDigest(p.candidate),adoptionId:p.adoptionId}),inspect,reconcile:inspect,
    async advance(profile:DigestProfile){if(!admitted)throw new Error("independent order authority required");const run=await controller.start(profile);return Object.freeze({boundary:run.boundary.then(settledView),completion:run.completion.then(settledView),started:run.started});},
    async decide(request:FactoryDecision,host:FactoryAuthority|null){const current=requireFactoryAuthority(factoryAuthority(host),registry.initial.authorityId);if(!current.orderDigests.includes(factoryOrderDigest(p.charter)))throw new Error("order authority required");await controller.decideOrder(request,{id:current.id,digests:current.decisionDigests});return inspect();},
    async cancel(request:ExperimentCancellation,host:FactoryAuthority|null){const current=requireFactoryAuthority(factoryAuthority(host),registry.initial.authorityId);await controller.cancel(request,lowerAuthority(p,current));return inspect();},
    readArtifact:controller.readArtifact,
  });
}
export type FactoryOrderView=Awaited<ReturnType<Awaited<ReturnType<typeof openFactoryOrder>>["inspect"]>>;
