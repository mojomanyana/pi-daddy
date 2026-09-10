import { cloneExperiment, closed, experimentHash, experimentCharter, byteHash, type ExperimentCharter } from "./experiment-contract.ts";
import { resourceBindingDigest, type ExperimentBudgetBinding } from "./resource-budget.ts";
import { workIntentBinding, readIntentWork, resolveIntent } from "./intent-application.ts";
import type { WorkIntentBinding } from "./intent-control.ts";
import type { WorkFrozen, RevisionRef } from "./work-ledger-types.ts";
import type { AdoptionAuthority, AdoptionFacts, AdoptionBinding, AdoptionReceipt } from "./vendor/adoption.ts";
import { parseWorkJson } from "./work-ledger-json.ts";
import { orderSchedule } from "./order-schedule.ts";
export { factoryDecisionDigest, type FactoryDecision } from "./order-schedule.ts";
export interface FixedPolicy {version:"fixed-policy-v1";suffixBase64:string;acceptancePolicyDigest:string;grants:readonly string[];effects:readonly "fixed-digest"[];model:null;effort:null;skills:readonly string[]}
export const fixedPolicyDigest=(p:FixedPolicy)=>experimentHash(fixedPolicy(p));
const hex=(x:unknown)=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
export function fixedPolicy(value:FixedPolicy):FixedPolicy{const p=cloneExperiment(value);closed(p,["version","suffixBase64","acceptancePolicyDigest","grants","effects","model","effort","skills"]);
  if(p.version!=="fixed-policy-v1"||!hex(p.acceptancePolicyDigest)||typeof p.suffixBase64!=="string"||p.suffixBase64.length>2048||Buffer.from(p.suffixBase64,"base64").toString("base64")!==p.suffixBase64||JSON.stringify(p.grants)!=="[]"||JSON.stringify(p.effects)!=='["fixed-digest"]'||p.model!==null||p.effort!==null||JSON.stringify(p.skills)!=="[]")throw new Error("unsupported policy or grant expansion");return p;}
export interface FactoryOrderCharter {version:"factory-order-v1";orderId:string;directory:string;budget:ExperimentBudgetBinding;work:WorkFrozen<WorkIntentBinding>;workTextDigest:string;scopeDigest:string;commonBase64:string;deadlineMs:number;pin:{revision:number;candidateDigest:string};nodes:readonly {nodeId:string;obligation:RevisionRef;dependencies:readonly string[];attempts:readonly {executionId:string;suffixBase64:string;operation:"digest"|"hold"}[];expectedDigest:string;decision:{decisionId:string;authorityId:string}|null}[]}
/** Digest of the entire bounded proposal; validation at application is separate. */
export const factoryOrderDigest=(c:FactoryOrderCharter)=>experimentHash(c);
export interface FactoryAuthority {id:string;orderDigests:readonly string[];decisionDigests:readonly string[];cancellationDigests?:readonly string[];activationDigests:readonly string[];migrationDigests:readonly string[];adoption:AdoptionAuthority|null;facts:readonly {bindingId:string;facts:AdoptionFacts}[]}
export function factoryAuthority(value:FactoryAuthority|null):FactoryAuthority|null{if(value===null)return null;const a=cloneExperiment(value);closed(a,["id","orderDigests","decisionDigests","activationDigests","migrationDigests","adoption","facts",...(Object.hasOwn(a,"cancellationDigests")?["cancellationDigests"]:[])]);
  if(typeof a.id!=="string"||!/^[a-zA-Z0-9:_-]{1,128}$/.test(a.id)||[a.orderDigests,a.decisionDigests,a.activationDigests,a.migrationDigests,...(Object.hasOwn(a,"cancellationDigests")?[a.cancellationDigests!]:[])].some(xs=>!Array.isArray(xs)||xs.length>128||xs.some(x=>!hex(x)))||!Array.isArray(a.facts)||a.facts.length>128)throw new Error("invalid independent factory authority");
  const ids=new Set<string>();for(const f of a.facts as FactoryAuthority["facts"]){closed(f,["bindingId","facts"]);if(!hex(f.bindingId)||ids.has(f.bindingId))throw new Error("ambiguous independent facts");ids.add(f.bindingId);}
  if(a.adoption!==null){closed(a.adoption,["id","adoptions","rollbacks"]);if(a.adoption.id!==a.id)throw new Error("independent authority identity mismatch");}
  return a;}
export function requireFactoryAuthority(a:FactoryAuthority|null,id:string){if(!a||a.id!==id)throw new Error("independent factory authority required");return a;}
export interface ActivationRequest {version:"factory-activation-v1";requestId:string;expectedRevision:number;expectedCandidateDigest:string;candidate:FixedPolicy;binding:AdoptionBinding;receipt:AdoptionReceipt}
export const activationRequestDigest=(r:ActivationRequest)=>experimentHash(r);
export function factoryCharter(value:FactoryOrderCharter):FactoryOrderCharter{
  const c=cloneExperiment(value);closed(c,["version","orderId","directory","budget","work","workTextDigest","scopeDigest","commonBase64","deadlineMs","pin","nodes"]);closed(c.pin,["revision","candidateDigest"]);
  if(c.version!=="factory-order-v1"||!/^[a-zA-Z0-9:_-]{1,128}$/.test(c.orderId)||typeof c.directory!=="string"||!hex(c.workTextDigest)||!hex(c.scopeDigest)||!hex(c.pin.candidateDigest)||!Number.isSafeInteger(c.pin.revision)||c.pin.revision<0||typeof c.commonBase64!=="string"||c.commonBase64.length>22000||Buffer.from(c.commonBase64,"base64").toString("base64")!==c.commonBase64||Buffer.byteLength(JSON.stringify(c))>48000||c.budget.version!=="4.0")throw new Error("invalid bounded factory charter");
  c.work=workIntentBinding(JSON.parse(JSON.stringify(c.work)));if(c.scopeDigest!==experimentHash(c.work.selection.snapshot))throw new Error("changed scope");
  if(!Array.isArray(c.nodes)||!c.nodes.length||c.nodes.length>16)throw new Error("bounded nodes required");
  for(const n of c.nodes as FactoryOrderCharter["nodes"]){closed(n,["nodeId","obligation","dependencies","attempts","expectedDigest","decision"]);if(!Array.isArray(n.attempts)||!n.attempts.length||n.attempts.length>3)throw new Error("bounded recovery required");for(const a of n.attempts){closed(a,["executionId","suffixBase64","operation"]);if(typeof a.suffixBase64!=="string"||a.suffixBase64.length>22000||Buffer.from(a.suffixBase64,"base64").toString("base64")!==a.suffixBase64)throw new Error("invalid attempt byte suffix");}}
  orderSchedule({version:"order-schedule-v1",policyDigest:c.pin.candidateDigest,nodes:(c.nodes as FactoryOrderCharter["nodes"]).map(n=>({nodeId:n.nodeId,dependencies:n.dependencies,executions:n.attempts.map(a=>a.executionId),expectedDigest:n.expectedDigest,decision:n.decision}))},(c.nodes as FactoryOrderCharter["nodes"]).flatMap(n=>n.attempts.map(a=>a.executionId)));
  return c;
}
export const parseFactoryOrder = (text:string) => factoryCharter(parseWorkJson(text) as unknown as FactoryOrderCharter);
export async function compileFactoryOrder(value:FactoryOrderCharter,candidate:FixedPolicy):Promise<ExperimentCharter>{
  const c=factoryCharter(value),p=fixedPolicy(candidate),text=await readIntentWork(c.work);
  if(byteHash(text)!==c.workTextDigest||fixedPolicyDigest(p)!==c.pin.candidateDigest)throw new Error("work or candidate drift");
  const intent=resolveIntent(text,c.work.selection,c.work.priorities),refs=intent.snapshot!.bindings.map(b=>experimentHash(b.obligation)).sort();
  if(JSON.stringify(refs)!==JSON.stringify(c.nodes.map(n=>experimentHash(n.obligation)).sort()))throw new Error("order must cover exact selected obligations");
  for(const n of c.nodes){const rev=intent.revisions.find(r=>experimentHash({kind:r.kind,id:r.id,revision:r.revision,digest:r.digest})===experimentHash(n.obligation));if(!rev||!rev.permittedEffects.includes("read"))throw new Error("unsupported obligation effects");for(const dep of rev.dependencies.filter(d=>d.kind==="obligation")){const parent=c.nodes.find(m=>experimentHash(m.obligation)===experimentHash(dep));if(!parent||!n.dependencies.includes(parent.nodeId))throw new Error("required intent dependency omitted");}}
  const bytes=Buffer.from(c.commonBase64,"base64");
  return experimentCharter({version:"fixed-experiment-v2",experimentId:c.orderId,orderId:c.orderId,budgetDigest:resourceBindingDigest(c.budget),profile:"linux-bwrap-digest-v1",common:{bytes:bytes.length,sha256:byteHash(bytes),work:c.work,workTextDigest:c.workTextDigest},mode:"bounded-waves",deadlineMs:c.deadlineMs,
    variants:c.nodes.flatMap(n=>n.attempts.map((a,i)=>({variantId:a.executionId,executionId:a.executionId,kind:i?"retry" as const:"primary" as const,parentExecutionId:i?n.attempts[i-1].executionId:null,suffixBase64:Buffer.concat([Buffer.from(p.suffixBase64,"base64"),Buffer.from(a.suffixBase64,"base64")]).toString("base64"),operation:a.operation,configuration:{model:null,effort:null,skills:null}}))),
    order:{version:"order-schedule-v1",policyDigest:p.acceptancePolicyDigest,nodes:c.nodes.map(n=>({nodeId:n.nodeId,dependencies:n.dependencies,executions:n.attempts.map(a=>a.executionId),expectedDigest:n.expectedDigest,decision:n.decision}))}});
}
