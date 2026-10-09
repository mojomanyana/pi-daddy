import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
import { registerRuntimeSnapshot, RUNTIME_SNAPSHOT_EVENT } from "../extensions/runtime-snapshot.ts";
import type { GrantsSession } from "../extensions/session.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
after(cleanupTempDirs);
test("trusted bridge reports actual owner facts, rejects caller identity and survives replacing a reload registration", async () => {
  const root = await tempDir("runtime-bridge-"),
    prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const listeners = new Set<(value: unknown) => void>();
  const pi = {
    events: {
      on: (_name: string, fn: (value: unknown) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      emit: (_name: string, value: unknown) => {
        for (const fn of listeners) fn(value);
      },
    },
  } as unknown as ExtensionAPI;
  const session = {
    reloadLifecycle: { root: {} },
    executor: { kind: "process" },
    capacity: { reserved: 0 },
  } as unknown as GrantsSession;
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "actual-session" } } as unknown as ExtensionContext;
  const snapshot = (sessionId = "actual-session") =>
    new Promise<any>((resolve) =>
      pi.events.emit(RUNTIME_SNAPSHOT_EVENT, {
        version: 1,
        requestId: "request",
        sessionId,
        cwd: root,
        outstandingExecutionIds: [],
        reply: resolve,
      }),
    );
  try {
    const first = registerRuntimeSnapshot(pi, session);
    await first.bind(ctx);
    const actual = await snapshot();
    assert.equal(actual.state, "idle");
    assert.equal(actual.qualified, true);
    assert.equal((await snapshot("forged-session")).state, "unknown");
    session.reloadLifecycle.runtimeSettlement!.begin("actual-owned-execution");
    const busy = await snapshot();
    assert.equal(busy.state, "busy");
    assert.deepEqual(busy.outstandingExecutionIds, ["actual-owned-execution"]);
    await session.reloadLifecycle.runtimeSettlement!.finish("actual-owned-execution", {
      state: "not-started",
      reason: "prelaunch refusal",
    });
    const settled = await snapshot();
    const replacement = registerRuntimeSnapshot(pi, session);
    await replacement.bind(ctx);
    assert.equal(listeners.size, 2);
    const reloaded = await snapshot();
    assert.equal(reloaded.ownerScope, settled.ownerScope);
    assert.equal(reloaded.evidenceDigest, settled.evidenceDigest);
    session.executor.refusal = "backend unqualified";
    assert.equal((await snapshot()).qualified, false);
    assert.equal((await snapshot()).state, "unknown");
    await replacement.bind({ ...ctx, cwd: join(root, "missing") });
    assert.equal(session.reloadLifecycle.runtimeSettlement, undefined);
    assert.equal((await snapshot()).state, "unknown");
  } finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
  }
});

test("operation bridge reads owner facts and refuses a different session or cwd", async () => {
  const { createAutoModeAuthority } = await import("../src/governance/auto-mode-policy.ts");
  const { OPERATION_STATUS_EVENT } = await import("../extensions/runtime-snapshot.ts");
  const root = await tempDir("operation-bridge-"),
    prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const pi = {
    events: {
      on(name: string, fn: (value: unknown) => void) {
        const set = listeners.get(name) ?? new Set();
        set.add(fn);
        listeners.set(name, set);
        return () => set.delete(fn);
      },
      emit(name: string, value: unknown) {
        for (const fn of listeners.get(name) ?? []) fn(value);
      },
    },
  } as unknown as ExtensionAPI;
  const auto = await createAutoModeAuthority({ enabled: false, source: "default" });
  const session = {
    ownerBound: true,
    autoMode: auto,
    reloadLifecycle: { root: {} },
    executor: { kind: "process" },
    capacity: { reserved: 0 },
  } as unknown as GrantsSession;
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "actual" } } as unknown as ExtensionContext;
  const read = (sessionId = "actual", cwd = root) =>
    new Promise<any>((reply) =>
      pi.events.emit(OPERATION_STATUS_EVENT, {
        version: 1,
        requestId: "lookup",
        operationId: "review:one",
        sessionId,
        cwd,
        reply,
      }),
    );
  try {
    await registerRuntimeSnapshot(pi, session).bind(ctx);
    const claim = await auto.operations!.claim({
      operationId: "review:one",
      requestDigest: "a".repeat(64),
      executionId: "exec:actual",
      cwd: root,
      workspaceId: null,
    });
    const pending = await read();
    assert.equal(pending.qualified, true);
    assert.equal(pending.operation.state, "admitting");
    assert.equal(pending.operation.executionId, "exec:actual");
    assert.equal((await read("foreign")).qualified, false);
    assert.equal((await read("actual", "/wrong")).qualified, false);
    await claim.finish!("not-started");
    assert.equal((await read()).operation.state, "not-started");
    const replacement = registerRuntimeSnapshot(pi, session);
    await replacement.bind(ctx);
    assert.equal(listeners.get(OPERATION_STATUS_EVENT)?.size, 1);
    assert.equal((await read()).operation.executionId, "exec:actual");
  } finally {
    await auto.close();
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
  }
});
