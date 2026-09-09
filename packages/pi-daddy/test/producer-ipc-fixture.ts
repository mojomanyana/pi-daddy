import cp from "node:child_process";
import { after } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createExperimentBudget, openResourceBudget, resourceBindingDigest } from "../src/resource-budget.ts";
import { newExecutionId } from "../src/execution-id.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
export async function ipcWorld() {
  const ipc=await import("../src/producer-ipc.ts"),root=await tempDir("producer-ipc-");
  const budget=await createExperimentBudget({directory:join(root,"budget"),authorityDigest:"a".repeat(64),limits:{maxAttempts:4,maxInputBytes:4096,maxConcurrent:2}});
  const owner=openResourceBudget(budget),binding={version:"producer-ipc-v1" as const,budgetDigest:resourceBindingDigest(budget),orderId:"order-ipc",experimentId:"experiment-ipc",executionId:newExecutionId(),charterSha256:"b".repeat(64),invocationId:"subject-1"};
  const demand=ipc.producerIpcDemand(binding),[permit]=await owner.reserveBatch([demand]);return {ipc,owner,binding,permit,demand,budget};
}
interface ChildRecord { child:cp.ChildProcess; argv:readonly string[]; env:NodeJS.ProcessEnv; closed:Promise<void>; release():void }
/** Test-only forwarding to REAL owned Node children, never a fabricated ChildProcess or result. */
export async function withIpcChild(code:string,body:(children:ChildRecord[])=>Promise<void>,fault:{deferKills?:boolean;dropEof?:boolean;spawnError?:boolean;afterSpawnFailure?:boolean}={}) {
  const original=cp.spawn,children:ChildRecord[]=[];
  cp.spawn=((command:string,args:string[],options:cp.SpawnOptions)=>{
    if(command!=="/usr/bin/bwrap"||!args.some(a=>a.includes("/* producer-ipc-v1 */")))return original(command,args,options);
    const child=original(fault.spawnError?join(import.meta.dirname,"absent-producer-ipc-node"):process.execPath,["-e",code,args.at(-1)!],options),kill=child.kill.bind(child);
    const record:ChildRecord={child,argv:[...args],env:{...options.env},closed:new Promise(resolve=>child.once("close",()=>resolve())),release:()=>{if(child.pid!==undefined&&child.exitCode===null&&child.signalCode===null)kill("SIGKILL");}};
    children.push(record);
    if(fault.afterSpawnFailure&&child.stderr){const on=child.stderr.on.bind(child.stderr);child.stderr.on=((name:string,listener:(...args:any[])=>void)=>{if(name==="data")throw Error("inert post-spawn setup failure");return on(name,listener);}) as typeof child.stderr.on;}
    if(fault.deferKills)child.kill=()=>true; // Retain real liveness while original signal delivery is faulted.
    if(fault.dropEof&&child.stdout){const emit=child.stdout.emit.bind(child.stdout);child.stdout.emit=((name:string,...args:unknown[])=>name==="end"?false:emit(name,...args)) as typeof child.stdout.emit;}
    return child;
  }) as typeof cp.spawn;syncBuiltinESMExports();
  try {await body(children);} finally {for(const r of children)r.release();await Promise.all(children.map(r=>r.closed));cp.spawn=original;syncBuiltinESMExports();}
}
export const ipcEmitter="process.stdout.write(Buffer.from(process.argv[1],'base64'));";
export const ipcReferences={claimRef:"claim:inert",responseRef:"response:inert"};
