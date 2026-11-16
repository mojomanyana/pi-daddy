/** Real file-changing Build completion and /new recovery; authored partial output is never product approval. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { recoveryFixture } from "./prepared-recovery-fixture.ts";
import { PRODUCT_FILES, PRODUCT_REPORT } from "./native-product-extension.ts";

type Fixture = Awaited<ReturnType<typeof recoveryFixture>>;
const reportHash = createHash("sha256").update(PRODUCT_REPORT).digest("hex");

async function checkFiles(f: Fixture) {
  for (const [path, content] of Object.entries(PRODUCT_FILES)) {
    assert.equal(await readFile(join(f.root, path), "utf8"), content, path);
  }
}

async function build(f: Fixture) {
  const snapshot = await f.success("principal_workflow", { action: "snapshot" });
  const request = { action: "prepare", task: "workshop-desk", step: "backend", phase: "build" };
  const prepared = await f.success("principal_workflow", { ...request, expectedCandidate: snapshot.candidate });
  const described = await f.success("delegate_describe", { agent: prepared.delegationArguments.agent });
  const dispatch = {
    ...prepared.delegationArguments,
    ...described.delegationArguments,
    task: "Write the authored partial backend scaffold through write, then report its exact remaining work.",
    thinking: "high",
  };
  const result = await f.success("delegate", dispatch);
  assert.equal(result.operation.operationId, prepared.operation_id);
  assert.equal(result.final.state, "complete");
  assert.equal(result.final.text, PRODUCT_REPORT);
  assert.equal(result.final.sha256, reportHash);
  assert.equal(result.cleanup.state, "settled");
  assert.equal(await f.launches(), 1);
  await checkFiles(f);
  const changed = await f.success("principal_workflow", { action: "snapshot" });
  assert.notEqual(changed.candidate.id, snapshot.candidate.id);
  assert.deepEqual(changed.candidate.changedPaths.sort(), Object.keys(PRODUCT_FILES).sort());
  return { prepared, request, dispatch, result, changed };
}

async function checkRetained(f: Fixture, completed: any, operationId: string, outputId: string) {
  assert.equal(completed.operation_id, operationId);
  assert.equal(completed.state, "complete");
  assert.equal(completed.resultRetained, true);
  assert.equal(completed.completionValid, true, "valid retention is separate from product acceptance");
  assert.equal(completed.productChanged, true);
  assert.equal(completed.output.id, outputId);
  assert.equal(completed.disposition, "unverified");
  assert.equal(completed.approval, false);
  assert.equal(completed.report.sha256, reportHash);
  assert.equal(await readFile(completed.report.path, "utf8"), PRODUCT_REPORT);
  assert.equal(await f.launches(), 1);
}

test("a native Build that changes files completes its original operation without preparing again", async () => {
  const f = await recoveryFixture({ childExtension: "./native-product-extension.ts" });
  try {
    const { prepared, changed } = await build(f);
    const complete = await f.success("principal_workflow", {
      ...prepared.statusArguments,
      action: "complete",
      disposition: "unverified",
    });
    await checkRetained(f, complete, prepared.operation_id, changed.candidate.id);
    assert.equal((await readdir(join(f.root, ".principal/workflow"))).length, 1);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("mistaken reprepare keeps the changed Build result and unfinished work through real /new without rerunning", async () => {
  const f = await recoveryFixture({ childExtension: "./native-product-extension.ts" });
  try {
    const { prepared, request, dispatch, result, changed } = await build(f);
    const refused = await f.invoke("principal_workflow", { ...request, expectedCandidate: changed.candidate });
    assert.equal(refused.isError, true);
    const correction = refused.result.details;
    assert.equal(correction.code, "PREPARED_OUTPUT_CHANGED");
    assert.equal(correction.operation_id, prepared.operation_id);
    assert.equal(correction.candidateMatches, false);
    assert.equal(correction.resultRetained, false);
    assert.equal(correction.recovery.action, "retain-existing-result");
    assert.deepEqual(correction.recovery.requiredCompletionFields, ["disposition"]);
    assert.equal(correction.recovery.completionArguments.disposition, undefined);
    assert.equal(correction.delegationArguments, undefined);
    assert.equal(await f.launches(), 1);
    const status = await f.success("principal_workflow", correction.recovery.statusArguments);
    assert.equal(status.operation_id, prepared.operation_id);
    assert.equal(status.attempt, 1);
    assert.equal(status.resultRetained, false);
    const observed = await f.success("principal_workflow", correction.recovery.resultArguments);
    assert.equal(observed.state, "observed");
    assert.equal(observed.runtime.operationId, prepared.operation_id);
    assert.equal(observed.final.text, PRODUCT_REPORT);
    assert.equal(observed.final.sha256, result.final.sha256);
    assert.equal(observed.approval, false);
    const completeArguments = { ...correction.recovery.completionArguments, disposition: "unverified" };
    const complete = await f.success("principal_workflow", completeArguments);
    await checkRetained(f, complete, prepared.operation_id, changed.candidate.id);
    const repeat = await f.success("principal_workflow", completeArguments);
    assert.equal(repeat.reused, true);
    await checkRetained(f, repeat, prepared.operation_id, changed.candidate.id);
    const redispatch = await f.success("delegate", dispatch);
    assert.equal(redispatch.operation.reused, true);
    assert.equal(redispatch.operation.executionId, result.operation.executionId);
    assert.equal(await f.launches(), 1);
    const oldOwner = f.host.session.sessionManager.getSessionId();
    assert.deepEqual(await f.host.newSession(), { cancelled: false });
    assert.notEqual(f.host.session.sessionManager.getSessionId(), oldOwner);
    const oldCompletion = await f.invoke("principal_workflow", completeArguments);
    assert.equal(oldCompletion.isError, true, "new session must not adopt the original completion authority");
    const recovered = await f.success("principal_workflow", { action: "recover", operationId: prepared.operation_id });
    assert.equal(recovered.state, "reused");
    assert.equal(recovered.operation_id, prepared.operation_id);
    assert.equal(recovered.approval, false);
    assert.equal(recovered.disposition, "unverified");
    assert.equal(recovered.report.sha256, reportHash);
    const recalledReport = await readFile(recovered.report.path, "utf8");
    assert.equal(recalledReport, PRODUCT_REPORT);
    assert.match(recalledReport, /Unfinished: workshop CRUD, durable persistence and UI/);
    assert.match(recalledReport, /No product tests or research were performed/);
    await checkFiles(f);
    assert.equal(await f.launches(), 1);
    assert.equal((await readdir(join(f.root, ".principal/workflow"))).length, 1);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
