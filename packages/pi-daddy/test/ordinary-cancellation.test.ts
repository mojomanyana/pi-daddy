import assert from "node:assert/strict";
import { test,after } from "node:test";
import { mkdir,writeFile,readFile } from "node:fs/promises";
import { join } from "node:path";
import grantsExtension from "../extensions/grants.ts";
import { ordinaryChildrenFor,ordinaryCancellationDigest,type OrdinaryCancellation } from "../src/ordinary-children.ts";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { GRANT_ENV_KEYS } from "../src/propagation.ts";
import { ordinaryHostFixture } from "./ordinary-host-fixture.ts";
import { tempDir,cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
test("ordinary delegate retains original cancellation handles and preserves sibling/caller lifetimes",async()=>{
 const root=await tempDir("ordinary-cancel-"),bin=join(root,"bin");await mkdir(bin);
 await writeFile(join(bin,"pi"),`#!${process.execPath}\nimport fs from 'node:fs';const task=process.argv.at(-1).trim();fs.writeFileSync(task+'.ready','ready',{flag:'wx'});process.stdout.write('original:'+task);setTimeout(()=>process.exit(0),8000);`,{mode:0o700});
 const env={PATH:bin,PI_GRANTS_HERDR:"0",PI_GRANTS_GRANT:"tool:delegate",PI_GRANTS_MAX_DEPTH:"2",PI_GRANTS_DEPTH:"0",PI_GRANTS_CHILD_TIMEOUT:"10"},old=Object.fromEntries([...new Set([...Object.keys(env),...GRANT_ENV_KEYS])].map(k=>[k,process.env[k]]));for(const k of GRANT_ENV_KEYS)delete process.env[k];Object.assign(process.env,env);
 const caller=new AbortController(),pending:Promise<any>[]=[];
 try{
  const tools=new Map<string,any>(),hooks=new Map<string,any>(),pi={on:(n:string,f:any)=>hooks.set(n,f),registerTool:(t:any)=>tools.set(t.name,t),registerCommand:()=>{},getAllTools:()=>[{name:"delegate"}]};grantsExtension(pi as never);
  const port=ordinaryChildrenFor(pi);assert.throws(()=>ordinaryChildrenFor({...pi}),/original/);
  const ctx={cwd:root,ui:{notify:()=>{},select:async()=>undefined},modelRegistry:{find:()=>undefined}};await hooks.get("session_start")({},ctx);
  for(const task of ["one","two"])pending.push(tools.get("delegate").execute("call:"+task,{task,tools:[]},caller.signal,undefined,ctx).then((value:any)=>({value}),(error:any)=>({error})));
  const deadline=Date.now()+3000;while(true){try{assert.equal(await readFile(join(root,"one.ready"),"utf8"),"ready");assert.equal(await readFile(join(root,"two.ready"),"utf8"),"ready");break;}catch(e){if(Date.now()>deadline)throw e;await new Promise(r=>setTimeout(r,10));}}
  const view=port.inspect() as any,one=view.children.find((c:any)=>c.target.toolCallId==="call:one"),two=view.children.find((c:any)=>c.target.toolCallId==="call:two");assert.equal(view.children.length,2);assert.equal(two.state,"active");
  const request:OrdinaryCancellation={version:"ordinary-cancel-v1",requestId:"cancel:one",bindingDigest:port.bindingDigest,expectedRevision:view.revision,target:one.target};
  assert.throws(()=>port.cancel(request,null),/authority/);const authority={bindingDigest:port.bindingDigest,requestDigests:[ordinaryCancellationDigest(request)]};
  const result=port.cancel(request,authority);assert.equal((result as any).state,"abort-requested");assert.deepEqual(port.cancel(request,null),result);
  const first=await pending[0];assert.equal(first.error.code,"CHILD_CANCELLED");assert.equal((port.inspect() as any).children.find((c:any)=>c.target.toolCallId==="call:two").state,"active");
  assert.throws(()=>port.cancel({...request,requestId:"late"},authority),/stale/);caller.abort();assert.equal((await pending[1]).error.code,"CHILD_CANCELLED");
  const done=port.inspect() as any;assert.ok(done.children.every((c:any)=>c.state==="settled"));assert.equal(done.children[0].control,"not-assessed");assert.equal(done.children[1].abortRequested,false);
 }finally{caller.abort();await Promise.all(pending);for(const[k,v]of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v;}
});
test("ordinary fanout cancellation preserves the completed sibling's result",async()=>{
 const child=await ordinaryHostFixture(await tempDir("ordinary-all-"));try{const done=child.runAll();await child.ready("fast");await child.ready("hold");let view=child.port.inspect() as any;const deadline=Date.now()+3000;while(view.children.filter((r:any)=>r.state==="settled").length!==1){if(Date.now()>deadline)throw Error("original fast child did not settle");await new Promise(r=>setTimeout(r,10));view=child.port.inspect();}
 const target=view.children.find((r:any)=>r.state==="active").target,request:OrdinaryCancellation={version:"ordinary-cancel-v1",requestId:"all:stop",bindingDigest:child.port.bindingDigest,expectedRevision:view.revision,target};child.port.cancel(request,{bindingDigest:child.port.bindingDigest,requestDigests:[ordinaryCancellationDigest(request)]});
 const result=await done;assert.equal(result.value.details.children,2);assert.equal(result.value.details.failed,1);assert.match(result.value.content[0].text,/owned output/);
 }finally{await child.close();}
});
test("ordinary worker success does not certify a failed terminal observation acknowledgement",async()=>{
 const root=await tempDir("ordinary-terminal-"),ledger=join(root,"ledger.jsonl"),old=process.env.PI_GRANTS_LEDGER;process.env.PI_GRANTS_LEDGER=ledger;
 const original=promises.appendFile;let child:Awaited<ReturnType<typeof ordinaryHostFixture>>|undefined,hit=false;
 try{child=await ordinaryHostFixture(root);promises.appendFile=(async(...args:Parameters<typeof promises.appendFile>)=>{await original(...args);if(String(args[0])===ledger&&String(args[1]).includes('"state":"completed"')){hit=true;throw Error("lost terminal observation acknowledgement");}}) as typeof promises.appendFile;syncBuiltinESMExports();
 const result=await child.run("fast");assert.ifError(result.error);assert.equal(result.value.details.exitCode,0);assert.equal(result.value.content[0].text,"owned output");assert.ok(hit);const row=(child.port.inspect() as any).children[0];assert.equal(row.state,"settled");assert.equal(row.control,"failed");assert.equal(child.port.quiescent(),false);assert.match(await readFile(ledger,"utf8"),/"state":"completed"/);
 }finally{promises.appendFile=original;syncBuiltinESMExports();await child?.close();old===undefined?delete process.env.PI_GRANTS_LEDGER:process.env.PI_GRANTS_LEDGER=old;}
});
test("late ordinary opt-in cannot certify an empty registry as complete original quiescence",async()=>{
 const root=await tempDir("ordinary-late-"),bin=join(root,"bin");await mkdir(bin);await writeFile(join(bin,"pi"),`#!${process.execPath}\nprocess.stdout.write('untracked default worker');`,{mode:0o700});
 const keys=[...GRANT_ENV_KEYS,"PATH","PI_GRANTS_HERDR"],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));for(const k of GRANT_ENV_KEYS)delete process.env[k];Object.assign(process.env,{PATH:bin,PI_GRANTS_HERDR:"0",PI_GRANTS_GRANT:"tool:delegate",PI_GRANTS_DEPTH:"0",PI_GRANTS_MAX_DEPTH:"2"});
 try{const tools=new Map<string,any>(),hooks=new Map<string,any>(),pi={on:(n:string,f:any)=>hooks.set(n,f),registerTool:(t:any)=>tools.set(t.name,t),registerCommand:()=>{},getAllTools:()=>[{name:"delegate"}]};grantsExtension(pi as never);const ctx={cwd:root,ui:{notify:()=>{},select:async()=>undefined},modelRegistry:{find:()=>undefined}};await hooks.get("session_start")({},ctx);
  assert.equal((await tools.get("delegate").execute("late",{task:"default",tools:[]},undefined,undefined,ctx)).details.exitCode,0);const port=ordinaryChildrenFor(pi),view=port.inspect() as any;assert.deepEqual(view.children,[]);assert.equal(view.coverage,"unretained-before-opt-in");assert.equal(port.quiescent(),false);
 }finally{for(const[k,v]of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v;}
});
