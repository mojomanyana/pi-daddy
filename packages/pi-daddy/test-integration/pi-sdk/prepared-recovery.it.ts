/** Actual /new and isolated package updates must reuse work or continue only a proven unstarted attempt. */
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { recoveryFixture } from "./prepared-recovery-fixture.ts";

test("completed output survives a package update and real /new without another child", async () => {
  const f = await recoveryFixture();
  try {
    const snapshot = await f.success("principal_workflow", { action: "snapshot" });
    const prepared = await f.success("principal_workflow", {
      action: "prepare",
      task: "workshop-desk",
      step: "backend",
      phase: "build",
      expectedCandidate: snapshot.candidate,
    });
    const described = await f.success("delegate_describe", { agent: prepared.delegationArguments.agent });
    const dispatch = {
      ...prepared.delegationArguments,
      ...described.delegationArguments,
      task: "Return local fixture observations without editing files.",
      thinking: "high",
    };
    const result = await f.success("delegate", dispatch);
    assert.equal(result.final.state, "complete");
    assert.equal(await f.launches(), 1);
    const completed = await f.success("principal_workflow", {
      ...prepared.statusArguments,
      action: "complete",
      disposition: "unverified",
    });
    assert.equal(completed.completionValid, true);
    const originalOwner = f.host.session.sessionManager.getSessionId();
    const manifest = join(f.packageRoot, "package.json");
    const oldPackage = JSON.parse(await readFile(manifest, "utf8"));
    await writeFile(manifest, JSON.stringify({ ...oldPackage, version: "99.0.0-fixture" }));
    assert.deepEqual(await f.host.newSession(), { cancelled: false });
    assert.notEqual(f.host.session.sessionManager.getSessionId(), originalOwner);
    const oldStatus = await f.invoke("principal_workflow", prepared.statusArguments);
    assert.equal(oldStatus.isError, true, "ordinary status must not adopt an old owner or implementation");
    const recovered = await f.success("principal_workflow", { action: "recover", operationId: prepared.operation_id });
    assert.equal(recovered.state, "reused", JSON.stringify(recovered));
    assert.equal(recovered.approval, false);
    assert.equal(recovered.report.sha256, result.final.sha256);
    assert.ok(recovered.sourceRecovery, "retained Build can be used as an independently reviewed source");
    assert.equal(await f.launches(), 1);
    const again = await f.success("principal_workflow", { action: "recover", operationId: prepared.operation_id });
    assert.equal(again.state, "reused");
    assert.equal(await f.launches(), 1);
    assert.equal((await readdir(join(f.root, ".principal/workflow"))).length, 1);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("producer-proven no-start continues once after /new; missing history never permits dispatch", async () => {
  const f = await recoveryFixture();
  try {
    const snapshot = await f.success("principal_workflow", { action: "snapshot" });
    const prepared = await f.success("principal_workflow", {
      action: "prepare",
      task: "workshop-desk",
      step: "backend",
      phase: "build",
      expectedCandidate: snapshot.candidate,
    });
    const described = await f.success("delegate_describe", { agent: prepared.delegationArguments.agent });
    const dispatch = {
      ...prepared.delegationArguments,
      ...described.delegationArguments,
      task: "Return local fixture observations without editing files.",
      thinking: "high",
    };
    const denied = await f.invoke("delegate", {
      ...dispatch,
      context: { mode: "summary", summary: "Context outside this fixture grant." },
    });
    assert.equal(denied.isError, true);
    assert.equal(await f.launches(), 0);
    assert.deepEqual(await f.host.newSession(), { cancelled: false });
    const inspected = await f.success("principal_workflow", { action: "recover", operationId: prepared.operation_id });
    assert.equal(inspected.state, "ready-to-continue", JSON.stringify(inspected));
    const successor = await f.success("principal_workflow", inspected.continueArguments);
    assert.equal(successor.state, "recovered", JSON.stringify(successor));
    assert.notEqual(successor.successor.operation_id, prepared.operation_id);
    const again = await f.success("principal_workflow", inspected.continueArguments);
    assert.equal(again.successor.operation_id, successor.successor.operation_id);
    const current = await f.success("delegate_describe", { agent: successor.delegationArguments.agent });
    const continued = {
      ...successor.delegationArguments,
      ...current.delegationArguments,
      task: dispatch.task,
      thinking: "high",
    };
    const result = await f.success("delegate", continued);
    assert.equal(result.final.state, "complete");
    assert.equal(await f.launches(), 1);
    const repeated = await f.success("delegate", continued);
    assert.equal(repeated.operation.reused, true);
    assert.equal(await f.launches(), 1);
    const untouched = await f.success("principal_workflow", {
      action: "prepare",
      task: "workshop-desk",
      step: "ui",
      phase: "build",
      expectedCandidate: snapshot.candidate,
    });
    assert.deepEqual(await f.host.newSession(), { cancelled: false });
    const unknown = await f.success("principal_workflow", { action: "recover", operationId: untouched.operation_id });
    assert.equal(unknown.state, "uncertain", JSON.stringify(unknown));
    assert.equal(unknown.continueArguments, undefined);
    assert.equal(unknown.delegationArguments, undefined);
    assert.ok(unknown.nextAction);
    assert.equal(await f.launches(), 1);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
