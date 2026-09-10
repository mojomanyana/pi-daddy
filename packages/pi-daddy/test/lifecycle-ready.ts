import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
/** Observation of a newly owned fixture, never authority to recover/kill an arbitrary PID. */
export async function liveFixtureReady(path: string, stderr: () => Promise<string> = async()=>"") {
  const deadline=Date.now()+1500;
  while(Date.now()<deadline){
    let text:string;
    try{text=await readFile(path,"utf8");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await new Promise(r=>setTimeout(r,10));continue;}
    const record=JSON.parse(text);assert.equal(record.ready,true,"fixture must acknowledge actual Node event-loop readiness");assert.ok(Number.isSafeInteger(record.pid)&&record.pid>0);
    try{process.kill(record.pid,0);}catch(error){assert.fail(`owned fixture exited before teardown readiness: ${String(error)}; ${await stderr()}`);}
    return record.pid as number;
  }
  assert.fail(`fixture did not reach live readiness: ${path}; ${await stderr()}`);
}
