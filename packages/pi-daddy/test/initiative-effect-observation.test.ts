import assert from "node:assert/strict";
import { test, after } from "node:test";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
import { acquireInitiativeCoordinator } from "../src/governance/initiative-coordinator.ts";
import { readInitiativeState } from "../src/governance/initiative-state.ts";
import type { InitiativeTask, InitiativeEffectReceipt } from "../src/kernel/initiative.ts";
after(cleanupTempDirs);
test("exact target outcomes survive observation; unknown and revoked attestations never reconcile effects", async () => {
  const root = await tempDir("initiative-effect-observation-");
  const initiativeId = "bookie:vault/targets",
    owner = { sessionId: "original", cwd: root };
  const target = { owner: "fixture-owner", kind: "external-change", reference: "target:one" };
  const task: InitiativeTask = {
    taskId: "TSK-one",
    taskRevision: "sha256:" + "a".repeat(64),
    effectScope: "external",
    effectTarget: { ...target },
  };
  const identity = { initiativeId, taskId: task.taskId, taskRevision: task.taskRevision };
  const operation = {
    operationId: "effect:one",
    executionId: "exec:one",
    requestDigest: "b".repeat(64),
    cwd: root,
    workspaceId: null,
  };
  let native: "running" | "settled" = "running",
    receiptCurrent = true;
  let expected: InitiativeEffectReceipt;
  const c = await acquireInitiativeCoordinator(
    root,
    { initiativeId, owner, expectedRevision: null },
    {
      assertAuthority() {},
      resolveAttempt: async (attempt) => (attempt.state === "not-admitted" ? "not-started" : native),
      assertEffectReconciled(input) {
        if (!receiptCurrent) throw Error("selected source changed");
        assert.deepEqual(input.owner, owner);
        assert.equal(input.operationId, operation.operationId);
        assert.equal(input.executionId, operation.executionId);
        assert.deepEqual(input.receipt, expected);
      },
    },
  );
  try {
    const before = await c.observe(identity, task);
    assert.equal(before.status, "observed");
    if (before.status !== "observed") throw Error("missing observation");
    assert.deepEqual(before.effectObservation, { target, outcome: "pending", provenance: "not-observed" });
    await c.claim(task);
    task.effectTarget!.reference = "mutated caller";
    assert.deepEqual(readInitiativeState(root, initiativeId)!.record.tasks[0].effectTarget, target);
    task.effectTarget = { ...target };
    await c.begin(task, operation);
    const attempt = {
      ...identity,
      effectScope: "external" as const,
      owner,
      operationId: operation.operationId,
      executionId: operation.executionId,
    };
    expected = {
      reference: "bookie:receipt-one",
      sha256: "c".repeat(64),
      observation: { target, outcome: "unknown", provenance: "operator-attested" },
    };
    await assert.rejects(c.reconcileEffect({ ...attempt, receipt: expected }), /native attempt settlement/);
    native = "settled";
    const unknownResult = await c.reconcileEffect({ ...attempt, receipt: expected });
    assert.equal(unknownResult.reconciled, false);
    assert.equal(unknownResult.taskAccepted, false);
    assert.equal(unknownResult.executionAuthorized, false);
    assert.deepEqual(unknownResult.effectObservation?.target, target);
    const unknown = await c.observe(identity);
    assert.equal(unknown.status, "observed");
    if (unknown.status !== "observed") throw Error("missing observation");
    assert.equal(unknown.reconciliationRequired, true);
    assert.equal(unknown.effectObservation?.outcome, "unknown");
    assert.equal(unknown.effectObservation?.provenance, "operator-attested");
    assert.deepEqual(unknown.effectObservation?.attempt, {
      owner,
      operationId: operation.operationId,
      executionId: operation.executionId,
    });
    assert.equal((await c.pendingEffects()).length, 1);
    assert.deepEqual((await c.pendingEffects())[0].effectTarget, target);
    await assert.rejects(
      c.begin(task, { ...operation, operationId: "effect:duplicate" }),
      /unresolved attempts|prior attempts need reconciliation/,
    );
    await assert.rejects(c.release(), /reconciliation/);
    expected = { ...expected, observation: { ...expected.observation!, outcome: "applied" } };
    assert.equal((await c.reconcileEffect({ ...attempt, receipt: expected })).reconciled, true);
    const applied = await c.observe(identity);
    if (applied.status !== "observed") throw Error("missing observation");
    assert.equal(applied.reconciliationRequired, false);
    assert.equal(applied.effectObservation?.outcome, "applied");
    assert.deepEqual(applied.effectObservation?.receipt, { reference: expected.reference, sha256: expected.sha256 });
    receiptCurrent = false;
    await assert.rejects(Promise.resolve().then(applied.assertCurrent), /changed/);
    const revoked = await c.observe(identity);
    if (revoked.status !== "observed") throw Error("missing observation");
    assert.equal(revoked.reconciliationRequired, true);
    assert.equal(revoked.effectObservation?.outcome, "unknown");
    assert.equal(revoked.effectObservation?.provenance, "not-observed");
    receiptCurrent = true;
    const sameTargetRevision = { ...task, taskRevision: "e".repeat(64) };
    await c.claim(sameTargetRevision);
    await assert.rejects(
      c.begin(sameTargetRevision, { ...operation, operationId: "effect:repeated", executionId: "exec:repeated" }),
      /target is already applied/,
    );
    await assert.rejects(
      c.reconcileEffect({
        ...attempt,
        receipt: { ...expected, observation: { ...expected.observation!, target: { ...target, reference: "wrong" } } },
      }),
      /target differs/,
    );
    await assert.rejects(
      c.claim({ ...task, effectTarget: { ...target, reference: "wrong" } }),
      /target changed without revision/,
    );
    expected = { ...expected, observation: { ...expected.observation!, outcome: "not-applied" } };
    const reconciled = await c.reconcileEffect({ ...attempt, receipt: expected });
    assert.equal(reconciled.reconciled, true);
    assert.equal(reconciled.taskAccepted, false);
    assert.equal(reconciled.executionAuthorized, false);
    assert.deepEqual(reconciled.effectObservation?.target, target);
    assert.equal(reconciled.effectObservation?.outcome, "not-applied");
    const absent = await c.observe(identity);
    if (absent.status !== "observed") throw Error("missing observation");
    assert.equal(absent.effectObservation?.outcome, "not-applied");
    const changed: InitiativeTask = {
      ...task,
      taskRevision: "d".repeat(64),
      effectTarget: { ...target, reference: "target:two" },
    };
    receiptCurrent = false;
    const pendingCurrent = await c.observe({ ...identity, taskRevision: changed.taskRevision }, changed);
    if (pendingCurrent.status !== "observed") throw Error("missing selected new revision");
    assert.equal(pendingCurrent.effectObservation?.outcome, "pending");
    assert.deepEqual(pendingCurrent.effectObservation?.target, changed.effectTarget);
    assert.equal(pendingCurrent.reconciliationRequired, true);
    receiptCurrent = true;
    const clearCurrent = await c.observe({ ...identity, taskRevision: changed.taskRevision }, changed);
    if (clearCurrent.status !== "observed") throw Error("missing selected new revision");
    assert.equal(clearCurrent.reconciliationRequired, false);
    assert.equal(clearCurrent.effectObservation?.outcome, "pending");
    await c.claim(changed);
    receiptCurrent = false;
    await assert.rejects(
      c.begin(changed, { ...operation, operationId: "effect:new-revision", executionId: "exec:new-revision" }),
      /unresolved attempts|prior attempts need reconciliation/,
      "revoked prior-revision receipt blocks begin even after current revision was claimed",
    );
    assert.equal(readInitiativeState(root, initiativeId)!.record.tasks.at(-1)!.attempts.length, 0);
    receiptCurrent = true;
    const newOperation = { ...operation, operationId: "effect:new-revision", executionId: "exec:new-revision" };
    await c.begin(changed, newOperation);
    receiptCurrent = false;
    await assert.rejects(
      c.assertPriorAttemptsSettled(changed, newOperation),
      /prior attempts need reconciliation before start/,
    );
    receiptCurrent = true;
    await c.assertPriorAttemptsSettled(changed, newOperation);
    await assert.rejects(
      c.assertPriorAttemptsSettled(changed, { ...newOperation, executionId: "wrong" }),
      /exact admitted/,
    );
    await c.notAdmitted(newOperation);
    await c.release();
  } finally {
    await c.close();
  }
});
