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
    assert.equal(listeners.size, 1);
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
