import assert from "node:assert/strict";
import { test, after } from "node:test";
import { unlink } from "node:fs/promises";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
import { acquireInitiativeCoordinator } from "../src/governance/initiative-coordinator.ts";
import { readInitiativeState, initiativeLocation } from "../src/governance/initiative-state.ts";
import type { InitiativeTask } from "../src/kernel/initiative.ts";
after(cleanupTempDirs);
const id = "bookie:vault/project";
const task: InitiativeTask = { taskId: "TSK-one", taskRevision: "a".repeat(64), effectScope: "local" };
const request = (cwd: string, n = "one") => ({
  operationId: "operation:" + n,
  executionId: "exec:" + n,
  requestDigest: "b".repeat(64),
  cwd,
  workspaceId: null,
});
test("one OS-held coordinator, exact generation CAS and no takeover from merely releasing the lock", async () => {
  const root = await tempDir("initiative-lock-");
  const owner = { sessionId: "first", cwd: root };
  let state: "settled" | "not-started" | "running" | "unknown" = "unknown";
  const options = { assertAuthority() {}, resolveAttempt: async () => state };
  const a = await acquireInitiativeCoordinator(root, { initiativeId: id, owner, expectedRevision: null }, options);
  try {
    await a.claim(task);
    await assert.rejects(
      acquireInitiativeCoordinator(root, { initiativeId: id, owner, expectedRevision: a.revision() }, options),
      /another live/,
    );
    await a.begin(task, request(root));
    await assert.rejects(a.begin(task, request(root, "two")), /unresolved/);
    await assert.rejects(a.release(), /reconciliation/);
    const observation = await a.observe({ initiativeId: id, ...task });
    assert.equal(observation.status, "observed");
    if (observation.status === "observed") assert.equal(observation.reconciliationRequired, true);
  } finally {
    await a.close();
  }
  const revision = readInitiativeState(root, id)!.revision;
  await assert.rejects(
    acquireInitiativeCoordinator(
      root,
      { initiativeId: id, owner: { ...owner, sessionId: "next" }, expectedRevision: revision },
      options,
    ),
    /reconciliation/,
  );
  state = "settled";
  const b = await acquireInitiativeCoordinator(
    root,
    { initiativeId: id, owner: { ...owner, sessionId: "next" }, expectedRevision: revision },
    options,
  );
  try {
    assert.equal(b.generation, 2);
    const retained = readInitiativeState(root, id)!.record.tasks[0].attempts[0];
    assert.equal(retained.owner.sessionId, "first", "takeover cannot rewrite original producer provenance");
    await assert.rejects(a.claim(task), /no longer current/);
    const beforeObservation = readInitiativeState(root, id)!;
    const inherited = await b.observe({ initiativeId: id, ...task });
    assert.equal(inherited.status, "observed");
    if (inherited.status !== "observed") throw Error("missing inherited owner facts");
    assert.equal(inherited.claim, "unclaimed", "settled previous generation is available to explicitly reclaim");
    assert.equal(inherited.execution, "settled");
    assert.equal(
      readInitiativeState(root, id)!.revision,
      beforeObservation.revision,
      "observation cannot reclaim a task",
    );
    assert.equal(readInitiativeState(root, id)!.record.tasks[0].generation, 1);
    state = "unknown";
    const lostProof = await b.observe({ initiativeId: id, ...task });
    if (lostProof.status !== "observed") throw Error("missing uncertain facts");
    assert.equal(lostProof.claim, "uncertain");
    await assert.rejects(b.claim(task), /reconciliation/);
    state = "running";
    const running = await b.observe({ initiativeId: id, ...task });
    if (running.status !== "observed") throw Error("missing running facts");
    assert.equal(running.claim, "other-owner");
    assert.equal(running.execution, "running");
    await assert.rejects(b.claim(task), /reconciliation/);
    state = "settled";
    await b.claim(task);
    const observed = await b.observe({ initiativeId: id, ...task });
    if (observed.status !== "observed") throw Error("missing observation");
    assert.equal(observed.claim, "owned");
    assert.equal(observed.execution, "settled");
    state = "unknown";
    await assert.rejects(Promise.resolve().then(observed.assertCurrent), /changed/);
    state = "settled";
    await b.claim({ ...task, taskId: "TSK-other" });
    await assert.rejects(Promise.resolve().then(observed.assertCurrent), /changed/);
    await b.release();
  } finally {
    await b.close();
  }
});
test("external effects, unknown selections and deleted ownership records never become empty safe state", async () => {
  const root = await tempDir("initiative-external-");
  let allowed = true;
  const options = {
    assertAuthority() {
      if (!allowed) throw Error("revoked selection");
    },
    resolveAttempt: async () => "settled" as const,
  };
  const c = await acquireInitiativeCoordinator(
    root,
    { initiativeId: id, owner: { sessionId: "parent", cwd: root }, expectedRevision: null },
    options,
  );
  const external = { ...task, effectScope: "external" as const };
  try {
    await c.claim(external);
    await c.begin(external, request(root));
    await assert.rejects(c.release(), /reconciliation/);
    allowed = false;
    await assert.rejects(
      c.observe({ initiativeId: id, ...external }, external),
      /revoked/,
      "legacy clients retain full observation checks",
    );
    await assert.rejects(c.claim({ ...task, taskId: "TSK-new" }), /revoked/);
    assert.equal(readInitiativeState(root, id)!.record.tasks.length, 1);
  } finally {
    await c.close();
  }
  const { path } = initiativeLocation(root, id);
  await unlink(path);
  assert.throws(() => readInitiativeState(root, id), /restore trusted state/);
  allowed = true;
  await assert.rejects(
    acquireInitiativeCoordinator(
      root,
      { initiativeId: id, owner: { sessionId: "replacement", cwd: root }, expectedRevision: null },
      options,
    ),
    /restore trusted state/,
  );
});
test("no-start proof permits clean ownership release without asserting task quality", async () => {
  const root = await tempDir("initiative-no-start-");
  const c = await acquireInitiativeCoordinator(
    root,
    { initiativeId: id, owner: { sessionId: "parent", cwd: root }, expectedRevision: null },
    { assertAuthority() {}, resolveAttempt: async () => "not-started" },
  );
  try {
    const t = { ...task, effectScope: "unknown" as const };
    await c.claim(t);
    await c.begin(t, request(root));
    await c.notAdmitted(request(root));
    const status = await c.observe({ initiativeId: id, ...task });
    assert.equal(status.status, "observed");
    if (status.status === "observed") {
      assert.equal(status.reconciliationRequired, false);
      assert.equal((status as any).approval, undefined);
    }
    await c.release();
    assert.equal(readInitiativeState(root, id)!.record.state, "released");
  } finally {
    await c.close();
  }
});

test("restart recovery verifies exact external receipt without claiming a new generation or dispatch authority", async () => {
  const root = await tempDir("initiative-receipt-");
  const owner = { sessionId: "original", cwd: root },
    external = { ...task, effectScope: "external" as const };
  let state: "settled" | "running" = "settled",
    allowed = true,
    receiptCurrent = true,
    revokeDuringReceipt = false;
  const receipt = { reference: "bookie:RCPT-provider-one", sha256: "c".repeat(64) };
  const verify = (input: any) => {
    assert.equal(input.owner.sessionId, "original");
    assert.equal(input.operationId, "operation:one");
    assert.equal(input.executionId, "exec:one");
    assert.deepEqual(input.receipt, receipt);
    if (!receiptCurrent) throw Error("receipt source changed");
    if (revokeDuringReceipt) allowed = false;
  };
  const options = {
    assertAuthority() {
      if (!allowed) throw Error("selection revoked");
    },
    resolveAttempt: async () => state,
    assertEffectReconciled: verify,
  };
  const first = await acquireInitiativeCoordinator(root, { initiativeId: id, owner, expectedRevision: null }, options);
  await first.claim(external);
  await first.begin(external, request(root));
  await first.close();
  const old = readInitiativeState(root, id)!;
  await assert.rejects(
    acquireInitiativeCoordinator(root, { initiativeId: id, owner, expectedRevision: old.revision }, options),
    /reconciliation/,
  );
  const recovery = await acquireInitiativeCoordinator(
    root,
    {
      initiativeId: id,
      owner: { ...owner, sessionId: "recovery" },
      expectedRevision: old.revision,
      recoveryOnly: true,
    },
    options,
  );
  try {
    assert.equal(recovery.recoveryOnly, true);
    assert.equal(recovery.generation, 1);
    assert.equal(
      readInitiativeState(root, id)!.revision,
      old.revision,
      "recovery acquisition must not rewrite old ownership",
    );
    await assert.rejects(recovery.claim(external), /recovery-only/);
    const pending = await recovery.pendingEffects();
    assert.equal(pending.length, 1);
    const input = { ...pending[0], receipt };
    await assert.rejects(recovery.reconcileEffect({ ...input, executionId: "exec:wrong" }), /outside/);
    state = "running";
    await assert.rejects(recovery.reconcileEffect(input), /settlement required/);
    state = "settled";
    receiptCurrent = false;
    await assert.rejects(recovery.reconcileEffect(input), /source changed/);
    receiptCurrent = true;
    assert.equal(readInitiativeState(root, id)!.revision, old.revision);
    allowed = false;
    await assert.rejects(recovery.reconcileEffect(input), /revoked/);
    allowed = true;
    revokeDuringReceipt = true;
    await assert.rejects(
      recovery.reconcileEffect(input),
      /revoked/,
      "mutation authority rechecks after awaited receipt verification",
    );
    assert.equal(readInitiativeState(root, id)!.revision, old.revision, "revoked receipt confirmation cannot publish");
    revokeDuringReceipt = false;
    allowed = true;
    assert.deepEqual(await recovery.reconcileEffect(input), {
      reconciled: true,
      taskAccepted: false,
      executionAuthorized: false,
    });
    assert.equal((await recovery.pendingEffects()).length, 0);
    const observed = await recovery.observe({ initiativeId: id, ...task });
    if (observed.status !== "observed") throw Error("missing exact observation");
    assert.equal(observed.execution, "settled");
    assert.equal(observed.claim, "other-owner");
    assert.equal(observed.reconciliationRequired, false);
    assert.equal(
      observed.effectObservation,
      undefined,
      "old outcome-less receipts remain readable without invented outcomes",
    );
    receiptCurrent = false;
    await assert.rejects(Promise.resolve().then(observed.assertCurrent), /changed/);
    await assert.rejects(recovery.release(), /reconciliation/);
    receiptCurrent = true;
    await recovery.release();
  } finally {
    await recovery.close();
  }
  const next = await acquireInitiativeCoordinator(
    root,
    {
      initiativeId: id,
      owner: { ...owner, sessionId: "next" },
      expectedRevision: readInitiativeState(root, id)!.revision,
    },
    options,
  );
  try {
    assert.equal(next.generation, 2);
    assert.equal(readInitiativeState(root, id)!.record.tasks[0].attempts[0].owner.sessionId, "original");
  } finally {
    await next.close();
  }
});

test("read-only observation authority never substitutes for mutation authority or exact owner state", async () => {
  const root = await tempDir("initiative-observation-authority-");
  let semantic = 0,
    reads = 0,
    allowMutation = true,
    allowRead = true;
  const c = await acquireInitiativeCoordinator(
    root,
    { initiativeId: id, owner: { sessionId: "owner", cwd: root }, expectedRevision: null },
    {
      assertAuthority() {
        semantic++;
        if (!allowMutation) throw Error("mutation revoked");
      },
      assertObservationAuthority() {
        reads++;
        if (!allowRead) throw Error("observation revoked");
      },
      resolveAttempt: async () => "not-started",
    },
  );
  try {
    const base = semantic;
    const observed = await c.observe({ initiativeId: id, ...task }, task);
    assert.equal(observed.status, "observed");
    if (observed.status !== "observed") throw Error("missing owner facts");
    await observed.assertCurrent();
    assert.equal(semantic, base);
    assert.equal(reads, 4);
    allowMutation = false;
    await assert.rejects(c.claim(task), /mutation revoked/);
    await assert.rejects(c.release(), /mutation revoked/);
    assert.equal(readInitiativeState(root, id)!.record.tasks.length, 0);
    allowRead = false;
    await assert.rejects(Promise.resolve().then(observed.assertCurrent), /observation revoked/);
    await assert.rejects(c.observe({ initiativeId: id, ...task }, task), /observation revoked/);
    allowMutation = true;
    allowRead = true;
    await c.claim(task);
    await assert.rejects(Promise.resolve().then(observed.assertCurrent), /changed/);
    await c.close();
    await assert.rejects(c.observe({ initiativeId: id, ...task }, task), /no longer current/);
  } finally {
    await c.close();
  }
});

test("review handoff binds exactly one admitted settled attempt and expires when the task gains another attempt", async () => {
  const root = await tempDir("initiative-handoff-"),
    owner = { sessionId: "parent", cwd: root };
  let result: "running" | "settled" = "running";
  const c = await acquireInitiativeCoordinator(
    root,
    { initiativeId: id, owner, expectedRevision: null },
    { assertAuthority() {}, resolveAttempt: async () => result },
  );
  const selected = { initiativeId: id, taskId: task.taskId, taskRevision: task.taskRevision };
  try {
    await c.claim(task);
    await c.begin(task, request(root));
    assert.equal(await c.handoffAttempt(selected, task), undefined);
    result = "settled";
    assert.equal(await c.handoffAttempt({ ...selected, taskRevision: "b".repeat(64) }, task), undefined);
    const first = await c.handoffAttempt(selected, task);
    assert.equal(first?.attempt.executionId, "exec:one");
    await c.begin(task, request(root, "two"));
    assert.equal(await c.handoffAttempt(selected, task), undefined, "ambiguous outputs require a choice");
    await assert.rejects(async () => first!.assertCurrent());
  } finally {
    await c.close();
  }
});
