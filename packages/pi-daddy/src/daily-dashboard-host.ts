import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, join } from "node:path";
import { createDashboardHost, dashboardHostDigest, dashboardHostRequestDigest, type DashboardHostAuthority, type DashboardHostConfig, type DashboardHostRequest } from "./dashboard-host.ts";
import type { DashboardHarness } from "./dashboard-host-contract.ts";
import { loadedDashboardHarnessDigest } from "./dashboard-harness.ts";
import { createDispatchBudget, openResourceBudget, resourceBindingDigest } from "./resource-budget.ts";
import { dispatchRequestDigest, type DispatchRequest } from "./dispatch-control.ts";
import { serveDashboardHost } from "./dashboard-host-transport.ts";
import type { DeclaredWorkState } from "./work-command.ts";
import type { OrdinaryChildren } from "./ordinary-children.ts";
import { dataDigest } from "./debrief-contract.ts";

export interface DailyDashboardHostInput {id:string;cwd:string;directory:string;socketPath?:string;declared:DeclaredWorkState;ordinary:OrdinaryChildren;harness:DashboardHarness;author:string}
const idPattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");

/** One explicitly started, process-owned daily host. No authority, controller or prior host is recovered from disk. */
export async function startDailyDashboardHost(input:DailyDashboardHostInput){
 if(!idPattern.test(input.id)||!isAbsolute(input.cwd)||resolve(input.cwd)!==input.cwd||!isAbsolute(input.directory)||resolve(input.directory)!==input.directory||!input.author.trim()||input.author.length>256)throw Error("explicit bounded daily host configuration required");
 const harnessDigest=loadedDashboardHarnessDigest(input.harness);if(!harnessDigest)throw Error("loaded skill-harness bridge required");
 if(input.declared.ledgerPath!==join(input.cwd,".pi","work.jsonl"))throw Error("current declared work must belong to this host project");
 await mkdir(input.directory,{mode:0o700});const archiveRoot=join(input.directory,"archive");await mkdir(archiveRoot,{mode:0o700});
 const reference=input.harness.retainArchiveSource(archiveRoot,{sourceId:`host-${input.id}-bootstrap`,parser:{id:"daily-host-bootstrap",version:"1"},retention:"exact",bytes:Buffer.from("explicit daily host bootstrap")});
 const component={kind:"detector",id:"retained-work",version:"1",population:`daily:${input.id}`};
 const trustInput={archiveRoot,component,seed:hash(`daily-host\0${input.id}`),maxUnflagged:0,cohort:[{incidentId:"bootstrap",manifestId:reference.manifestId,flagged:true,split:"calibration"}],exposure:null};
 const trustPolicyId=input.harness.trustPolicyDigest(trustInput),trustDirectory=join(input.directory,"trust");input.harness.createTrustLifecycle(trustDirectory,trustInput,[trustPolicyId]);
 const workRelative="work.jsonl",factsRelative="facts.jsonl",workMirror=join(input.directory,workRelative);await writeFile(workMirror,await readFile(input.declared.ledgerPath),{mode:0o600,flag:"wx"});
 const refreshWork=async()=>{const temporary=`${workMirror}.${process.pid}.${randomUUID()}.tmp`;try{await writeFile(temporary,await readFile(input.declared.ledgerPath),{mode:0o600,flag:"wx"});await rename(temporary,workMirror);}finally{await rm(temporary,{force:true});}};
 const facts={scopeDigest:input.declared.selectedSnapshot.snapshot.digest,version:"declared-work-v1",population:`daily:${input.id}`,expectedWaits:[],checkpoints:[],violations:[],priorAccepted:[]};await writeFile(join(input.directory,factsRelative),JSON.stringify(facts)+"\n",{mode:0o600,flag:"wx"});
 const policy={version:"archive-policy-v2",id:`daily-${input.id}`,revision:"1",sourceRoot:input.directory,archiveRoot,maxBytes:8*1024*1024,retention:"exact",expiresAt:new Date(Date.now()+24*60*60*1000).toISOString(),sources:[{id:"work",path:workRelative,parser:{id:"pi-daddy-work-ledger",version:"4"},contentPolicy:"manifest-only"},{id:"facts",path:factsRelative,parser:{id:"pi-daddy-work-signal-facts",version:"1"},contentPolicy:"manifest-only"}]};
 const policyPath=join(input.directory,"archive-policy.json"),policyBytes=JSON.stringify(policy);await writeFile(policyPath,policyBytes,{mode:0o600,flag:"wx"});
 const authorityDigest=dataDigest({kind:"daily-dashboard-host",id:input.id,cwd:input.cwd}),budget=await createDispatchBudget({directory:join(input.directory,"budget"),authorityDigest,limits:{maxAttempts:6,maxInputBytes:65536,maxConcurrent:3}});
 const config:DashboardHostConfig={version:"producer-dashboard-host-v1",trustDirectory,trustPolicyId,archiveRoot,scope:`daily:${input.id}`,author:input.author,policyPath,policySha256:hash(policyBytes),sources:[{id:"work",kind:"work"},{id:"facts",kind:"facts"}],selection:input.declared.selectedSnapshot,cases:null,blind:null,budgetDigest:resourceBindingDigest(budget),experimentDigest:null,harnessArtifactDigest:harnessDigest,ordinaryDigest:input.ordinary.bindingDigest};
 const requestDigests=new Set<string>(),dispatchDigests=new Set<string>();let host:ReturnType<typeof createDashboardHost>,factsResultManifest:string|null=null;
 const authority=():DashboardHostAuthority=>({hostDigests:[dashboardHostDigest(config)],requestDigests:[...requestDigests],workContext:{selectedSnapshot:config.selection,authority:null},dispatch:{authorityDigest,requestDigests:[...dispatchDigests]},experiment:null});
 const request=(context:{hostDigest:string;selectionDigest:string;tip:string},operation:DashboardHostRequest["operation"],payload:unknown,requestId:string):DashboardHostRequest=>({version:"1.0",requestId,hostDigest:context.hostDigest,selectionDigest:context.selectionDigest,expectedTip:context.tip,operation,payload});
 host=createDashboardHost({harness:input.harness,config,budget,ordinary:input.ordinary,authority,beforeObservation:sourceId=>sourceId==="work"?refreshWork():Promise.resolve(),humanActions:async context=>{
   const state=await openResourceBudget(budget).controls(null).inspect(),action=state.paused?"resume-dispatch":"pause-dispatch",key=state.paused?"resume-dispatch":"pause-new-dispatch";
   const native:DispatchRequest={version:"1.0",requestId:`${action}:${state.revision}`,bindingDigest:config.budgetDigest,expectedRevision:state.revision,action,targetExecutionId:null};dispatchDigests.add(dispatchRequestDigest(native));
   const hostRequest=request(context,"dispatch",native,`host-${action}:${state.revision}`);requestDigests.add(dashboardHostRequestDigest(hostRequest));
   const previous=context.observations.find(x=>x.sourceId==="work")?.checkpointId??null,refresh=request(context,"observe",{sourceId:"work",previousCheckpointId:previous,facts:context.observations.find(x=>x.sourceId==="facts")?.checkpointId?factsResultManifest:null},`refresh-work:${state.revision}:${context.tip.slice(0,12)}`);requestDigests.add(dashboardHostRequestDigest(refresh));
   return [{key,label:state.paused?"Resume new governed dispatch":"Pause new governed dispatch; running children continue",request:hostRequest},{key:"refresh-current-work",label:"Capture current declared work and attempts",request:refresh}];
 }});
 const before=await host.frame(),observeFacts=request({hostDigest:host.hostDigest,selectionDigest:before.selectionDigest,tip:before.tip},"observe",{sourceId:"facts",previousCheckpointId:null,facts:null},"observe-current-facts");requestDigests.add(dashboardHostRequestDigest(observeFacts));const factsResult=await host.action(observeFacts) as {result:{sourceManifestId:string}};factsResultManifest=factsResult.result.sourceManifestId;
 const afterFacts=await host.frame(),observeWork=request({hostDigest:host.hostDigest,selectionDigest:afterFacts.selectionDigest,tip:afterFacts.tip},"observe",{sourceId:"work",previousCheckpointId:null,facts:factsResult.result.sourceManifestId},"observe-current-work");requestDigests.add(dashboardHostRequestDigest(observeWork));await host.action(observeWork);
 const socketPath=input.socketPath??join(input.directory,"dashboard.sock"),server=await serveDashboardHost(socketPath,host);
 let closed=false;return Object.freeze({host,socketPath,directory:input.directory,async close(){if(closed)return;closed=true;await server.close();}});
}
