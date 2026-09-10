import assert from "node:assert/strict";
import { test, after } from "node:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import grantsExtension from "../extensions/grants.ts";
import { drainExecutionRetention, parseExecutionRetentionManifest } from "../src/execution-retention.ts";
import { allocateNativeSessionTarget } from "../src/native-session-target.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
test("ordinary public delegation opts into per-execution native session files without model fields", async () => {
  const root = await tempDir("host-native-"), bin = join(root,"bin"), native = join(root,"native"); await mkdir(bin); await mkdir(native,{mode:0o700});
  // Actual private process fixture; native format, no claim this script is the installed pi or a model run.
  await writeFile(join(bin,"pi"), `#!${process.execPath}\nimport fs from 'node:fs';import crypto from 'node:crypto';const a=process.argv.slice(2),i=a.indexOf('--session');if(i<0)throw Error('ordinary host did not provide retained target');const p=a[i+1];fs.writeFileSync(p,JSON.stringify({type:'session',version:3,id:crypto.randomUUID(),timestamp:new Date().toISOString(),cwd:process.cwd()})+'\\n',{flag:'wx',mode:0o600});process.stdout.write(p);\n`); await chmod(join(bin,"pi"),0o700);
  const env={PATH:bin,PI_GRANTS_HERDR:"0",PI_GRANTS_GRANT:"tool:delegate",PI_GRANTS_MAX_DEPTH:"2",PI_GRANTS_RETAIN_NATIVE_SESSIONS:"1",PI_GRANTS_NATIVE_SESSION_ROOT:native,PI_GRANTS_EXECUTION_ARCHIVE:join(root,"archive")};
  const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
  try {const tools=new Map<string,any>(),hooks=new Map<string,any>();grantsExtension({on:(n:string,f:unknown)=>hooks.set(n,f),registerTool:(t:any)=>tools.set(t.name,t),registerCommand:()=>{},getAllTools:()=>[{name:"delegate"}]} as never);
    const ctx={cwd:root,ui:{notify:()=>{},select:async()=>undefined},modelRegistry:{find:()=>undefined}};await hooks.get("session_start")({},ctx);
    const records=[];for(const id of ["call:1","call:2"]){const result=await tools.get("delegate").execute(id,{task:"same",tools:[]},undefined,undefined,ctx);assert.equal(result.details.exitCode,0);
      await drainExecutionRetention(result.details.retention);const m=parseExecutionRetentionManifest(await readFile(result.details.retention.manifestPath,"utf8"));assert.equal(m.nativeSession.status,"verified");assert.equal(m.nativeSession.branchState,"unknown");records.push(m);}
    assert.notEqual(records[0].nativeSession.sessionPath,records[1].nativeSession.sessionPath);assert.deepEqual(records.map(m=>m.identity.toolCallId),["call:1","call:2"]);
  } finally {for(const[k,v]of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v;}
});
test("native target refuses reused occurrences and nonprivate roots",async()=>{const root=await tempDir("native-owned-");await allocateNativeSessionTarget(root,"exec:one");await assert.rejects(allocateNativeSessionTarget(root,"exec:one"),/EEXIST/);await chmod(root,0o755);await assert.rejects(allocateNativeSessionTarget(root,"exec:two"),/private/);});
