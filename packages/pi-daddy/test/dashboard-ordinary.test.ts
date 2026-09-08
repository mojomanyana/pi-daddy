import assert from "node:assert/strict";
import { test,after } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { readFile } from "node:fs/promises";
import { tempDir,cleanupTempDirs } from "./tmp.ts";
import { hostWorld } from "./dashboard-host-world.ts";
import { ordinaryHostFixture } from "./ordinary-host-fixture.ts";
import { ordinaryCancellationDigest,type OrdinaryCancellation } from "../src/ordinary-children.ts";
import { openDashboardHost } from "../src/dashboard-host.ts";
import { dashboardHostAction } from "../src/dashboard-cli.ts";
import { selectionProposal } from "./intent-selection-fixture.ts";
import { intentRequestDigest,type IntentRequest } from "../src/intent-control.ts";
import { readDailyView } from "../src/daily-view.ts";
import { projectWorkLedger } from "../src/work-ledger.ts";
after(cleanupTempDirs);
for(const fault of [false,true])test(`actual dashboard ordinary cancellation preserves original outcome despite lost host acknowledgement=${fault}`,async()=>{
 const child=await ordinaryHostFixture(await tempDir("dashboard-ordinary-"));const original=fs.fsyncSync;let hit=0;
 try{const w=await hostWorld(false,"signals",child.port);assert.throws(()=>openDashboardHost({...w.options,ordinary:{...child.port}}),/original/);
  const done=child.run("one");await child.ready("one");const view=child.port.inspect() as any;
  const native:OrdinaryCancellation={version:"ordinary-cancel-v1",requestId:"ordinary:stop",bindingDigest:child.port.bindingDigest,expectedRevision:view.revision,target:view.children[0].target};w.authority!.ordinary={bindingDigest:child.port.bindingDigest,requestDigests:[ordinaryCancellationDigest(native)]};
  const request=await w.request("ordinary-cancel",native);
  if(fault){fs.fsyncSync=((fd:number)=>{const value=original(fd);if(fs.readlinkSync('/proc/self/fd/'+fd)===w.config.trustDirectory+'/producer-host/events.jsonl'&&++hit===2)throw Error("lost final ordinary host acknowledgement");return value;}) as typeof fs.fsyncSync;syncBuiltinESMExports();await assert.rejects(dashboardHostAction(w.host,JSON.stringify(request)),/lost final ordinary/);}
  else assert.equal((await dashboardHostAction(w.host,JSON.stringify(request)) as any).result.state,"abort-requested");
  fs.fsyncSync=original;syncBuiltinESMExports();assert.equal((await done).error.code,"CHILD_CANCELLED");
  const settled=child.port.inspect() as any;assert.equal(settled.children[0].state,"settled");const before=JSON.stringify(settled);
  await w.reopen().action(request);assert.equal(JSON.stringify(child.port.inspect()),before,"duplicate host request cannot abort/relaunch/refund again");assert.equal((await w.reopen().frame()).control,fault?"failed":"not-assessed");if(fault)assert.ok(hit>=2);
 }finally{fs.fsyncSync=original;syncBuiltinESMExports();await child.close();}
});
test("existing dashboard applies actual versioned goal/obligation successors without changing scope or acceptance",async()=>{
 const w=await hostWorld(false),p=selectionProposal();await w.pause();
 const native=JSON.parse(JSON.stringify({version:"intent-request-v2",requestId:"dashboard:successors",bindingDigest:w.config.budgetDigest,expectedRevision:0,expectedSelection:w.config.selection,action:"revise-selection",events:p.events,selection:p.selection,priorities:p.priorities})) as IntentRequest;
 w.authority!.dispatch!.requestDigests=[...w.authority!.dispatch!.requestDigests,intentRequestDigest(native)];const request=await w.request("intent",native);await dashboardHostAction(w.host,JSON.stringify(request));
 const bytes=await readFile(w.workPath,"utf8"),projected=projectWorkLedger(bytes,{selectedSnapshot:p.selection,authority:null});assert.equal(projected.scopeState,"valid");assert.equal((await readDailyView({workLedgerPath:w.workPath,workContext:{selectedSnapshot:p.selection,authority:null}})).scope?.revision,1);assert.ok(projected.obligations.every(o=>o.binding.obligation.revision===2));assert.ok(projected.obligations.every(o=>o.acceptance!=="accepted-under-supplied-authority"));
 await w.reopen().action(request);assert.equal(await readFile(w.workPath,"utf8"),bytes);
});
