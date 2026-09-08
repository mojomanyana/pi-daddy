import { isOrdinaryChildren, type OrdinaryChildren, type OrdinaryCancellation } from "./ordinary-children.ts";
import { loadedDashboardHarnessDigest } from "./dashboard-harness.ts";
import { join, isAbsolute } from "node:path";
import { dataDigest, detached, freeze, sha, reviewPage } from "./debrief-contract.ts";
import { createRetainedDebrief } from "./debrief-host.ts";
import type { DebriefCheckpoint, DebriefPresenter, DebriefPersistence } from "./debrief.ts";
import { debriefAction } from "./debrief-render.ts";
import { openResourceBudget, resourceBindingDigest, type GovernedBudgetBinding } from "./resource-budget.ts";
import { dispatchRequest, dispatchRequestDigest, controlShape, type DispatchRequest } from "./dispatch-control.ts";
import { intentRequest, type IntentRequest } from "./intent-control.ts";
import { experimentBindingDigest, isExperimentController, type ExperimentCancellation, type openExperiment } from "./experiment.ts";
import { dashboardObservations } from "./dashboard-observation.ts";
import { dashboardHostDigest, dashboardHostRequest, dashboardHostRequestDigest, dashboardSelectionDigest,
  type DashboardHarness, type DashboardHostConfig, type DashboardHostRequest, type DashboardHostAuthority } from "./dashboard-host-contract.ts";
export * from "./dashboard-host-contract.ts";
const hosts=new WeakSet<object>();
export const isDashboardHost=(value:unknown):value is DashboardHost=>typeof value==="object"&&value!==null&&hosts.has(value);
export type DashboardHost=ReturnType<typeof openDashboardHost>;
export interface DashboardHostOptions { ordinary?:OrdinaryChildren; harness:DashboardHarness; config:DashboardHostConfig; budget:GovernedBudgetBinding; experiment?:ReturnType<typeof openExperiment>; authority:()=>DashboardHostAuthority|null;
  /** Independently sourced current declaration. Never inferred from idle, a PID, title or request fields. */
  presence?:()=>{present:boolean;closing:boolean;evidenceDigest:string;expiresAt:number}|null;
}
function configuration(input:DashboardHostConfig){
  const c=detached(input);controlShape(c,["version","trustDirectory","trustPolicyId","archiveRoot","scope","author","policyPath","policySha256","sources","selection","cases","blind","budgetDigest","experimentDigest","harnessArtifactDigest",...(Object.hasOwn(c,"ordinaryDigest")?["ordinaryDigest"]:[])]);
  if(Object.hasOwn(c,"ordinaryDigest")&&!sha(c.ordinaryDigest))throw Error("invalid ordinary binding digest");
  if(c.version!=="producer-dashboard-host-v1"||![c.trustDirectory,c.archiveRoot,c.policyPath].every(p=>typeof p==="string"&&isAbsolute(p))||![c.trustPolicyId,c.policySha256,c.budgetDigest,c.harnessArtifactDigest].every(sha)||!(c.experimentDigest===null||sha(c.experimentDigest))||typeof c.scope!=="string"||!c.scope||c.scope.length>128||typeof c.author!=="string"||!c.author||c.author.length>256||!Array.isArray(c.sources)||c.sources.length<1||c.sources.length>32||new Set(c.sources.map(s=>s.id)).size!==c.sources.length||c.sources.filter(s=>s.kind==="work").length>1||c.sources.some(s=>!/^[a-zA-Z0-9:_-]{1,128}$/.test(s.id)||!["work","retention","facts"].includes(s.kind)))throw Error("invalid explicit dashboard host binding");
  return freeze(c);
}
/** Explicit creation, NEVER called by refresh/reconnect. One fixed host child per registered trust store. */
export function createDashboardHost(options:DashboardHostOptions){
  const c=configuration(options.config),h=options.harness,a=options.authority();
  if(loadedDashboardHarnessDigest(h)!==c.harnessArtifactDigest)throw Error("verified loaded harness artifact required");
  if(!a?.hostDigests.includes(dashboardHostDigest(c)))throw Error("independent exact host authority required");
  const trust=h.openTrustLifecycle(c.trustDirectory),view=trust.inspect(Date.now());
  if(view.policyId!==c.trustPolicyId)throw Error("trust policy changed");
  h.learningJournal(join(c.trustDirectory,"producer-host"),{type:"producer-host-initial",config:c});
  return openDashboardHost(options);
}
/** Existing native writers + original controllers; no model, launch, authority-file loader or PID recovery. */
export function openDashboardHost(options:DashboardHostOptions){
  const c=configuration(options.config),h=options.harness,hostDigest=dashboardHostDigest(c),selectionDigest=dashboardSelectionDigest(c.selection);
  if(loadedDashboardHarnessDigest(h)!==c.harnessArtifactDigest)throw Error("verified loaded harness artifact required");
  const budget=openResourceBudget(options.budget),experiment=options.experiment,ordinary=options.ordinary;
  if(ordinary&&(!isOrdinaryChildren(ordinary)||ordinary.bindingDigest!==c.ordinaryDigest))throw Error("original ordinary controller binding required");
  if(resourceBindingDigest(budget.binding)!==c.budgetDigest||experiment&&(!isExperimentController(experiment)||experimentBindingDigest(experiment.binding)!==c.experimentDigest))throw Error("original controller binding required");
  const trust=h.openTrustLifecycle(c.trustDirectory),journal=h.learningJournal(join(c.trustDirectory,"producer-host"));
  const initial=journal.read()[0].value;
  if(initial.type!=="producer-host-initial"||dataDigest(initial.config)!==hostDigest)throw Error("host store binding changed; no new budget");
  const trustInput=trust.history()[0].value.input as {archiveRoot:string;component:unknown;exposure:{attentionRemaining:number}|null};
  if(trustInput.archiveRoot!==c.archiveRoot||trust.inspect(Date.now()).policyId!==c.trustPolicyId||trustInput.exposure&&trustInput.exposure.attentionRemaining>5)throw Error("one scoped five-total attention policy required");
  const authority=()=>{const a=options.authority();if(!a)return null;const safe=detached(a);if(!safe.hostDigests.includes(hostDigest))return null;return safe;};
  const observation=dashboardObservations(h,c,journal.read),history=()=>journal.read();
  const append=(value:Record<string,unknown>)=>journal.append(history().at(-1)!.id,value);
  const saved=():DebriefCheckpoint|null=>{const rows=history().filter(e=>e.value.type==="checkpoint");return rows.length?detached(rows.at(-1)!.value.checkpoint) as DebriefCheckpoint:null;};
  let presenter:DebriefPresenter|undefined,busy=false,poisoned=false,presentationRevision:number|null=null,presenceDigest:string|null=null,attentionDeferred:string|null=null;
  const presence=()=>{const p=options.presence?.();return p&&p.present===true&&p.closing===true&&sha(p.evidenceDigest)&&Number.isFinite(p.expiresAt)&&p.expiresAt>Date.now()?p:null;};
  const persistence:DebriefPersistence={durability:"host-owned",load:saved,compareAndSwap(expected,next){
    const rows=history(),previous=saved();if((previous?dataDigest(previous):null)!==expected)throw Error("stale attention CAS");
    if(previous&&(dataDigest(previous.caseIds)!==dataDigest(next.caseIds)||previous.blindDigest!==next.blindDigest))throw Error("no replacement cards or budget refill");
    const cards=[...next.caseIds,...(next.blindDigest?[next.blindDigest]:[])];if(cards.length>5)throw Error("five total cards");
    if(!previous)for(const card of cards){const result=trust.expose("producer:"+dataDigest({hostDigest,card}),Date.now());if(result.mode!=="ask"){attentionDeferred=result.reason;throw Error("predeclared policy defers this question: "+result.reason);}}
    journal.append(rows.at(-1)!.id,{type:"checkpoint",checkpoint:next});
  }};
  const boundary=async()=>{const dispatch=await budget.controls(null).inspect(),accounting=await budget.inspect();return {dispatch,active:accounting.active};};
  const paused=async(revision:number)=>{const b=await boundary();if(ordinary&&!ordinary.quiescent())throw Error("original ordinary children not quiescent");if(experiment){const view=await experiment.inspect();if(view.budget?.active!==0||view.control!=="not-assessed")throw Error("original experiment not quiescent");}if(!b.dispatch.paused||b.dispatch.admission!=="paused"||b.dispatch.revision!==revision||b.active!==0)throw Error("safe paused selection unavailable");};
  const currentSelection=async()=>budget.binding.intent?(await budget.intentControls(null).inspect()).selection:c.selection;
  const nativeRead=async()=>({dispatch:await budget.controls(null).inspect(),intent:budget.binding.intent?await budget.intentControls(null).inspect():null,experiment:experiment?await experiment.inspect():null,ordinary:ordinary?ordinary.inspect():null});
  const api={hostDigest,selectionDigest,
    async frame(){
      const rows=history(),tip=rows.at(-1)!.id,a=authority();let source:unknown=null,error:string|null=null;
      let selection=c.selection,selectionState="current-control-snapshot";
      try{selection=await currentSelection();}catch(e){error=String(e);selectionState="unavailable-host-declaration-only";}
      try{source=await observation.view(selectionState==="current-control-snapshot"?a:null,selection);}catch(e){error=String(e);}
      let debrief:unknown=null;
      if(a&&presenter&&presentationRevision!==null&&presence()?.evidenceDigest===presenceDigest){try{await paused(presentationRevision);debrief=presenter.view();}catch{debrief=null;}}
      let controls:unknown=null;try{controls=await nativeRead();}catch(e){error=String(e);}
      const attention=trust.inspect(Date.now());
      return freeze(detached({version:"producer-dashboard-frame-v1",hostDigest,selectionDigest:dashboardSelectionDigest(selection),selectionState,tip,source,controls,debrief,attention,error,
        requests:rows.filter(e=>["claim","result","presentation","defer"].includes(String(e.value.type))).map(e=>e.value),
        control:rows.some(e=>e.value.type==="host-failure")?"failed":rows.some(e=>e.value.type==="claim"&&!rows.some(r=>r.value.type==="result"&&r.value.requestId===e.value.requestId))?"unknown":"not-assessed",
        acknowledgement:poisoned?"unknown":"readback-only",identity:"independently-declared-host; not human/module authentication",activeBranch:null,acceptance:"not-assessed",freshness:"snapshot-unknown",workerInteractions:0}));
    },
    /** Explicit reconciliation is read-only. A retained claim is never replayed as an effect. */
    reconcile:()=>api.frame(),
    async action(input:DashboardHostRequest){
      const request=dashboardHostRequest(input),digest=dashboardHostRequestDigest(request);
      if(busy||poisoned)throw Error("dashboard operation busy or acknowledgement unknown");busy=true;let attempted=false;
      try{
        const rows=history(),old=rows.find(e=>e.value.type==="claim"&&e.value.requestId===request.requestId);
        if(old){if(old.value.digest!==digest)throw Error("immutable dashboard request ID");return {state:rows.some(e=>e.value.type==="host-failure")?"failed-or-unknown":"readback-only",result:rows.find(e=>e.value.type==="result"&&e.value.requestId===request.requestId)?.value??null};}
        const selection=request.operation==="observe"?await currentSelection().catch(()=>c.selection):await currentSelection();
        if(request.hostDigest!==hostDigest||request.selectionDigest!==dashboardSelectionDigest(selection)||request.expectedTip!==rows.at(-1)!.id)throw Error("stale dashboard selection/CAS");
        if(rows.some(e=>e.value.type==="host-failure")||rows.some(e=>e.value.type==="claim"&&!rows.some(r=>r.value.type==="result"&&r.value.requestId===e.value.requestId)))throw Error("prior acknowledgement unknown; inspect without repeating effects");
        const a=authority(),approved=Boolean(a?.requestDigests.includes(digest));
        attempted=true;journal.append(request.expectedTip,{type:"claim",requestId:request.requestId,digest,request,decision:approved?"approved":"denied"});
        if(!approved){append({type:"result",requestId:request.requestId,state:"denied"});return {state:"denied"};}
        let result:unknown;
        try{
          if(request.operation==="observe"){
            const captured=observation.observe(request.payload,a!,selection);append({type:"observation",observation:captured});result=captured;
          }else if(request.operation==="present"){
            const p=detached(request.payload) as {userPresent:boolean;closing:boolean;evidenceDigest:string;dispatchRevision:number};
            if(Object.keys(p).sort().join()!=="closing,dispatchRevision,evidenceDigest,userPresent"||!sha(p.evidenceDigest)||typeof p.userPresent!=="boolean"||typeof p.closing!=="boolean"||!Number.isSafeInteger(p.dispatchRevision))throw Error("explicit presence/boundary evidence required");
            if(!p.userPresent||!p.closing||presence()?.evidenceDigest!==p.evidenceDigest){append({type:"defer",requestId:request.requestId,evidence:p,reason:"absent or uncertain closing boundary",weekly:true});presenter?.close();presentationRevision=null;result={state:"deferred"};}
            else{
              await paused(p.dispatchRevision);const cases=observation.latest().find(r=>r.kind==="work")?.cases??c.cases;if(!cases)throw Error("retained selected case batch unavailable");
              const reviewer=cases.version==="work-signals-v1"?h.createWorkSignalReviewer(c.archiveRoot,cases.batchId,c.author):h.createWorkCaseReviewer(c.archiveRoot,cases.batchId,c.author);
              const page=reviewPage(await reviewer.list(0,c.blind?4:5),c.blind?4:5,0,cases.version==="work-signals-v1"?{batchId:cases.batchId,observationId:cases.observationId}:undefined);
              if(page.items.some(i=>dataDigest({kind:"detector",...i.candidate.detector as object})!==dataDigest(trustInput.component)))throw Error("case population/version differs from predeclared trust policy");
              presenter=createRetainedDebrief(h,{archiveRoot:c.archiveRoot,scope:c.scope,author:c.author,cases,blind:c.blind??undefined,persistence});
              attentionDeferred=null;const view=await presenter.open({mode:"manual",userPresent:true});await paused(p.dispatchRevision);
              if(attentionDeferred){presenter.close();presentationRevision=null;append({type:"defer",requestId:request.requestId,reason:attentionDeferred,weekly:true});result={state:"deferred",reason:attentionDeferred};}
              else {if(view.state!=="open")throw Error("presentation data/attention acknowledgement unavailable");
                presentationRevision=p.dispatchRevision;presenceDigest=p.evidenceDigest;const frameDigest=dataDigest(view);append({type:"presentation",requestId:request.requestId,evidence:p,frameDigest,state:"prepared-not-delivery",automatic:"unqualified"});result={state:"prepared",frameDigest};}
            }
          }else if(request.operation==="presented"){
            const p=detached(request.payload) as {frameDigest:string};if(Object.keys(p).join()!=="frameDigest"||!presenter||presentationRevision===null)throw Error("original prepared presentation required");
            await paused(presentationRevision);if(presence()?.evidenceDigest!==presenceDigest)throw Error("user absent/presence changed");if(p.frameDigest!==dataDigest(presenter.view()))throw Error("stale presentation acknowledgement");result={state:"host-acknowledged-presentation",frameDigest:p.frameDigest,humanAuthentication:"unqualified"};
          }else if(request.operation==="defer"){
            presenter?.close();presentationRevision=null;append({type:"defer",requestId:request.requestId,weekly:true,evidence:request.payload});result={state:"deferred"};
          }else if(request.operation==="debrief"){
            if(!presenter||presentationRevision===null||typeof request.payload!=="string")throw Error("original paused presenter required");await paused(presentationRevision);if(presence()?.evidenceDigest!==presenceDigest)throw Error("user absent/presence changed");result=await debriefAction(presenter,request.payload);await paused(presentationRevision);if(result==="unknown"||result==="stale-or-unknown")throw Error("debrief writer acknowledgement unknown");
          }else{
            presenter?.close();presentationRevision=null;
            if(request.operation==="dispatch"||request.operation==="dispatch-reconcile"){
              const native=dispatchRequest(request.payload as DispatchRequest);if(native.action==="cancel-execution")throw Error("cancellation needs exact separately approved native bridge");
              const port=budget.controls(a!.dispatch);
              if(request.operation==="dispatch-reconcile"&&(await port.inspect()).records.find(r=>r.request.requestId===native.requestId)?.digest!==dispatchRequestDigest(native))throw Error("exact original dispatch reconciliation required");
              result=request.operation==="dispatch"?await port.request(native):await port.reconcile(native.requestId);
            }else if(request.operation==="intent"||request.operation==="intent-reconcile"){
              const native=detached(intentRequest(request.payload as IntentRequest)) as IntentRequest,port=budget.intentControls(a!.dispatch);result=request.operation==="intent"?await port.request(native):await port.reconcile(native);
            }else if(request.operation==="ordinary-cancel"){
              if(!ordinary||!isOrdinaryChildren(ordinary))throw Error("original ordinary child handles unavailable; no recovery");
              result=ordinary.cancel(request.payload as OrdinaryCancellation,a!.ordinary??null);
            }else if(request.operation==="cancel"){
              const p=detached(request.payload) as {dispatch:DispatchRequest;cancellation:ExperimentCancellation};controlShape(p,["dispatch","cancellation"]);const legacy=dispatchRequest(p.dispatch);
              const current=await budget.controls(null).inspect();
              if(!experiment||!isExperimentController(experiment)||legacy.action!=="cancel-execution"||legacy.bindingDigest!==c.budgetDigest||legacy.expectedRevision!==current.revision||legacy.targetExecutionId!==p.cancellation.executionId||legacy.requestId!==p.cancellation.requestId)throw Error("exact original cancellation target/revision required");
              if(a!.dispatch?.authorityDigest!==budget.binding.authorityDigest||!a!.dispatch.requestDigests.includes(dispatchRequestDigest(legacy)))throw Error("independent legacy cancellation authority required");
              result=await experiment.cancel(p.cancellation,a!.experiment);
            }else throw Error("unsupported dashboard operation");
          }
        }catch(error){presenter?.close();presentationRevision=null;append({type:"result",requestId:request.requestId,state:"failed-or-unknown",reason:String(error)});throw error;}
        append({type:"result",requestId:request.requestId,state:"acknowledged",resultDigest:dataDigest(result??null)});return {state:"acknowledged",result};
      }catch(error){poisoned=true;if(attempted){try{if(history().some(e=>e.value.type==="claim"&&e.value.requestId===request.requestId))append({type:"host-failure",requestId:request.requestId,reason:String(error)});}catch{/* Failure recording also unacknowledged; no claim of no effects. */}}throw error;}finally{busy=false;}
    }
  };hosts.add(api);return Object.freeze(api);
}
