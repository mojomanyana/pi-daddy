import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
import { unitTestBatches } from "../scripts/unit-tests.ts";
import { digestRuntime, inspectDigestPrerequisites } from "../src/effect-profile-runtime.ts";
after(cleanupTempDirs);
test("independent CI telemetry reports all prerequisites after an early lookup failure without claiming qualification",async()=>{
  const node=await fs.realpath(process.execPath),original=fs.lstat,seen:string[]=[];
  fs.lstat=(async function(p:any,...args:any[]){seen.push(String(p));if(String(p)===node)throw Object.assign(new Error("owned missing node"),{code:"ENOENT"});return Reflect.apply(original,fs,[p,...args]);}) as typeof fs.lstat;syncBuiltinESMExports();
  try{const report=await inspectDigestPrerequisites();assert.equal(report.conforms,false);assert.equal(report.qualification,"not-assessed");assert.deepEqual(seen,[node,"/usr/bin/bwrap","/usr/bin/prlimit"]);assert.equal(report.observations.length,3);assert.equal(report.observations[0].error?.code,"ENOENT");}finally{fs.lstat=original;syncBuiltinESMExports();}
});
test("CI deadlines retain complete ordinary discovery and both declared runtime legs",async()=>{
  const pkg=JSON.parse(await fs.readFile(new URL("../package.json",import.meta.url),"utf8")),workflow=await fs.readFile(new URL("../../../.github/workflows/ci.yml",import.meta.url),"utf8");
  assert.equal(pkg.scripts.test,"node scripts/unit-tests.ts");
  const files=(await fs.readdir(new URL("./",import.meta.url))).filter(f=>f.endsWith(".test.ts")).map(f=>"test/"+f).sort(),batches=unitTestBatches(files);
  assert.deepEqual(batches.flatMap(b=>b.files).sort(),files);assert.equal(new Set(batches.flatMap(b=>b.files)).size,files.length);
  assert.ok(batches.every(b=>b.timeout===(b.files.includes("test/work-ledger-path.test.ts")?120000:45000)));assert.match(workflow,/timeout-minutes: 10/);assert.match(workflow,/- name: unit tests\n        timeout-minutes: 5/);assert.match(workflow,/node: \["22\.19\.0", "24\.x"\]/);assert.match(workflow,/run: node scripts\/runtime-preflight\.ts/);
});
for(const kind of ["type","mode","size"] as const)test(`runtime ${kind} rejection preserves the guard and exposes the exact real-stat predicate`,async()=>{
  const root=await tempDir("runtime-predicate-"),path=join(root,"fixture"),node=await fs.realpath(process.execPath);
  if(kind==="type")await fs.mkdir(path);else{const f=await fs.open(path,"wx",kind==="mode"?0o620:0o600);if(kind==="size")await f.truncate(268435457);await f.close();if(kind==="mode")await fs.chmod(path,0o620);}
  // Diagnostic fault seam supplies a REAL lstat result, never a fake success. No run/profile is produced.
  const original=fs.lstat;fs.lstat=(async function(p:any,...args:any[]){return Reflect.apply(original,fs,[String(p)===node?path:p,...args]);}) as typeof fs.lstat;syncBuiltinESMExports();
  try{await assert.rejects(digestRuntime(),(error:any)=>{assert.equal(error.message,"unsupported mutable runtime executable");assert.equal(error.code,{type:"RUNTIME_NOT_REGULAR",mode:"RUNTIME_WRITABLE",size:"RUNTIME_TOO_LARGE"}[kind]);assert.equal(error.path,node);assert.equal(error.details.predicates[{type:"notRegular",mode:"writable",size:"oversize"}[kind]],true);return true;});}
  finally{fs.lstat=original;syncBuiltinESMExports();}
});
