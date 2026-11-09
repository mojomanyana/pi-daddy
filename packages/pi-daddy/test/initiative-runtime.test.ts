import assert from "node:assert/strict";
import { test, after } from "node:test";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
import { registerInitiativeRuntime, INITIATIVE_EVENT } from "../extensions/initiative-runtime.ts";
import { claimWithArtifact, operationHistory, retainOperationArtifact } from "../extensions/delegation-artifacts.ts";
import { bindOperationFinals } from "../extensions/delegation-operations.ts";
import { createAutoModeAuthority } from "../src/governance/auto-mode-policy.ts";
import { readInitiativeState } from "../src/governance/initiative-state.ts";
import type { GrantsSession } from "../extensions/session.ts";
after(cleanupTempDirs);
test("selected work-map association links real durable admission; replay never dispatches and stale selection is fenced", async () => {
  const root = await tempDir("initiative-adapter-"),
    prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const listeners = new Map<string, (v: any) => void>(),
    tools = new Map<string, any>();
  const pi = {
    events: {
      on(name: string, fn: any) {
        listeners.set(name, fn);
        return () => listeners.delete(name);
      },
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
  };
  const auto = await createAutoModeAuthority({ enabled: false, source: "default" });
  const operations = auto.operations!;
  const session = {
    mayDelegate: true,
    autoMode: { operations },
    reloadLifecycle: { root: {} },
  } as unknown as GrantsSession;
  const owner = { sessionId: "parent", cwd: root, lifecycle: {} };
  let current: typeof owner | undefined = owner,
    valid = true,
    ready = true;
  let handle: any;
  let selectionChecks = 0,
    observationChecks = 0,
    observationAllowed = true;
  const seenCurrentEffects: string[] = [];
  const runtime = registerInitiativeRuntime(pi as never, session, () => current);
  const query = (value: any) =>
    new Promise<any>((reply) =>
      listeners.get(INITIATIVE_EVENT)!({
        version: 1,
        requestId: "request",
        sessionId: "parent",
        cwd: root,
        ...value,
        reply,
      }),
    );
  const task = {
    taskId: "TSK-one",
    taskRevision: "sha256:" + "a".repeat(64),
    effectScope: "external",
    effectTarget: { owner: "fixture", kind: "external-change", reference: "target:one" },
  };
  const identity = {
    operationId: "operation:one",
    executionId: "exec:one",
    requestDigest: "b".repeat(64),
    cwd: root,
    workspaceId: null,
  };
  try {
    bindOperationFinals(session, "parent", root);
    const bad = await query({ action: "acquire", initiativeId: "bookie:v/p", expectedRevision: null, tasks: [task] });
    assert.equal(bad.ok, false);
    const acquired = await query({
      action: "acquire",
      initiativeId: "bookie:v/p",
      expectedRevision: null,
      tasks: [task],
      assertExecutionScope(scope: any) {
        assert.equal(scope.cwd, root, "task repository mismatch");
        assert.equal(scope.workspaceId, null);
      },
      async assertTaskReady() {
        if (!ready) throw Error("prerequisite unavailable");
        if (handle) {
          const observed = await handle.observe({ initiativeId: "bookie:v/p", ...task });
          seenCurrentEffects.push(observed.effectObservation?.outcome ?? "unavailable");
          if (observed.effectObservation?.outcome === "applied") throw Error("effect already applied");
        }
      },
      assertObservationAuthority() {
        observationChecks++;
        if (!observationAllowed) throw Error("observation revoked");
      },
      assertSelection() {
        selectionChecks++;
        if (!valid) throw Error("selection changed");
      },
    });
    assert.equal(acquired.ok, true);
    handle = acquired.handle;
    assert.equal(selectionChecks, 5, "acquisition retains owner checks without semantic dashboard fan-out");
    for (let i = 0; i < 20; i++) session.refreshInitiative!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(selectionChecks, 5);
    const beforeObservation = selectionChecks;
    const actualObservation = await handle.observe({ initiativeId: "bookie:v/p", ...task });
    await actualObservation.assertCurrent();
    assert.equal(selectionChecks, beforeObservation, "read-only observation does not repeat semantic selection scans");
    assert.equal(observationChecks, 5, "read permission and currentness remain freshly checked");
    observationAllowed = false;
    await assert.rejects(handle.observe({ initiativeId: "bookie:v/p", ...task }), /observation revoked/);
    observationAllowed = true;
    ready = false;
    await assert.rejects(
      tools.get("initiative_task").execute("blocked", { ...task, operationId: "operation:blocked" }),
      /prerequisite/,
    );
    assert.equal(readInitiativeState(root, "bookie:v/p")!.record.tasks.length, 0);
    ready = true;
    await assert.rejects(
      tools.get("initiative_task").execute("bad", { ...task, taskId: "unknown", operationId: "operation:bad" }),
      /outside/,
    );
    const result = await tools
      .get("initiative_task")
      .execute("associate", { ...task, operationId: identity.operationId });
    assert.equal(result.details.dispatchStarted, false);
    let elections = 0;
    const claim = await claimWithArtifact(session, identity, () => {
      elections++;
      return operations.claim(identity);
    });
    const recorded = readInitiativeState(root, "bookie:v/p")!.record.tasks[0].attempts;
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].executionId, identity.executionId);
    const wrongRoot = await tempDir("initiative-other-repo-");
    await assert.rejects(claim.started!(wrongRoot, null), /task repository mismatch/);
    await claim.started!(root, null);
    assert.ok(
      seenCurrentEffects.includes("unknown"),
      "own admitted attempt reaches start with honest unknown effect state",
    );
    await tools.get("initiative_task").execute("associate-competing", { ...task, operationId: "operation:competing" });
    const competing = { ...identity, operationId: "operation:competing", executionId: "exec:competing" };
    await assert.rejects(
      claimWithArtifact(session, competing, () => operations.claim(competing)),
      /unresolved attempts/,
    );
    assert.equal(
      readInitiativeState(root, "bookie:v/p")!.record.tasks[0].attempts.length,
      1,
      "prior unresolved attempt prevents a new begin",
    );
    await claim.finish!("not-started", { cleanup: { state: "not-started" } });
    await claimWithArtifact(session, identity, () => {
      elections++;
      return operations.claim(identity);
    });
    assert.equal(elections, 2, "live registry owns replay election, without creating another attempt");
    assert.equal(readInitiativeState(root, "bookie:v/p")!.record.tasks[0].attempts.length, 1);
    await tools.get("initiative_task").execute("associate2", { ...task, operationId: "operation:two" });
    const next = { ...identity, operationId: "operation:two", executionId: "exec:two" };
    const captured = session.initiativeOperations!.capture(next)!;
    current = undefined;
    await assert.rejects(captured.begin(), /selection changed/);
    assert.equal(readInitiativeState(root, "bookie:v/p")!.record.tasks[0].attempts.length, 1);
    current = owner;
    valid = false;
    await assert.rejects(
      tools.get("initiative_task").execute("associate3", { ...task, operationId: "operation:three" }),
      /selection changed/,
    );
    valid = true;
    await tools.get("initiative_task").execute("associate3", { ...task, operationId: "operation:three" });
    const third = { ...identity, operationId: "operation:three", executionId: "exec:three" };
    const originalBindings = session.initiativeOperations!;
    session.initiativeOperations = {
      capture(request) {
        const captured = originalBindings.capture(request);
        return (
          captured && {
            ...captured,
            async begin() {
              await captured.begin();
              valid = false;
              throw Error("selection revoked after exact attempt retention");
            },
          }
        );
      },
    };
    await assert.rejects(
      claimWithArtifact(session, third, () => operations.claim(third)),
      /revoked after exact attempt/,
    );
    const noStart = operationHistory(session, third.operationId, false)!;
    assert.equal(noStart.operation.executionId, third.executionId);
    assert.equal(noStart.operation.state, "not-started");
    assert.equal(noStart.operation.runtime?.cleanup?.state, "not-started");
    assert.ok(noStart.artifact, "original producer retains known no-start despite revoked task selection");
    await runtime.reset();
    valid = true;
    current = { ...owner, sessionId: "replacement", lifecycle: {} };
    const revision = readInitiativeState(root, "bookie:v/p")!.revision;
    const replacement = await query({
      action: "acquire",
      sessionId: "replacement",
      initiativeId: "bookie:v/p",
      expectedRevision: revision,
      tasks: [task],
      assertSelection() {},
      assertTaskReady() {},
      assertExecutionScope() {},
    });
    assert.equal(replacement.ok, true, "new selection reconciles actual no-start evidence, not absence");
    assert.equal(replacement.generation, 2);
    const beforeRead = readInitiativeState(root, "bookie:v/p")!;
    const inherited = await replacement.handle.observe({ initiativeId: "bookie:v/p", ...task });
    assert.equal(inherited.claim, "unclaimed", "real retained no-start attempts do not strand a new coordinator");
    assert.equal(inherited.execution, "settled");
    assert.equal(inherited.reconciliationRequired, false);
    assert.equal(readInitiativeState(root, "bookie:v/p")!.revision, beforeRead.revision);
    await replacement.handle.associate({ initiativeId: "bookie:v/p", ...task, operationId: "operation:replacement" });
    assert.equal(readInitiativeState(root, "bookie:v/p")!.record.tasks[0].generation, 2);
    assert.equal(
      readInitiativeState(root, "bookie:v/p")!.record.tasks[0].attempts.length,
      2,
      "claim does not dispatch another attempt",
    );
  } finally {
    await runtime.close();
    await auto.close();
    prior === undefined ? delete process.env.PI_CODING_AGENT_DIR : (process.env.PI_CODING_AGENT_DIR = prior);
  }
});

test("the selected task wakes only after both artifact retention and live finish, even when settlement yields", async () => {
  const root = await tempDir("initiative-finish-order-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const events: string[] = [];
    const request = {
      operationId: "op:finish",
      executionId: "exec:finish",
      requestDigest: "f".repeat(64),
      cwd: root,
      workspaceId: null,
    };
    const session = {
      reloadLifecycle: { root: {} },
      initiativeOperations: {
        capture: () => ({
          async begin() {},
          async assertCurrent() {},
          async notAdmitted() {},
          settled() {
            events.push("settled");
          },
        }),
      },
    } as unknown as GrantsSession;
    bindOperationFinals(session, "parent", root, () => events.push("artifact"));
    let resolveFinish!: () => void;
    const barrier = new Promise<void>((r) => (resolveFinish = r));
    const running = {
      operationId: request.operationId,
      executionId: request.executionId,
      cwd: root,
      workspaceId: null,
      state: "running" as const,
      startedAt: "start",
      updatedAt: "now",
    };
    const claim = await claimWithArtifact(session, request, async () => ({
      operation: running,
      reused: false,
      started: async () => {},
      finish: () => barrier,
    }));
    retainOperationArtifact(claim, {
      operation: {
        ...running,
        state: "settled",
        runtime: { cleanup: { state: "settled", executionId: request.executionId } },
      },
    });
    const finish = claim.finish!("settled");
    await Promise.resolve();
    assert.deepEqual(events, ["artifact"]);
    resolveFinish();
    await finish;
    assert.deepEqual(events, ["artifact", "settled"]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
