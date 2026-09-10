import { mkdir,writeFile,chmod,readFile } from "node:fs/promises";
import { join,relative } from "node:path";
import grantsExtension from "../extensions/grants.ts";
import { drainExecutionRetention,parseExecutionRetentionManifest } from "../src/execution-retention.ts";
/** Real ordinary tool/host/executor/retention path, with an explicit no-model Node process fixture. */
export async function ordinaryHostRetention(root:string){
 const bin=join(root,"bin"),native=join(root,"native");await mkdir(bin);await mkdir(native,{mode:0o700});await writeFile(join(bin,"pi"),`#!${process.execPath}\nimport fs from 'node:fs';import{randomUUID}from'node:crypto';const args=process.argv.slice(2),index=args.indexOf('--session');if(index<0)throw Error('missing authorized native target');fs.writeFileSync(args[index+1],JSON.stringify({type:'session',version:3,id:randomUUID(),timestamp:new Date().toISOString(),cwd:process.cwd()})+'\\n',{flag:'wx',mode:0o600});process.stdout.write('ordinary retained fixture output');`);await chmod(join(bin,"pi"),0o700);
 const env={PATH:bin,PI_GRANTS_HERDR:"0",PI_GRANTS_GRANT:"tool:delegate",PI_GRANTS_MAX_DEPTH:"2",PI_GRANTS_RETAIN_NATIVE_SESSIONS:"1",PI_GRANTS_NATIVE_SESSION_ROOT:native,PI_GRANTS_EXECUTION_ARCHIVE:join(root,"producer-retention")},old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 try{const tools=new Map<string,any>(),hooks=new Map<string,any>();grantsExtension({on:(n:string,f:unknown)=>hooks.set(n,f),registerTool:(t:any)=>tools.set(t.name,t),registerCommand:()=>{},getAllTools:()=>[{name:"delegate"}]} as never);const ctx={cwd:root,ui:{notify:()=>{},select:async()=>undefined},modelRegistry:{find:()=>undefined}};await hooks.get("session_start")({},ctx);
  const result=await tools.get("delegate").execute("call:retained",{task:"retained ordinary fixture",tools:[]},undefined,undefined,ctx);if(result.details.exitCode!==0)throw Error("ordinary source worker did not succeed");await drainExecutionRetention(result.details.retention);const path=result.details.retention.manifestPath,manifest=parseExecutionRetentionManifest(await readFile(path,"utf8"));return {path,relativePath:relative(root,path),manifest};
 }finally{for(const[k,v]of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v;}
}
