import { constants } from "node:fs";
import { mkdir, open, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "./file-lock.ts";
import { runWithFinalizers } from "./finalization.ts";
import { ownedDirectory, readExperimentFile } from "./experiment-store.ts";
import { cloneExperiment, closed, experimentHash } from "./experiment-contract.ts";
import { freezeWork, parseWorkJson } from "./work-ledger-json.ts";
export interface ControlBinding<T> {version:"control-journal-v1";directory:string;device:string;inode:string;journalDevice:string;journalInode:string;initial:T}
export async function createControlJournal<T>(directory:string,input:T):Promise<ControlBinding<T>>{
  const initial=cloneExperiment(input);if(typeof directory!=="string"||directory!==resolve(directory)||directory.length>1024||directory.split("/").includes(".pi"))throw new Error("explicit control directory required");
  await ownedDirectory(dirname(directory));await mkdir(directory,{mode:0o700});const root=await ownedDirectory(directory),f=await open(join(directory,"control.jsonl"),"wx",0o600);
  const b=await runWithFinalizers(async()=>{const s=await f.stat({bigint:true});const b={version:"control-journal-v1" as const,directory,device:String(root.dev),inode:String(root.ino),journalDevice:String(s.dev),journalInode:String(s.ino),initial};await f.writeFile(JSON.stringify(b)+"\n");await f.sync();return b;},[{label:"control creation close failed",run:()=>f.close()}]);
  const d=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY);await runWithFinalizers(()=>d.sync(),[{label:"control directory close failed",run:()=>d.close()}]);return freezeWork(b) as unknown as ControlBinding<T>;
}
export function controlJournal<T>(input:ControlBinding<T>){
  const b=freezeWork(cloneExperiment(input)) as unknown as ControlBinding<T>;closed(b,["version","directory","device","inode","journalDevice","journalInode","initial"]);
  if(b.version!=="control-journal-v1"||b.directory!==resolve(b.directory)||b.directory.split("/").includes(".pi")||[b.device,b.inode,b.journalDevice,b.journalInode].some(v=>!/^\d+$/.test(v)))throw new Error("invalid control binding");
  const path=join(b.directory,"control.jsonl");
  const check=async()=>{const root=await ownedDirectory(b.directory),file=await lstat(path,{bigint:true});if(String(root.dev)!==b.device||String(root.ino)!==b.inode||String(file.dev)!==b.journalDevice||String(file.ino)!==b.journalInode)throw new Error("control identity changed");};
  const read=async()=>{await check();const bytes=await readExperimentFile(path,512*1024);await check();const text=new TextDecoder("utf8",{fatal:true}).decode(bytes);if(!text.endsWith("\n"))throw new Error("torn control journal");const lines=text.slice(0,-1).split("\n");if(lines.length>257||experimentHash(parseWorkJson(lines[0]))!==experimentHash(b))throw new Error("control header/limit mismatch");let previous=experimentHash(b);const events:Record<string,unknown>[]=[];
    for(const line of lines.slice(1)){const r=parseWorkJson(line) as Record<string,unknown>;closed(r,["sequence","previous","event"]);if(r.sequence!==events.length||r.previous!==previous||!r.event||typeof r.event!=="object"||Array.isArray(r.event))throw new Error("invalid control sequence");previous=experimentHash(r);events.push(r.event as Record<string,unknown>);}return{events,previous,size:bytes.length};};
  return {binding:b,read,async transaction<R>(fn:(events:Record<string,unknown>[],append:(e:unknown)=>Promise<void>)=>Promise<R>){await check();return withFileLock(path,"factory policy",async()=>{const state=await read();return fn(state.events,async event=>{if(state.events.length>=256)throw new Error("control event budget exhausted");const record={sequence:state.events.length,previous:state.previous,event:cloneExperiment(event)},data=Buffer.from(JSON.stringify(record)+"\n");if(state.size+data.length>512*1024||data.length>65536)throw new Error("control byte budget exhausted");await check();const f=await open(path,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      await runWithFinalizers(async()=>{const s=await f.stat({bigint:true});if(!s.isFile()||s.nlink!==1n||String(s.dev)!==b.journalDevice||String(s.ino)!==b.journalInode||s.size!==BigInt(state.size)||(s.mode&0o077n)!==0n)throw new Error("control journal changed under lock");await f.writeFile(data);await f.sync();},[{label:"control append close failed",run:()=>f.close()}]);await check();state.size+=data.length;state.previous=experimentHash(record);state.events.push(cloneExperiment(event) as Record<string,unknown>);
    });},{staleRecovery:"disabled"});}};
}
