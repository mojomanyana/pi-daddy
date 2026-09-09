import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { claimResourcePermit, type ResourcePermit, type openResourceBudget } from "./resource-budget.ts";
import { digestRuntime, digestNamespaceArgs } from "./effect-profile-runtime.ts";
import { runChild, type ChildRunResult } from "./run-child.ts";
import { ipcShape, ipcReferences, producerIpcBinding, producerIpcBindingDigest, producerIpcDemand, producerIpcFrame, PRODUCER_IPC_LIMITS as LIMITS, type ProducerIpcBinding, type ProducerIpcReferences } from "./producer-ipc-contract.ts";
export { producerIpcBinding, producerIpcBindingDigest, producerIpcDemand, PRODUCER_IPC_LIMITS, type ProducerIpcBinding, type ProducerIpcReferences } from "./producer-ipc-contract.ts";
type Owner = ReturnType<typeof openResourceBudget>;
export interface ProducerIpcContext { readonly binding:Readonly<ProducerIpcBinding>; readonly signal:AbortSignal }
export interface ProducerIpcHost { readonly binding:Readonly<ProducerIpcBinding> }
interface HostState { owner:Owner; exchange:(frames:Readable,context:ProducerIpcContext)=>Promise<ProducerIpcReferences>; used:boolean }
const hosts = new WeakMap<ProducerIpcHost,HostState>();
/** Trusted host-only capability constructor, NOT approval/entitlement discovery. */
export function createProducerIpcHost(input:{owner:Owner;binding:ProducerIpcBinding;exchange:HostState["exchange"]}):ProducerIpcHost {
  ipcShape(input,["owner","binding","exchange"]);
  if(typeof input.exchange!=="function")throw new TypeError("original host exchange required");
  const port=Object.freeze({binding:producerIpcBinding(input.binding)});
  hosts.set(port,{owner:input.owner,exchange:input.exchange,used:false});return port;
}
export interface ProducerIpcSnapshot {
  readonly binding:Readonly<ProducerIpcBinding>;
  readonly outcome:"pending"|"completed"|"failed"|"cancelled"|"timed-out";
  readonly reason:null|"ADMISSION_FAILED"|"RUNTIME_FAILED"|"CHILD_FAILED"|"FRAME_INVALID"|"HOST_FAILED"|"CANCELLED"|"DEADLINE";
  readonly child:Readonly<ChildRunResult>|null;
  readonly childState:"pending"|"not-spawned"|"settled"|"unknown";
  readonly hostState:"not-called"|"pending"|"acknowledged"|"failed";
  readonly frameSha256:string|null;
  readonly references:Readonly<ProducerIpcReferences>|null;
  readonly settlement:"pending"|"acknowledged"|"failed-or-unknown";
  readonly acceptance:"not-assessed";
}
export interface ProducerIpcRun {
  readonly started:Promise<"spawned"|"not-spawned">;
  readonly readiness:Promise<"frame-ready"|"not-ready">;
  readonly child:Promise<ChildRunResult|null>;
  /** Bounded effect observation, NOT a resource-release/child-settlement receipt. */
  readonly result:Promise<ProducerIpcSnapshot>;
  /** May remain pending if original child, host or required accounting does not acknowledge. */
  readonly completion:Promise<ProducerIpcSnapshot>;
  inspect():ProducerIpcSnapshot;
}
// This is a separate fixed model-free emitter, not a new operation on linux-bwrap-digest-v1.
const WORKER = "/* producer-ipc-v1 */process.stdout.write(Buffer.from(process.argv[1],'base64'));";
function deferred<T>() { let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve}; }
export async function startProducerIpc(input:{owner:Owner;permit:ResourcePermit;binding:ProducerIpcBinding;host:ProducerIpcHost;signal:AbortSignal;timeoutMs:number}):Promise<ProducerIpcRun> {
  ipcShape(input,["owner","permit","binding","host","signal","timeoutMs"]);
  const binding=producerIpcBinding(input.binding), host=hosts.get(input.host);
  if(!host || host.used || host.owner!==input.owner || producerIpcBindingDigest(input.host.binding)!==producerIpcBindingDigest(binding))throw Error("original unused host with exact owner/charter/invocation required");
  if(!(input.signal instanceof AbortSignal) || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs<50 || input.timeoutMs>LIMITS.maxElapsedMs)throw new TypeError("bounded original cancellation/deadline required");
  const permit=claimResourcePermit(input.owner,input.permit,binding.budgetDigest,producerIpcDemand(binding));host.used=true;
  const caller=input.signal, deadline=performance.now()+input.timeoutMs, abort=new AbortController(), signal=AbortSignal.any([caller,abort.signal]);
  const started=deferred<"spawned"|"not-spawned">(), readiness=deferred<"frame-ready"|"not-ready">(), result=deferred<ProducerIpcSnapshot>();
  let outcome:ProducerIpcSnapshot["outcome"]="pending", reason:ProducerIpcSnapshot["reason"]=null, child:ChildRunResult|null=null;
  let childState:ProducerIpcSnapshot["childState"]="pending",hostState:ProducerIpcSnapshot["hostState"]="not-called",settlement:ProducerIpcSnapshot["settlement"]="pending";
  let references:Readonly<ProducerIpcReferences>|null=null,frameSha256:string|null=null,frames:Readable|undefined,timer:NodeJS.Timeout|undefined;
  const inspect=():ProducerIpcSnapshot=>Object.freeze({binding,outcome,reason,child:child?Object.freeze({...child}):null,childState,hostState,frameSha256,references,settlement,acceptance:"not-assessed"});
  const latch=(next:Exclude<ProducerIpcSnapshot["outcome"],"pending">,why:ProducerIpcSnapshot["reason"])=>{
    if(outcome!=="pending")return;outcome=next;reason=why;clearTimeout(timer);caller.removeEventListener("abort",cancel);result.resolve(inspect());
  };
  const cancel=()=>{latch("cancelled","CANCELLED");abort.abort();frames?.destroy();};
  const expire=()=>{latch("timed-out","DEADLINE");abort.abort();frames?.destroy();};
  const current=()=>{if(outcome!=="pending")return false;if(caller.aborted)cancel();else if(performance.now()>=deadline)expire();return outcome==="pending";};
  timer=setTimeout(expire,input.timeoutMs);caller.addEventListener("abort",cancel,{once:true});if(caller.aborted)cancel();
  let stdout=Buffer.alloc(0),overflow=false,eof=false,spawned=false;
  const childPromise=(async()=>{
    try {await permit.admission;} catch {latch("failed","ADMISSION_FAILED");return null;}
    if(!current())return null;
    try {
      const runtime=await digestRuntime();
      if(!current())return null;
      return Object.freeze(await runChild({command:"/usr/bin/bwrap",args:digestNamespaceArgs(runtime,WORKER,[producerIpcFrame(binding).toString("base64")]),env:{},cwd:"/",signal,
        timeoutMs:LIMITS.childMs,killGraceMs:LIMITS.graceMs,hardDeadlineAt:Date.now()+LIMITS.childMs+500,maxOutputBytes:LIMITS.frameBytes,
        onSpawn:()=>{spawned=true;started.resolve("spawned");},onStreamEnd:s=>{if(s==="stdout")eof=true;},
        onObservation:(s,b)=>{if(s!=="stdout"||overflow)return;if(stdout.length+b.length>LIMITS.frameBytes){overflow=true;return;}stdout=Buffer.concat([stdout,Buffer.from(b)]);}}));
    } catch {latch("failed","RUNTIME_FAILED");return null;}
  })();
  const completion=(async()=>{
    child=await childPromise;childState=spawned?(child?"settled":"unknown"):"not-spawned";started.resolve("not-spawned");
    if(childState==="unknown"){readiness.resolve("not-ready");settlement="failed-or-unknown";return inspect();}
    if(current()) {
      if(!child || child.code!==0 || child.aborted || child.timedOut || child.truncated || child.spawnError || child.signal)latch("failed","CHILD_FAILED");
      else if(!eof || overflow || !stdout.equals(producerIpcFrame(binding)))latch("failed","FRAME_INVALID");
      else {
        frameSha256=createHash("sha256").update(stdout).digest("hex");readiness.resolve("frame-ready");
        // Replay ONLY exact bytes from the original completed pipe; never reconstruct a host-authored frame.
        frames=Readable.from([Buffer.from(stdout)]);
        try {
          if(current()) {
            hostState="pending";references=ipcReferences(await host.exchange(frames,Object.freeze({binding,signal})));
            if(!frames.readableEnded)throw Error("original host frame not consumed");
            hostState="acknowledged";if(current())latch("completed",null);
          }
        }
        catch {hostState="failed";if(current())latch("failed","HOST_FAILED");}
        finally {frames.destroy();}
      }
    }
    readiness.resolve("not-ready");
    // Observation timeout never reaches here until the ORIGINAL child and invoked host have acknowledged.
    const terminal=inspect().outcome;
    try {await permit.settle(terminal==="completed"?"completed":terminal==="cancelled"?"cancelled":"failed");settlement="acknowledged";}
    catch {settlement="failed-or-unknown";}
    clearTimeout(timer);caller.removeEventListener("abort",cancel);return inspect();
  })();
  return Object.freeze({started:started.promise,readiness:readiness.promise,child:childPromise,result:result.promise,completion,inspect});
}
