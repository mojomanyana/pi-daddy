import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { declareWork } from "../src/work-command.ts";
import { adoptDashboardHarnessBridge } from "../src/dashboard-harness.ts";
import { startDailyDashboardHost } from "../src/daily-dashboard-host.ts";
import { connectDashboardHost } from "../src/dashboard-host-transport.ts";
import { connectedHarness } from "./dashboard-host-fixture.ts";
import { ordinaryHostFixture } from "./ordinary-host-fixture.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);

test("supported daily host command composition publishes fresh work and pauses only new ordinary dispatch", async () => {
  const root=await tempDir("daily-dashboard-production-"),declared=await declareWork({cwd:root,id:"daily-owned",outcome:"Exercise current work while steering only new dispatch"});
  const child=await ordinaryHostFixture(root),loadedRoot=join(root,"loaded");await mkdir(loadedRoot,{mode:0o700});const loaded=await connectedHarness(loadedRoot);
  const harness=adoptDashboardHarnessBridge({version:"skill-harness-dashboard-bridge-v1",sourceCommit:"127b349310dd8f28e5d6b12148a063fce66a77dd",api:loaded.api});
  const running=await startDailyDashboardHost({id:"validation-01",cwd:root,directory:join(root,"host"),declared,ordinary:child.port,harness,author:"operator"});
  try {
    const remote=connectDashboardHost(running.socketPath),first=await remote.frame() as any;
    assert.equal(first.source.daily.obligations.length,1);assert.equal(first.source.daily.attempts.length,0);assert.equal(first.source.observations.length,2);assert.equal(first.source.unobservedSources.length,0);
    const active=child.run("hold");await child.ready("hold");assert.deepEqual(first.actions.map((x:any)=>x.key),["pause-new-dispatch","refresh-current-work"]);await remote.humanAction("refresh-current-work");assert.equal((await remote.frame() as any).source.daily.attempts.length,1);
    await remote.humanAction("pause-new-dispatch");
    assert.match(String((await child.run("blocked")).error),/ordinary dispatch held/);assert.equal((child.port.inspect() as any).children.find((x:any)=>x.target.toolCallId==="call:hold").state,"active");
    assert.deepEqual((await remote.frame() as any).actions.map((x:any)=>x.key),["resume-dispatch","refresh-current-work"]);await remote.humanAction("resume-dispatch");
    assert.equal((await child.run("fast")).value.details.exitCode,0);await active;
  } finally {await running.close();await child.close();}
});
