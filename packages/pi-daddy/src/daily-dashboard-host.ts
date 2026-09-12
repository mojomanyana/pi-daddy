import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, join } from "node:path";
import { createDashboardHost, dashboardHostDigest, dashboardHostRequestDigest, type DashboardHostAuthority, type DashboardHostConfig, type DashboardHostRequest } from "./dashboard-host.ts";
import type { DashboardHarness } from "./dashboard-host-contract.ts";
import { loadedDashboardHarnessDigest } from "./dashboard-harness.ts";
import { createIntentBudget, openResourceBudget, resourceBindingDigest } from "./resource-budget.ts";
import { dispatchRequestDigest, type DispatchRequest } from "./dispatch-control.ts";
import { serveDashboardHost } from "./dashboard-host-transport.ts";
import { rebindDeclaredWork, type DeclaredWorkState } from "./work-command.ts";
import { ordinaryCancellation, ordinaryCancellationDigest, type OrdinaryChildren, type OrdinaryTarget } from "./ordinary-children.ts";
import { dataDigest } from "./debrief-contract.ts";
import { bindWorkIntent } from "./intent-application.ts";
import { intentKey, intentRequest, intentRequestDigest, type IntentPriority, type IntentRequest, type IntentSelection } from "./intent-control.ts";
import { parseWorkLedgerText, type WorkRevisionEvent, type WorkSnapshotEvent } from "./work-ledger.ts";
import { resolveWorkSnapshotText } from "./work-ledger-snapshot.ts";

export interface DailyIntentAction {key:string;label:string;action:"revise-scope"|"reprioritize"|"select-alternative";fromSelection:IntentSelection;events:(WorkRevisionEvent|WorkSnapshotEvent)[];selection:IntentSelection;priorities:IntentPriority[]}
export interface DailyDashboardHostInput {id:string;cwd:string;directory:string;socketPath?:string;declared:DeclaredWorkState;ordinary:OrdinaryChildren;harness:DashboardHarness;author:string;priorities?:IntentPriority[];intentActions?:DailyIntentAction[];presence?:()=>{present:boolean;closing:boolean;evidenceDigest:string;expiresAt:number}|null;onDeclaredWorkChanged?:(state:DeclaredWorkState)=>void|Promise<void>}
const idPattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const same=(a:unknown,b:unknown)=>intentKey(a)===intentKey(b);
/** Recorded P01 snapshots become labelled proposals; choosing a label still traverses intent validation and exact host/CAS authority. */
export function discoverDailyIntentActions(text:string,selection:IntentSelection,priorities:readonly IntentPriority[]):DailyIntentAction[]{
 const parsed=parseWorkLedgerText(text);if(!parsed.complete||parsed.events.length>512)throw Error("bounded complete recorded proposal ledger required");const label=(value:string)=>value.length<=80?value:`${value.slice(0,67)}…${hash(value).slice(0,12)}`;
 const current=resolveWorkSnapshotText(text,selection);if(current.scopeState!=="valid"||!current.scope||!current.snapshot)throw Error("current declared work unavailable");
 const actions:DailyIntentAction[]=[];for(const priority of priorities.slice(1)){
  const ordered=[priority,...priorities.filter(x=>!same(x.obligation,priority.obligation))].map((x,rank)=>({...x,rank}));
  actions.push({key:`priority-${hash(intentKey(priority.obligation)).slice(0,12)}`,label:`Put ${label(priority.obligation.id)} first`,action:"reprioritize",fromSelection:selection,events:[],selection,priorities:ordered});
 }
 for(const event of parsed.events){if(event.event!=="work_snapshot")continue;const candidate={snapshot:{id:event.payload.snapshot.snapshotId,digest:event.payload.snapshot.digest},event:{eventId:event.eventId,digest:event.digest}};if(same(candidate,selection))continue;
  const next=resolveWorkSnapshotText(text,candidate);if(next.scopeState!=="valid"||!next.scope||!next.snapshot||next.snapshot.bindings.length>32)continue;
  const action=next.scope.digest===current.scope.digest?"select-alternative":next.scope.predecessor&&same(next.scope.predecessor,{kind:current.scope.kind,id:current.scope.id,revision:current.scope.revision,digest:current.scope.digest})?"revise-scope":null;if(!action)continue;
  actions.push({key:`${action==="revise-scope"?"scope":"alternative"}-${hash(intentKey(candidate)).slice(0,12)}`,label:`Select recorded ${action==="revise-scope"?"scope":"alternative"} ${label(event.payload.snapshot.snapshotId)}`,action,fromSelection:selection,events:[],selection:candidate,priorities:next.snapshot.bindings.map((b,rank)=>({obligation:b.obligation,rank}))});
 }
 return actions.sort((a,b)=>a.key.localeCompare(b.key)).slice(0,8);
}

/** One explicitly started, process-owned daily host. No authority, controller or prior host is recovered from disk. */
export async function startDailyDashboardHost(input:DailyDashboardHostInput){
 if(!idPattern.test(input.id)||!isAbsolute(input.cwd)||resolve(input.cwd)!==input.cwd||!isAbsolute(input.directory)||resolve(input.directory)!==input.directory||!input.author.trim()||input.author.length>256)throw Error("explicit bounded daily host configuration required");
 const harnessDigest=loadedDashboardHarnessDigest(input.harness);if(!harnessDigest)throw Error("loaded skill-harness bridge required");
 if(input.declared.ledgerPath!==join(input.cwd,".pi","work.jsonl"))throw Error("current declared work must belong to this host project");
 await mkdir(input.directory,{mode:0o700});const archiveRoot=join(input.directory,"archive");await mkdir(archiveRoot,{mode:0o700});
 const reference=input.harness.retainArchiveSource(archiveRoot,{sourceId:`host-${input.id}-bootstrap`,parser:{id:"daily-host-bootstrap",version:"1"},retention:"exact",bytes:Buffer.from("explicit daily host bootstrap")});
 const component={kind:"detector",id:"coverage_gap",version:"work-signals-v1:declared-work-v1",population:`daily:${input.id}`};
 const trustInput={archiveRoot,component,seed:hash(`daily-host\0${input.id}`),maxUnflagged:0,cohort:[{incidentId:"bootstrap",manifestId:reference.manifestId,flagged:true,split:"calibration"}],exposure:null};
 const trustPolicyId=input.harness.trustPolicyDigest(trustInput),trustDirectory=join(input.directory,"trust");input.harness.createTrustLifecycle(trustDirectory,trustInput,[trustPolicyId]);
 const workRelative="work.jsonl",factsRelative="facts.jsonl",workMirror=join(input.directory,workRelative);await writeFile(workMirror,await readFile(input.declared.ledgerPath),{mode:0o600,flag:"wx"});
 const refreshWork=async()=>{const temporary=`${workMirror}.${process.pid}.${randomUUID()}.tmp`;try{await writeFile(temporary,await readFile(input.declared.ledgerPath),{mode:0o600,flag:"wx"});await rename(temporary,workMirror);}finally{await rm(temporary,{force:true});}};
 const facts={scopeDigest:input.declared.selectedSnapshot.snapshot.digest,version:"declared-work-v1",population:`daily:${input.id}`,expectedWaits:[],checkpoints:[],violations:[],priorAccepted:[]};await writeFile(join(input.directory,factsRelative),JSON.stringify(facts)+"\n",{mode:0o600,flag:"wx"});
 const policy={version:"archive-policy-v2",id:`daily-${input.id}`,revision:"1",sourceRoot:input.directory,archiveRoot,maxBytes:8*1024*1024,retention:"exact",expiresAt:new Date(Date.now()+24*60*60*1000).toISOString(),sources:[{id:"work",path:workRelative,parser:{id:"pi-daddy-work-ledger",version:"4"},contentPolicy:"manifest-only"},{id:"facts",path:factsRelative,parser:{id:"pi-daddy-work-signal-facts",version:"1"},contentPolicy:"manifest-only"}]};
 const policyPath=join(input.directory,"archive-policy.json"),policyBytes=JSON.stringify(policy);await writeFile(policyPath,policyBytes,{mode:0o600,flag:"wx"});
 const authorityDigest=dataDigest({kind:"daily-dashboard-host",id:input.id,cwd:input.cwd}),initialPriorities=input.priorities??[{obligation:input.declared.obligation,rank:0}];
 const workIntent=await bindWorkIntent({path:input.declared.ledgerPath,grantLedgerPath:input.declared.grantLedgerPath,selection:input.declared.selectedSnapshot,priorities:initialPriorities});
 const budget=await createIntentBudget({directory:join(input.directory,"budget"),authorityDigest,limits:{maxAttempts:6,maxInputBytes:65536,maxConcurrent:3}},workIntent);
 const config:DashboardHostConfig={version:"producer-dashboard-host-v1",trustDirectory,trustPolicyId,archiveRoot,scope:`daily:${input.id}`,author:input.author,policyPath,policySha256:hash(policyBytes),sources:[{id:"work",kind:"work"},{id:"facts",kind:"facts"}],selection:input.declared.selectedSnapshot,cases:null,blind:null,budgetDigest:resourceBindingDigest(budget),experimentDigest:null,harnessArtifactDigest:harnessDigest,ordinaryDigest:input.ordinary.bindingDigest};
 const proposals=input.intentActions??[];if(proposals.length>8||new Set(proposals.map(x=>x.key)).size!==proposals.length||proposals.some(x=>!idPattern.test(x.key)||typeof x.label!=="string"||!x.label.trim()||Buffer.byteLength(x.label)>120))throw Error("bounded friendly intent actions required");
 const requestDigests=new Set<string>(),dispatchDigests=new Set<string>(),ordinaryDigests=new Set<string>();let host:ReturnType<typeof createDashboardHost>,factsResultManifest:string|null=null,workSelection:IntentSelection=input.declared.selectedSnapshot,declaredState=input.declared,reboundSnapshotId:string|null=null;
 const authority=():DashboardHostAuthority=>({hostDigests:[dashboardHostDigest(config)],requestDigests:[...requestDigests],workContext:{selectedSnapshot:workSelection,authority:null},dispatch:{authorityDigest,requestDigests:[...dispatchDigests]},experiment:null,ordinary:{bindingDigest:input.ordinary.bindingDigest,requestDigests:[...ordinaryDigests]}});
 const request=(context:{hostDigest:string;selectionDigest:string;tip:string},operation:DashboardHostRequest["operation"],payload:unknown,requestId:string):DashboardHostRequest=>({version:"1.0",requestId,hostDigest:context.hostDigest,selectionDigest:context.selectionDigest,expectedTip:context.tip,operation,payload});
 host=createDashboardHost({harness:input.harness,config,budget,ordinary:input.ordinary,authority,beforeObservation:sourceId=>sourceId==="work"?refreshWork():Promise.resolve(),humanActions:async context=>{
   const state=await openResourceBudget(budget).controls(null).inspect(),action=state.paused?"resume-dispatch":"pause-dispatch",key=state.paused?"resume-dispatch":"pause-new-dispatch";
   const native:DispatchRequest={version:"1.0",requestId:`${action}:${state.revision}`,bindingDigest:config.budgetDigest,expectedRevision:state.revision,action,targetExecutionId:null};dispatchDigests.add(dispatchRequestDigest(native));
   const hostRequest=request(context,"dispatch",native,`host-${action}:${state.revision}`);requestDigests.add(dashboardHostRequestDigest(hostRequest));
   const previous=context.observations.find(x=>x.sourceId==="work")?.checkpointId??null,refresh=request(context,"observe",{sourceId:"work",previousCheckpointId:previous,facts:context.observations.find(x=>x.sourceId==="facts")?.checkpointId?factsResultManifest:null},`refresh-work:${state.revision}:${context.tip.slice(0,12)}`);requestDigests.add(dashboardHostRequestDigest(refresh));
   const intentState=await openResourceBudget(budget).intentControls(null).inspect(),automatic=discoverDailyIntentActions(await readFile(input.declared.ledgerPath,"utf8"),intentState.selection,intentState.priorities);
   const candidates=[...proposals,...automatic].filter((p,index,all)=>all.findIndex(x=>x.key===p.key)===index).filter(p=>p.action==="reprioritize"||Boolean(input.onDeclaredWorkChanged)).slice(0,8);
   const intents=(input.ordinary.quiescent()?candidates:[]).filter(p=>intentKey(p.fromSelection)===intentKey(intentState.selection)).map(p=>{
    const native=intentRequest({version:"intent-request-v1",requestId:`${p.key}:${intentState.revision}`,bindingDigest:config.budgetDigest,expectedRevision:intentState.revision,expectedSelection:intentState.selection,action:p.action,events:p.events,selection:p.selection,priorities:p.priorities});dispatchDigests.add(intentRequestDigest(native));
    const proposed=request(context,"intent",native,`host-intent:${p.key}:${intentState.revision}`);requestDigests.add(dashboardHostRequestDigest(proposed));return {key:p.key,label:p.label,request:proposed};
   });
   const ordinary=input.ordinary.inspect() as {revision:number;children:{target:OrdinaryTarget;state:string;abortRequested:boolean}[]},accounting=await openResourceBudget(budget).inspect(),presence=input.presence?.();
   const presentation:{key:string;label:string;request:DashboardHostRequest}[]=[];
   if(context.preparedPresentationDigest){const shown=request(context,"presented",{frameDigest:context.preparedPresentationDigest},`host-presented:${state.revision}:${context.tip.slice(0,12)}`);requestDigests.add(dashboardHostRequestDigest(shown));presentation.push({key:"acknowledge-case-cards",label:"Acknowledge these case cards are visible",request:shown});}
   else if(presence?.present===true&&presence.closing===true&&presence.expiresAt>Date.now()&&state.paused&&accounting.active===0&&!ordinary.children.some(row=>row.state==="active")){const present=request(context,"present",{userPresent:true,closing:true,evidenceDigest:presence.evidenceDigest,dispatchRevision:state.revision},`host-present:${state.revision}:${context.tip.slice(0,12)}`);requestDigests.add(dashboardHostRequestDigest(present));presentation.push({key:"prepare-case-cards",label:"Prepare up to five retained case cards",request:present});}
   const cancellations=ordinary.children.filter(row=>row.state==="active"&&!row.abortRequested).sort((a,b)=>a.target.executionId.localeCompare(b.target.executionId)).slice(0,8).map(row=>{
    const native=ordinaryCancellation({version:"ordinary-cancel-v1",requestId:`cancel:${row.target.executionId.slice(5)}`,bindingDigest:input.ordinary.bindingDigest,expectedRevision:ordinary.revision,target:row.target});ordinaryDigests.add(ordinaryCancellationDigest(native));
    const cancel=request(context,"ordinary-cancel",native,`host-cancel:${row.target.executionId.slice(5)}:${ordinary.revision}`);requestDigests.add(dashboardHostRequestDigest(cancel));
    return {key:`cancel-${row.target.executionId.replace(":","-")}-${ordinary.revision.toString(36)}`,label:`Cancel running attempt ${row.target.executionId}`,request:cancel};
   });
   return [{key,label:state.paused?"Resume new governed dispatch":"Pause new governed dispatch; running children continue",request:hostRequest},{key:"refresh-current-work",label:reboundSnapshotId?`Capture rebound declared work; next dispatch uses ${reboundSnapshotId}`:"Capture current declared work and attempts",request:refresh},...intents,...presentation,...cancellations];
 },afterIntentApplied:async selection=>{const rebound=await rebindDeclaredWork(declaredState,selection);declaredState=rebound;workSelection=selection;reboundSnapshotId=selection.snapshot.id;await input.onDeclaredWorkChanged?.(rebound);},presence:input.presence});
 const before=await host.frame(),observeFacts=request({hostDigest:host.hostDigest,selectionDigest:before.selectionDigest,tip:before.tip},"observe",{sourceId:"facts",previousCheckpointId:null,facts:null},"observe-current-facts");requestDigests.add(dashboardHostRequestDigest(observeFacts));const factsResult=await host.action(observeFacts) as {result:{sourceManifestId:string}};factsResultManifest=factsResult.result.sourceManifestId;
 const afterFacts=await host.frame(),observeWork=request({hostDigest:host.hostDigest,selectionDigest:afterFacts.selectionDigest,tip:afterFacts.tip},"observe",{sourceId:"work",previousCheckpointId:null,facts:factsResult.result.sourceManifestId},"observe-current-work");requestDigests.add(dashboardHostRequestDigest(observeWork));await host.action(observeWork);
 const socketPath=input.socketPath??join(input.directory,"dashboard.sock"),server=await serveDashboardHost(socketPath,host);
 let closed=false;return Object.freeze({host,socketPath,directory:input.directory,async close(){if(closed)return;closed=true;await server.close();}});
}
