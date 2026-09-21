import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { adoptDashboardHarnessBridge } from "../src/products/dashboard-harness.ts";
import { ENV_DASHBOARD_HOST_SOCKET } from "../src/products/dashboard-host-transport.ts";
import { startDailyDashboardHost } from "../src/products/daily-dashboard-host.ts";
import type { DeclaredWorkState } from "../src/products/work-command.ts";
import type { OrdinaryChildren } from "../src/products/ordinary-children.ts";
import { learningHarness, loadLearningConnection } from "../src/products/learning-connection.ts";
import { readProductJson } from "../src/products/product-files.ts";

const BRIDGE=Symbol.for("skill-harness.dashboard-host.v1"),idPattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function dailyDashboardPaths(cwd:string,id:string,home=homedir(),uid=process.getuid?.()??0){const key=createHash("sha256").update(`${cwd}\0${id}`).digest("hex");return {directory:join(home,".local","state","pi-daddy","hosts",key.slice(0,16)),socketDirectory:join("/tmp",`pi-daddy-${uid}`),socketPath:join("/tmp",`pi-daddy-${uid}`,`host-${key.slice(0,20)}.sock`)};}
export async function preparePrivateHostRoot(root:string):Promise<void>{
 try { const before=await lstat(root,{bigint:true}); if(before.isSymbolicLink())throw Error("refusing symbolic-link host state root"); }
 catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await mkdir(root,{recursive:true,mode:0o700});}
 const state=await lstat(root,{bigint:true});
 if(!state.isDirectory()||state.isSymbolicLink()||(state.mode&0o077n)!==0n||state.uid!==BigInt(process.getuid?.()??-1)||await realpath(root)!==root)throw Error("owner-private non-symlink host state root required");
}

export function createDailyDashboardSession(input:{ordinary:()=>OrdinaryChildren;declared:()=>DeclaredWorkState|undefined;rebind:(state:DeclaredWorkState)=>void;cwd:()=>string;env:Record<string,string|undefined>;author:string;home?:string}){
 let ended=false,current:null|Awaited<ReturnType<typeof startDailyDashboardHost>>=null,publishedSocket:string|undefined,closing:null|{present:true;closing:true;evidenceDigest:string;expiresAt:number}=null;
 return Object.freeze({
  get running(){return current!==null;},
  async frame(){if(!current)throw Error("Start /grants host first");return current.host.frame();},
  async choose(key:string,binding?:{tip:string;requestDigest:string}){if(!current)throw Error("Start /grants host first");if(binding)return current.host.humanAction(key,binding);const frame=await current.host.frame(),action=frame.actions.find(a=>a.key===key);if(!action)throw Error("Action unavailable at the current boundary");return current.host.humanAction(key,{tip:frame.tip,requestDigest:action.requestDigest});},
  async run(target:string){
   if(ended)throw Error("Original Pi session has ended; no host replacement or control recovery");
   if(!target)target=`daily-${randomUUID().slice(0,8)}`;
   if(target==="stop"){
    if(!current)return "daily host is not running";await current.close();current=null;closing=null;if(publishedSocket&&input.env[ENV_DASHBOARD_HOST_SOCKET]===publishedSocket)delete input.env[ENV_DASHBOARD_HOST_SOCKET];publishedSocket=undefined;return "daily host stopped; no child was cancelled";
   }
   if(target==="closing"){if(!current)throw Error("daily host is not running");const expiresAt=Date.now()+120_000;closing={present:true,closing:true,evidenceDigest:createHash("sha256").update(`${input.cwd()}\0${expiresAt}\0${randomUUID()}`).digest("hex"),expiresAt};return "explicit closing presence recorded for two minutes; pause new dispatch and finish/cancel active attempts, then choose Prepare retained case cards in the dashboard. No card is counted as delivered until visibly acknowledged.";}
   if(!idPattern.test(target))throw Error("usage — /grants host <fresh-id> | closing | stop");if(current)throw Error("daily host already running in this session; use closing or stop");
   const declared=input.declared();if(!declared)throw Error("declare current work first with /grants work new");
   const home=input.home??homedir(),paths=dailyDashboardPaths(input.cwd(),target,home),root=join(home,".local","state","pi-daddy","hosts");await preparePrivateHostRoot(root);await mkdir(paths.socketDirectory,{recursive:true,mode:0o700});
   try{await lstat(paths.directory);throw Error(`host ID ${target} already has preserved state; choose a fresh host ID (the existing state was not opened, deleted or reused)`);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   const bridge=(globalThis as Record<PropertyKey,unknown>)[BRIDGE];if(!bridge)throw Error("loaded skill-harness extension bridge unavailable; load the skill-harness extension in this Pi session");
   const harness=adoptDashboardHarnessBridge(bridge),savedLearning=await readProductJson(join(input.cwd(),".pi","learning-workspace.json")),learning=savedLearning?await loadLearningConnection(input.cwd(),declared,learningHarness(harness),input.author):null;
   try{current=await startDailyDashboardHost({id:target,cwd:input.cwd(),directory:paths.directory,socketPath:paths.socketPath,declared,ordinary:input.ordinary(),harness,author:input.author,...(learning?{learning:learning.connection}:{}),presence:()=>closing,onDeclaredWorkChanged:input.rebind});}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw Error(`host ID ${target} could not start because state already exists; choose a fresh host ID. Existing state was preserved.`);throw error;}
   publishedSocket=current.socketPath;input.env[ENV_DASHBOARD_HOST_SOCKET]=publishedSocket;
   return `daily host started at ${publishedSocket}; current declared work/facts were captured. Run /grants dashboard for numbered actions or /grants work for work setup. Runtime remains unaccepted.`;
  },
  /** Called only when the original Pi session ends; no hold release or effect reconciliation. */
  async close(){ended=true;if(current)await current.endSession();if(publishedSocket&&input.env[ENV_DASHBOARD_HOST_SOCKET]===publishedSocket)delete input.env[ENV_DASHBOARD_HOST_SOCKET];current=null;closing=null;publishedSocket=undefined;}
 });
}
