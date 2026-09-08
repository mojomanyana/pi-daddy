import { mkdir,writeFile,readFile } from "node:fs/promises";
import { join } from "node:path";
import grantsExtension from "../extensions/grants.ts";
import { GRANT_ENV_KEYS } from "../src/propagation.ts";
import { ordinaryChildrenFor } from "../src/ordinary-children.ts";
/** Actual ordinary public tools/executor; Node worker fixture, no model or live pi deployment. */
export async function ordinaryHostFixture(root:string){
 const bin=join(root,"ordinary-bin");await mkdir(bin);await writeFile(join(bin,"pi"),`#!${process.execPath}\nimport fs from 'node:fs';const task=process.argv.at(-1).trim();fs.writeFileSync(task+'.ready','ready',{flag:'wx'});process.stdout.write('owned output');if(task==='fast')process.exit(0);setTimeout(()=>process.exit(0),8000);`,{mode:0o700});
 const env={PATH:bin,PI_GRANTS_HERDR:"0",PI_GRANTS_GRANT:"tool:delegate",PI_GRANTS_MAX_DEPTH:"2",PI_GRANTS_DEPTH:"0",PI_GRANTS_CHILD_TIMEOUT:"10"},old=Object.fromEntries([...new Set([...Object.keys(env),...GRANT_ENV_KEYS])].map(k=>[k,process.env[k]]));for(const k of GRANT_ENV_KEYS)if(k!=="PI_GRANTS_LEDGER")delete process.env[k];Object.assign(process.env,env);
 const tools=new Map<string,any>(),hooks=new Map<string,any>(),pi={on:(n:string,f:any)=>hooks.set(n,f),registerTool:(t:any)=>tools.set(t.name,t),registerCommand:()=>{},getAllTools:()=>[{name:"delegate"}]},caller=new AbortController(),pending:Promise<any>[]=[];
 const restore=()=>{for(const[k,v]of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v;};
 try{grantsExtension(pi as never);const port=ordinaryChildrenFor(pi),ctx={cwd:root,ui:{notify:()=>{},select:async()=>undefined},modelRegistry:{find:()=>undefined}};await hooks.get("session_start")({},ctx);
  return{port,runAll(){const p=tools.get("delegate_all").execute("call:all",{children:[{task:"fast",tools:[]},{task:"hold",tools:[]}]},caller.signal,undefined,ctx).then((value:any)=>({value}),(error:any)=>({error}));pending.push(p);return p;},run(task:string){const p=tools.get("delegate").execute("call:"+task,{task,tools:[]},caller.signal,undefined,ctx).then((value:any)=>({value}),(error:any)=>({error}));pending.push(p);return p;},
   async ready(task:string){const end=Date.now()+3000;while(true){try{if(await readFile(join(root,task+".ready"),"utf8")==="ready")return;}catch(error){if(Date.now()>end)throw error;}if(Date.now()>end)throw Error("owned child readiness unavailable");await new Promise(r=>setTimeout(r,10));}},
   async close(){caller.abort();await Promise.all(pending);restore();}};
 }catch(error){caller.abort();await Promise.all(pending);restore();throw error;}
}
