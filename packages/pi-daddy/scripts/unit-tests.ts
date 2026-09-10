import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
/** The 205-case path FILE aggregates existing 30s/60s groups. Only that wrapper gets 120s. */
export function unitTestBatches(files:readonly string[]){
 const all=[...files].sort();if(new Set(all).size!==all.length||all.some(f=>!/^test\/[a-zA-Z0-9-]+\.test\.ts$/.test(f)))throw Error("exact ordinary file inventory required");
 const path="test/work-ledger-path.test.ts";
 return [{files:all.filter(f=>f!==path),timeout:45000,outer:180000},{files:all.filter(f=>f===path),timeout:120000,outer:125000}].filter(b=>b.files.length);
}
/** Every required file is run once, including after a failed earlier batch; no test-name filtering. */
export function runUnitTests(directory=process.cwd()){
 const batches=unitTestBatches(readdirSync(resolve(directory,"test")).filter(f=>f.endsWith(".test.ts")).map(f=>"test/"+f));
 const deadline=Date.now()+285000;let failed=false;const env={...process.env};delete env.NODE_TEST_CONTEXT;
 for(const batch of batches){const remaining=deadline-Date.now();if(remaining<=0){console.error("UNIT_BATCH_UNEXECUTED "+JSON.stringify(batch));failed=true;continue;}
  console.log("UNIT_BATCH "+JSON.stringify(batch));const result=spawnSync(process.execPath,["--test","--test-concurrency=2",`--test-timeout=${batch.timeout}`,...batch.files],{cwd:directory,env,stdio:"inherit",timeout:Math.min(remaining,batch.outer),killSignal:"SIGKILL"});
  if(result.status!==0){failed=true;console.error("UNIT_BATCH_FAILED "+JSON.stringify({files:batch.files,status:result.status,signal:result.signal,error:result.error?String(result.error):null}));}
 }
 return failed?1:0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=runUnitTests();
