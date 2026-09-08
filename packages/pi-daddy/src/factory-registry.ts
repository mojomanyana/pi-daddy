import { createControlJournal, controlJournal, type ControlBinding } from "./control-journal.ts";
import { cloneExperiment, closed, experimentHash, experimentCharterDigest } from "./experiment-contract.ts";
import { validateExperimentBinding, type ExperimentBinding } from "./experiment-store.ts";
import { fixedPolicy, fixedPolicyDigest, factoryCharter, factoryOrderDigest, factoryAuthority, requireFactoryAuthority, activationRequestDigest, type FixedPolicy, type FactoryAuthority, type FactoryOrderCharter, type ActivationRequest } from "./factory-contract.ts";
import { validateAdoptionReceipt, authorizeRollback, buildRollbackRequest, buildAdoptionBinding, type RollbackRequest } from "./vendor/adoption.ts";
export interface RegistryInitial {version:"factory-registry-v1";authorityId:string;scopeDigest:string;baseline:FixedPolicy}
export type FactoryRegistryBinding=ControlBinding<RegistryInitial>;
export interface PinnedOrder {charter:FactoryOrderCharter;candidate:FixedPolicy;compiledDigest:string;adoptionId:string|null;binding:ExperimentBinding|null}
export function registryInitial(value:RegistryInitial){const v=cloneExperiment(value);closed(v,["version","authorityId","scopeDigest","baseline"]);if(v.version!=="factory-registry-v1"||!/^[a-zA-Z0-9:_-]{1,128}$/.test(v.authorityId)||!/^[a-f0-9]{64}$/.test(v.scopeDigest))throw new Error("invalid registry initial binding");v.baseline=fixedPolicy(v.baseline);return v;}
export function replayRegistry(b:FactoryRegistryBinding,events:Record<string,unknown>[]){
  const initial=registryInitial(b.initial);let revision=0,candidate=initial.baseline,activation:ActivationRequest|null=null;
  const changes=new Map<string,string>(),orders=new Map<string,PinnedOrder>(),migrations=new Map<string,{digest:string;sourceOrderId:string;targetOrderId:string;application:string}>();
  const candidates=new Map([[fixedPolicyDigest(candidate),candidate]]);
  for(const e of events){
    if(e.type==="activate"){
      closed(e,["type","request"]);const r=cloneExperiment(e.request) as ActivationRequest;closed(r,["version","requestId","expectedRevision","expectedCandidateDigest","candidate","binding","receipt"]);
      const {id,version,...input}=r.binding;
      if(r.version!=="factory-activation-v1"||typeof r.requestId!=="string"||!/^[a-zA-Z0-9:_-]{1,128}$/.test(r.requestId)||version!=="adoption-binding-v1"||buildAdoptionBinding(input).id!==id||r.expectedRevision!==revision||r.expectedCandidateDigest!==fixedPolicyDigest(candidate)||r.binding.scopeDigest!==initial.scopeDigest||r.binding.rollbackCandidateDigest!==fixedPolicyDigest(candidate)||r.binding.candidateDigest!==fixedPolicyDigest(r.candidate)||r.binding.assessmentPolicyDigest!==r.candidate.acceptancePolicyDigest||changes.has(r.requestId))throw new Error("invalid activation sequence");
      changes.set(r.requestId,activationRequestDigest(r));candidate=fixedPolicy(r.candidate);candidates.set(fixedPolicyDigest(candidate),candidate);activation=r;revision++;
    }else if(e.type==="rollback"){
      closed(e,["type","request","fromRevision"]);const r=e.request as RollbackRequest;
      if(!activation||e.fromRevision!==revision||changes.has(r.id)||buildRollbackRequest(activation.receipt,r.reason,[...r.evidence],r.expiresAt).id!==r.id||r.restoreCandidateDigest!==activation.binding.rollbackCandidateDigest)throw new Error("invalid rollback sequence");
      const restored=candidates.get(r.restoreCandidateDigest);if(!restored)throw new Error("rollback bytes not registered");changes.set(r.id,experimentHash(r));candidate=restored;activation=null;revision++;
    }else if(e.type==="order-pin"){
      closed(e,["type","charter","candidate","compiledDigest","adoptionId"]);const charter=factoryCharter(e.charter as FactoryOrderCharter),policy=fixedPolicy(e.candidate as FixedPolicy);
      if(orders.size>=32||orders.has(charter.orderId)||charter.scopeDigest!==initial.scopeDigest||charter.pin.revision!==revision||charter.pin.candidateDigest!==fixedPolicyDigest(candidate)||fixedPolicyDigest(policy)!==fixedPolicyDigest(candidate)||e.adoptionId!==(activation?.receipt.id??null)||typeof e.compiledDigest!=="string"||!/^[a-f0-9]{64}$/.test(e.compiledDigest))throw new Error("invalid order pin sequence");
      orders.set(charter.orderId,{charter,candidate:policy,compiledDigest:e.compiledDigest,adoptionId:e.adoptionId as string|null,binding:null});
    }else if(e.type==="order-materialized"){
      closed(e,["type","orderId","binding"]);const p=orders.get(String(e.orderId)),binding=validateExperimentBinding(e.binding as ExperimentBinding);
      if(!p||p.binding||binding.directory!==p.charter.directory||experimentCharterDigest(binding.charter)!==p.compiledDigest)throw new Error("invalid order materialization");p.binding=binding;
    }else if(e.type==="migration-request"){
      closed(e,["type","requestId","sourceOrderId","targetOrderId","requestDigest"]);
      if(typeof e.requestId!=="string"||changes.has(e.requestId)||!orders.has(String(e.sourceOrderId))||e.sourceOrderId===e.targetOrderId||typeof e.requestDigest!=="string"||!/^[a-f0-9]{64}$/.test(e.requestDigest))throw new Error("invalid migration request");
      changes.set(e.requestId,e.requestDigest);migrations.set(e.requestId,{digest:e.requestDigest,sourceOrderId:String(e.sourceOrderId),targetOrderId:String(e.targetOrderId),application:"pending-or-unknown"});
    }else if(e.type==="migration-receipt"){
      closed(e,["type","requestId","application","renewedObligations"]);const m=migrations.get(String(e.requestId));
      if(!m||m.application!=="pending-or-unknown"||!["applied","refused-active"].includes(String(e.application))||!Array.isArray(e.renewedObligations)||e.renewedObligations.length>16||e.application==="applied"&&!orders.get(m.targetOrderId)?.binding)throw new Error("invalid migration receipt");m.application=String(e.application);
    }else throw new Error("unknown factory control event");
  }
  return{revision,candidate,candidateDigest:fixedPolicyDigest(candidate),activation,changes,orders,migrations};
}
export const factoryRegistryStore=(b:FactoryRegistryBinding)=>{registryInitial(b.initial);return controlJournal(b);};
export async function createFactoryRegistry(input:{directory:string;authorityId:string;scopeDigest:string;baseline:FixedPolicy}):Promise<FactoryRegistryBinding>{const {directory,...rest}=cloneExperiment(input);return createControlJournal(directory,registryInitial({version:"factory-registry-v1",...rest}));}
export function validateActivePolicy(state:ReturnType<typeof replayRegistry>,a:FactoryAuthority){if(state.activation){const r=state.activation,facts=a.facts.find(f=>f.bindingId===r.binding.id)?.facts;if(!facts)throw new Error("current independent eligibility facts required");validateAdoptionReceipt(r.receipt,r.binding,a.adoption,facts,Date.now());}}
export function openFactoryRegistry(input:FactoryRegistryBinding){const store=factoryRegistryStore(input),b=store.binding;
  const inspect=async()=>{const s=replayRegistry(b,(await store.read()).events);return{version:"factory-registry-view-v1" as const,revision:s.revision,candidateDigest:s.candidateDigest,candidate:cloneExperiment(s.candidate),scopeDigest:b.initial.scopeDigest,migrations:[...s.migrations].map(([requestId,m])=>({requestId,...m})),orders:[...s.orders].map(([orderId,p])=>({orderId,orderDigest:factoryOrderDigest(p.charter),candidateDigest:fixedPolicyDigest(p.candidate),revision:p.charter.pin.revision,materialization:p.binding?"recorded":"pending-or-unknown"})),acceptance:"not-assessed" as const};};
  return{inspect,async activate(input:ActivationRequest,host:FactoryAuthority|null){const r=cloneExperiment(input),a=requireFactoryAuthority(factoryAuthority(host),b.initial.authorityId);closed(r,["version","requestId","expectedRevision","expectedCandidateDigest","candidate","binding","receipt"]);
    if(!a.activationDigests.includes(activationRequestDigest(r)))throw new Error("independent activation authority required");
    await store.transaction(async(events,append)=>{const s=replayRegistry(b,events),old=s.changes.get(r.requestId);if(old){if(old!==activationRequestDigest(r))throw new Error("conflicting activation ID");return;}
      if(r.expectedRevision!==s.revision||r.expectedCandidateDigest!==s.candidateDigest)throw new Error("stale activation");
      if(r.binding.scopeDigest!==b.initial.scopeDigest||r.binding.candidateDigest!==fixedPolicyDigest(r.candidate)||r.binding.assessmentPolicyDigest!==r.candidate.acceptancePolicyDigest||r.binding.rollbackCandidateDigest!==s.candidateDigest)throw new Error("activation scope/candidate/policy mismatch");
      const facts=a.facts.find(f=>f.bindingId===r.binding.id)?.facts;if(!facts)throw new Error("independent eligibility facts required");validateAdoptionReceipt(r.receipt,r.binding,a.adoption,facts,Date.now());
      replayRegistry(b,[...events,{type:"activate",request:r}]);await append({type:"activate",request:r});});return inspect();
  },async rollback(input:RollbackRequest,host:FactoryAuthority|null){const r=cloneExperiment(input),a=requireFactoryAuthority(factoryAuthority(host),b.initial.authorityId);closed(r,["version","id","adoptionId","scopeDigest","restoreCandidateDigest","reason","evidence","expiresAt"]);
    await store.transaction(async(events,append)=>{const s=replayRegistry(b,events),old=s.changes.get(r.id);if(old){if(old!==experimentHash(r)||!a.adoption?.rollbacks.includes(r.id))throw new Error("rollback authority/identity mismatch");return;}
      if(!s.activation)throw new Error("stale rollback");authorizeRollback(s.activation.receipt,r,a.adoption,Date.now(),{adoptionId:s.activation.receipt.id,candidateDigest:s.candidateDigest,scopeDigest:b.initial.scopeDigest});
      const event={type:"rollback",request:r,fromRevision:s.revision};replayRegistry(b,[...events,event]);await append(event);});return{...await inspect(),application:"applied" as const,requestId:r.id,grantExpansion:false};
  }};
}
