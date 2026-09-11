import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { adoptDashboardHarnessBridge } from "../src/dashboard-harness.ts";
import { ENV_DASHBOARD_HOST_SOCKET } from "../src/dashboard-host-transport.ts";
import { startDailyDashboardHost } from "../src/daily-dashboard-host.ts";
import type { DeclaredWorkState } from "../src/work-command.ts";
import type { OrdinaryChildren } from "../src/ordinary-children.ts";

const BRIDGE=Symbol.for("skill-harness.dashboard-host.v1"),idPattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function dailyDashboardPaths(cwd:string,id:string,home=homedir(),uid=process.getuid?.()??0){const key=createHash("sha256").update(`${cwd}\0${id}`).digest("hex");return {directory:join(home,".local","state","pi-daddy","hosts",key.slice(0,16)),socketDirectory:join("/tmp",`pi-daddy-${uid}`),socketPath:join("/tmp",`pi-daddy-${uid}`,`host-${key.slice(0,20)}.sock`)};}
export function createDailyDashboardSession(input:{ordinary:()=>OrdinaryChildren;declared:()=>DeclaredWorkState|undefined;rebind:(state:DeclaredWorkState)=>void;cwd:()=>string;env:Record<string,string|undefined>;author:string}){
 let current:null|Awaited<ReturnType<typeof startDailyDashboardHost>>=null,publishedSocket:string|undefined,closing:null|{present:true;closing:true;evidenceDigest:string;expiresAt:number}=null;
 return Object.freeze({
  async run(target:string){
   if(target==="stop"){
    if(!current)return "daily host is not running";await current.close();current=null;closing=null;if(publishedSocket&&input.env[ENV_DASHBOARD_HOST_SOCKET]===publishedSocket)delete input.env[ENV_DASHBOARD_HOST_SOCKET];publishedSocket=undefined;return "daily host stopped; no child was cancelled";
   }
   if(target==="closing"){if(!current)throw Error("daily host is not running");const expiresAt=Date.now()+120_000;closing={present:true,closing:true,evidenceDigest:createHash("sha256").update(`${input.cwd()}\0${expiresAt}\0${randomUUID()}`).digest("hex"),expiresAt};return "explicit closing presence recorded for two minutes; pause new dispatch and finish/cancel active attempts, then choose prepare-case-cards in the dashboard. No card is counted as delivered until visibly acknowledged.";}
   if(!idPattern.test(target))throw Error("usage — /grants host <fresh-id> | closing | stop");if(current)throw Error("daily host already running in this session; use closing or stop");
   const declared=input.declared();if(!declared)throw Error("declare current work first with pi-daddy work add, then reload");
   const bridge=(globalThis as Record<PropertyKey,unknown>)[BRIDGE];if(!bridge)throw Error("loaded skill-harness extension bridge unavailable; load the candidate skill-harness extension in this Pi session");
   const paths=dailyDashboardPaths(input.cwd(),target);await mkdir(join(homedir(),".local","state","pi-daddy","hosts"),{recursive:true,mode:0o700});await mkdir(paths.socketDirectory,{recursive:true,mode:0o700});
   current=await startDailyDashboardHost({id:target,cwd:input.cwd(),directory:paths.directory,socketPath:paths.socketPath,declared,ordinary:input.ordinary(),harness:adoptDashboardHarnessBridge(bridge) as never,author:input.author,presence:()=>closing,onDeclaredWorkChanged:input.rebind});
   publishedSocket=current.socketPath;input.env[ENV_DASHBOARD_HOST_SOCKET]=publishedSocket;
   return `daily host started at ${publishedSocket}; current declared work/facts were captured. Run /grants dashboard, then use only its listed pause/resume/refresh/cancel/scope/priority/alternative action keys. Runtime remains unaccepted.`;
  },
  async close(){if(current)await current.close();if(publishedSocket&&input.env[ENV_DASHBOARD_HOST_SOCKET]===publishedSocket)delete input.env[ENV_DASHBOARD_HOST_SOCKET];current=null;closing=null;publishedSocket=undefined;}
 });
}
