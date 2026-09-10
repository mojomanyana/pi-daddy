import assert from "node:assert/strict";
import { test,after } from "node:test";
import { readFile,writeFile,mkdir,chmod,lstat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import promises from "node:fs/promises";
import { constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { stagePrivateRuntime } from "../scripts/private-runtime.ts";
import { unitTestBatches } from "../scripts/unit-tests.ts";
import { ownedRuntimeFixture } from "./owned-runtime-fixture.ts";
import { tempDir,cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
test("CI launch uses a private runtime without weakening the cached source or required matrix",async()=>{
 const pkg=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8")),workflow=await readFile(new URL("../../../.github/workflows/ci.yml",import.meta.url),"utf8");
 assert.equal(pkg.scripts.test,"node scripts/unit-tests.ts");assert.match(workflow,/run: node scripts\/private-runtime\.ts/);assert.match(workflow,/node: \["22.19.0", "24.x"\]/);assert.match(workflow,/timeout-minutes: 5/);
});
test("private byte-identical launch accepts observed mutable cache metadata without modifying shared source",async()=>{
 const root=await tempDir("private-ci-"),sourceRoot=join(root,"source"),targetRoot=join(root,"target");await mkdir(sourceRoot,{mode:0o700});await mkdir(targetRoot,{mode:0o700});const source=await ownedRuntimeFixture(sourceRoot);await chmod(source,0o777);
 const before=await lstat(source),expected=createHash("sha256").update(await readFile(source)).digest("hex"),receipt=await stagePrivateRuntime(targetRoot,source);assert.equal(receipt.sourceMode,"777");assert.equal(receipt.sha256,expected);assert.equal((await lstat(source)).mode,before.mode);
 const code=`import{digestRuntime}from${JSON.stringify(new URL("../src/effect-profile-runtime.ts",import.meta.url).href)};try{console.log(JSON.stringify(await digestRuntime()))}catch(e){console.log(JSON.stringify({code:e.code,path:e.path}))}`;
 const launch=(node:string)=>promisify(execFile)(node,["--input-type=module","-e",code],{timeout:12000,env:{...process.env,NODE_TEST_CONTEXT:undefined}});
 const refused=JSON.parse((await launch(source)).stdout);assert.equal(refused.code,"RUNTIME_WRITABLE");assert.equal(refused.path,source);
 const accepted=JSON.parse((await launch(receipt.target)).stdout);if(accepted.code){assert.equal(accepted.code,"ENOENT");assert.equal(accepted.path,"/usr/bin/bwrap");}else assert.equal(accepted.fingerprints[receipt.target],expected);await assert.rejects(stagePrivateRuntime(targetRoot,source),/EEXIST/);
 const invalid=join(root,"not-regular");await mkdir(invalid);await assert.rejects(stagePrivateRuntime(await tempDir("private-refuse-"),invalid),/regular/);
});
test("only aggregate path wrapper gets longer budget; every file remains exactly once",()=>{
 const files=["test/a.test.ts","test/work-ledger-path.test.ts","test/z.test.ts"],b=unitTestBatches(files);assert.deepEqual(b.map(x=>x.timeout),[45000,120000]);assert.deepEqual(b.flatMap(x=>x.files).sort(),files);assert.throws(()=>unitTestBatches([files[0],files[0]]),/inventory/);
});
test("a failed ordinary batch does not suppress the required path batch",async()=>{
 const root=await tempDir("unit-driver-"),dir=join(root,"test");await mkdir(dir);await writeFile(join(root,"package.json"),'{"type":"module"}');
 await writeFile(join(dir,"a.test.ts"),`import{test}from'node:test';test('deliberate driver control red',()=>{throw Error('fixture failure')});`);
 await writeFile(join(dir,"work-ledger-path.test.ts"),`import{test}from'node:test';import{writeFileSync}from'node:fs';test('required later batch',()=>writeFileSync('later-ran','yes',{flag:'wx'}));`);
 let error:any;try{await promisify(execFile)(process.execPath,[new URL("../scripts/unit-tests.ts",import.meta.url).pathname],{cwd:root,env:{...process.env,NODE_TEST_CONTEXT:undefined},timeout:15000});}catch(e){error=e;}
 assert.equal(error?.code,1);assert.match(error.stderr,/UNIT_BATCH_FAILED/);assert.equal(await readFile(join(root,"later-ran"),"utf8"),"yes");
});
test("private runtime required close failure rejects even with complete verified bytes",async()=>{
 const root=await tempDir("runtime-close-"),source=join(root,"source"),targetRoot=join(root,"target"),bytes=Buffer.from("owned copier fault fixture, not a launched runtime");await writeFile(source,bytes);await mkdir(targetRoot,{mode:0o700});const original=promises.open;let hit=false;
 promises.open=(async(...args:Parameters<typeof promises.open>)=>{const handle=await original(...args);if(String(args[0])===join(targetRoot,"node")&&typeof args[1]==="number"&&(args[1]&constants.O_WRONLY)){const close=handle.close.bind(handle);handle.close=async()=>{await close();hit=true;throw Error("fixture private close acknowledgement");};}return handle;}) as typeof promises.open;syncBuiltinESMExports();
 try{await assert.rejects(stagePrivateRuntime(targetRoot,source),/private close acknowledgement/);}finally{promises.open=original;syncBuiltinESMExports();}
 assert.ok(hit);assert.deepEqual(await readFile(join(targetRoot,"node")),bytes);
});
test("aggregate path adapter preserves an explicit inner timeout instead of inheriting a longer file budget",async()=>{
 const root=await tempDir("path-case-bound-"),file=join(root,"case.mjs");await writeFile(file,`import{test}from${JSON.stringify(new URL("./bounded-path-test.ts",import.meta.url).href)};test('inner deadline',{timeout:25},async()=>{await new Promise(r=>setTimeout(r,200));});`);
 let error:any;try{await promisify(execFile)(process.execPath,["--test","--test-timeout=1000",file],{env:{...process.env,NODE_TEST_CONTEXT:undefined},timeout:5000});}catch(e){error=e;}assert.equal(error?.code,1);assert.match(error.stdout,/test timed out after 25ms/);
});
