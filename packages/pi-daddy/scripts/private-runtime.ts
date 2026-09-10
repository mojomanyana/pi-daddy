import { constants } from "node:fs";
import { open,lstat,realpath,mkdtemp,appendFile } from "node:fs/promises";
import { resolve,join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runWithFinalizers } from "../src/finalization.ts";
const MAX=256*1024*1024;
/** Explicit job-owned copy, not an installation, shared chmod or namespace qualification. */
export async function stagePrivateRuntime(directory:string,sourceInput=process.execPath){
 const source=await realpath(sourceInput),root=await lstat(directory);
 if(await realpath(directory)!==resolve(directory)||!root.isDirectory()||(root.mode&0o077)||root.uid!==process.getuid!())throw Error("canonical private owned runtime directory required");
 const dir=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),src=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(async error=>runWithFinalizers(async()=>{throw error;},[{label:"runtime directory close",run:()=>dir.close()}]));
 let dest:Awaited<ReturnType<typeof open>>|undefined;
 return runWithFinalizers(async()=>{
  const before=await src.stat({bigint:true});if(!before.isFile()||before.size>BigInt(MAX))throw Error("bounded regular runtime source required");
  const target=join(directory,"node");dest=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  const hash=async(copy:boolean)=>{const digest=createHash("sha256"),buffer=Buffer.alloc(1024*1024);let offset=0;while(true){const{bytesRead}=await src.read(buffer,0,buffer.length,offset);if(!bytesRead)break;offset+=bytesRead;if(offset>MAX)throw Error("runtime source grew beyond bound");digest.update(buffer.subarray(0,bytesRead));if(copy){let written=0;while(written<bytesRead){const n=(await dest!.write(buffer,written,bytesRead-written)).bytesWritten;if(!n)throw Error("runtime copy made no progress");written+=n;}}}return{sha256:digest.digest("hex"),bytes:offset};};
  const expected=await hash(true),recheck=await hash(false),after=await src.stat({bigint:true}),named=await lstat(source,{bigint:true});
  for(const key of ["dev","ino","mode","size","mtimeNs","ctimeNs"] as const)if(before[key]!==after[key]||before[key]!==named[key])throw Error("runtime source identity/metadata changed");
  if(expected.sha256!==recheck.sha256||expected.bytes!==Number(before.size))throw Error("runtime source bytes changed");
  await dest.sync();await dest.chmod(0o500);await dest.sync();
  const check=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  await runWithFinalizers(async()=>{const digest=createHash("sha256"),b=Buffer.alloc(1024*1024);let size=0;while(true){const{bytesRead}=await check.read(b,0,b.length,null);if(!bytesRead)break;size+=bytesRead;if(size>MAX)throw Error("private runtime grew");digest.update(b.subarray(0,bytesRead));}const st=await check.stat(),written=await dest!.stat();if(size!==expected.bytes||digest.digest("hex")!==expected.sha256||!st.isFile()||st.nlink!==1||st.mode&0o022||st.ino!==written.ino||st.dev!==written.dev)throw Error("private runtime verification failed");},[{label:"runtime verification close",run:()=>check.close()}]);
  const current=await lstat(directory);if(current.dev!==root.dev||current.ino!==root.ino||await realpath(directory)!==resolve(directory))throw Error("runtime directory replaced");await dir.sync();
  return{target,source,sourceMode:(Number(before.mode)&0o7777).toString(8),...expected,qualification:"not-assessed"};
 },[{label:"runtime target close",run:()=>dest?.close()},{label:"runtime source close",run:()=>src.close()},{label:"runtime directory close",run:()=>dir.close()}]);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.env.RUNNER_TEMP||!process.env.GITHUB_PATH)throw Error("explicit CI owned temporary root and PATH channel required");
 const directory=await mkdtemp(join(process.env.RUNNER_TEMP,"pi-daddy-runtime-")),receipt=await stagePrivateRuntime(directory);
 // Only after every required copy/sync/close succeeds can subsequent CI steps launch the private Node.
 await appendFile(process.env.GITHUB_PATH,directory+"\n");console.log("PRIVATE_RUNTIME "+JSON.stringify(receipt));
}
