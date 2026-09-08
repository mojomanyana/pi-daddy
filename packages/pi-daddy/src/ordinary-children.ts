import { randomUUID } from "node:crypto";
import { isExecutionId } from "./execution-id.ts";
import { dataDigest, detached, freeze, sha } from "./debrief-contract.ts";
import { controlShape } from "./dispatch-control.ts";
export interface OrdinaryTarget { executionId:string; parentExecutionId:string|null; toolCallId:string|null }
export interface OrdinaryCancellation { version:"ordinary-cancel-v1"; requestId:string; bindingDigest:string; expectedRevision:number; target:OrdinaryTarget }
export interface OrdinaryAuthority { bindingDigest:string; requestDigests:readonly string[] }
interface Row { target:OrdinaryTarget; state:"active"|"settled"|"unknown"; abortRequested:boolean; control:"not-assessed"|"failed"|"unknown"; outcome:unknown }
interface State { enabled:boolean; coverageGap:boolean; bindingDigest:string; revision:number; rows:Map<string,Row>; handles:Map<string,AbortController>; requests:Map<string,{digest:string;result:unknown}> }
const sessions=new WeakMap<object,OrdinaryChildren>(),ports=new WeakMap<object,State>();
const id=(v:unknown)=>typeof v==="string"&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
function target(value:OrdinaryTarget){const t=detached(value);controlShape(t,["executionId","parentExecutionId","toolCallId"]);if(!isExecutionId(t.executionId)||!(t.parentExecutionId===null||isExecutionId(t.parentExecutionId))||!(t.toolCallId===null||typeof t.toolCallId==="string"&&t.toolCallId.length>0&&t.toolCallId.length<=256))throw Error("exact original occurrence identity required");return t;}
export function ordinaryCancellation(input:OrdinaryCancellation){const r=detached(input);controlShape(r,["version","requestId","bindingDigest","expectedRevision","target"]);if(r.version!=="ordinary-cancel-v1"||!id(r.requestId)||!sha(r.bindingDigest)||!Number.isSafeInteger(r.expectedRevision)||r.expectedRevision<0)throw Error("invalid ordinary cancellation");return freeze({...r,target:target(r.target)});}
export const ordinaryCancellationDigest=(r:OrdinaryCancellation)=>dataDigest(ordinaryCancellation(r));
export interface OrdinaryChildren { readonly bindingDigest:string; inspect():unknown; quiescent():boolean; cancel(request:OrdinaryCancellation,authority:OrdinaryAuthority|null):unknown }
export const isOrdinaryChildren=(p:unknown):p is OrdinaryChildren=>typeof p==="object"&&p!==null&&ports.has(p);
/** Extension-internal constructor. No disk discovery/recovery and no identity inferred from labels. */
function initializeOrdinaryChildren(session:object):void {
  if(sessions.has(session))throw Error("original session already registered");
  const s:State={enabled:false,coverageGap:false,bindingDigest:dataDigest({occurrence:randomUUID()}),revision:0,rows:new Map(),handles:new Map(),requests:new Map()};
  const port:OrdinaryChildren=Object.freeze({bindingDigest:s.bindingDigest,
    quiescent:()=>!s.coverageGap&&[...s.rows.values()].every(r=>r.state==="settled"&&r.control==="not-assessed"),
    inspect:()=>freeze(detached({bindingDigest:s.bindingDigest,revision:s.revision,children:[...s.rows.values()],coverage:s.coverageGap?"unretained-before-opt-in":"original-registered-lifetimes-only",freshness:"snapshot-unknown",recovery:"unavailable",acceptance:"not-assessed"})),
    cancel(input:OrdinaryCancellation,authority:OrdinaryAuthority|null){
      const r=ordinaryCancellation(input),digest=ordinaryCancellationDigest(input),old=s.requests.get(r.requestId);
      if(old){if(old.digest!==digest)throw Error("immutable ordinary cancellation ID");return freeze(detached(old.result));}
      if(r.bindingDigest!==s.bindingDigest||r.expectedRevision!==s.revision)throw Error("stale original ordinary controller CAS");
      if(!authority||authority.bindingDigest!==s.bindingDigest||!authority.requestDigests.includes(digest))throw Error("independent exact ordinary cancellation authority required");
      const row=s.rows.get(r.target.executionId),handle=s.handles.get(r.target.executionId);
      if(!row||dataDigest(row.target)!==dataDigest(r.target)||row.state!=="active"||!handle)throw Error("original live child handle unavailable; no recovery");
      if(s.requests.size>=1024)throw Error("ordinary cancellation capacity exhausted");
      // Synchronous original-handle operation: CAS cannot yield between checking and requesting abort.
      const result={state:"abort-requested",target:r.target,revision:++s.revision,completion:"pending-original-caller",durability:"process-local"};
      s.requests.set(r.requestId,{digest,result});row.abortRequested=true;handle.abort();return freeze(detached(result));
    }});
  sessions.set(session,port);ports.set(port,s);
}
/** Only the original session object can retrieve its retained port; spreading/copying cannot. */
export function ordinaryChildrenFor(session:object):OrdinaryChildren {const p=sessions.get(session);if(!p)throw Error("original grants session required");ports.get(p)!.enabled=true;return p;}
/** Associate the actual extension API object at factory creation, never a label or path. */
export function associateOrdinaryHost(host:object,session:object){initializeOrdinaryChildren(session);const p=sessions.get(session);if(!p||sessions.has(host))throw Error("original unbound extension host required");sessions.set(host,p);}
export function retainSessionChild(session:object,input:OrdinaryTarget,caller?:AbortSignal){const p=sessions.get(session);if(!p)return undefined;const s=ports.get(p)!;if(!s.enabled){s.coverageGap=true;return undefined;}return retainOrdinaryChild(p,input,caller);}
/** Extension executor seam; never exported through the package root or model tools. */
export function retainOrdinaryChild(port:OrdinaryChildren,input:OrdinaryTarget,caller?:AbortSignal){
  const s=ports.get(port);if(!s)throw Error("original ordinary controller required");const t=target(input);
  if(s.rows.has(t.executionId)||s.rows.size>=1024)throw Error("ordinary occurrence reused or capacity exhausted");
  const abort=new AbortController(),row:Row={target:t,state:"active",abortRequested:false,control:"not-assessed",outcome:null};s.rows.set(t.executionId,row);s.handles.set(t.executionId,abort);s.revision++;
  let done=false;return {signal:caller?AbortSignal.any([caller,abort.signal]):abort.signal,
    settle(outcome:unknown,control:Row["control"]){if(done)throw Error("original child already settled");done=true;row.outcome=detached(outcome);row.control=control;row.state=control==="unknown"?"unknown":"settled";s.handles.delete(t.executionId);s.revision++;}};
}
