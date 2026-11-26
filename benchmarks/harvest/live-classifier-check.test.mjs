import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import liveCheck from "./live-classifier-check.mjs";

test("live smoke sends just one synthetic decision to the selected classifier", async t => {
  const dir=mkdtempSync(join(tmpdir(),"live-classifier-fixture-"));
  const saved={...process.env};
  t.after(()=>{
    for(const k of ["PI_CODING_AGENT_DIR","PI_DADDY_DEPTH","OPENROUTER_API_KEY"]) {
      if(saved[k]===undefined) delete process.env[k]; else process.env[k]=saved[k];
    }
    rmSync(dir,{recursive:true,force:true});
  });
  process.env.PI_CODING_AGENT_DIR=dir;
  delete process.env.OPENROUTER_API_KEY;
  process.env.PI_DADDY_DEPTH="0";
  writeFileSync(join(dir,"ecosystem.json"),JSON.stringify({harvest:{classifier:"fixture/local"}}));
  let before, calls=0;
  liveCheck({on:(event,fn)=>{assert.equal(event,"before_agent_start");before=fn}});
  const notices=[], selected={provider:"fixture",id:"local"};
  const ctx={ui:{notify:m=>notices.push(m)},modelRegistry:{
    getAvailableOfType:async()=>[selected],getModelOfType:()=>selected,
    classify:async m=>{assert.equal(m,selected);calls++;return {provider:"fixture",model:"local",stopReason:"stop",answers:{save:{type:"bool",probability:0.8}}}}
  }};
  await before({},ctx); await before({},ctx);
  assert.equal(calls,1); assert.match(notices[0],/fixture\/local.*score 0.8.*save/);
});
