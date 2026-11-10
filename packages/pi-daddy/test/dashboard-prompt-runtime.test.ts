import assert from "node:assert/strict";
import { after, test } from "node:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { registerRuntimeSnapshot } from "../extensions/runtime-snapshot.ts";
import type { GrantsSession } from "../extensions/session.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);

test("runtime rebinding and reload keep one current native prompt listener and balance Herdr waits", async () => {
  const root = await tempDir("dashboard-prompt-bind-");
  const alias = join(await tempDir("dashboard-prompt-alias-"), "workspace");
  await symlink(root, alias);
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const hooks = new Map<string, Set<(...args: any[]) => void>>();
  const events = new Map<string, Set<(...args: any[]) => void>>();
  const signals: boolean[] = [];
  const subscribe = (map: typeof hooks, name: string, fn: (...args: any[]) => void) => {
    const listeners = map.get(name) ?? new Set();
    listeners.add(fn);
    map.set(name, listeners);
    return () => listeners.delete(fn);
  };
  const pi = {
    on: (name: string, fn: (...args: any[]) => void) => subscribe(hooks, name, fn),
    events: {
      on: (name: string, fn: (...args: any[]) => void) => subscribe(events, name, fn),
      emit(name: string, value: any) {
        if (name === "herdr:blocked") signals.push(value.active);
        for (const fn of events.get(name) ?? []) fn(value);
      },
    },
  };
  const session = {
    reloadLifecycle: { root: {} },
    executor: { kind: "process" },
    capacity: { reserved: 0 },
  } as unknown as GrantsSession;
  const context = (id: string) => ({
    hasUI: true,
    mode: "tui",
    cwd: alias,
    sessionManager: { getSessionId: () => id },
  });
  const emit = (type: string, ctx: ReturnType<typeof context>) => {
    for (const fn of hooks.get(type) ?? []) fn({ reason: "ui_prompt", kind: "select", title: "Choose a day" }, ctx);
  };
  try {
    let runtime = registerRuntimeSnapshot(pi as never, session);
    for (let n = 0; n < 3; n++) {
      const ctx = context("session-" + n);
      await runtime.bind(ctx as never);
      assert.equal(hooks.get("ui_prompt_start")?.size, 1);
      assert.equal(hooks.get("ui_prompt_end")?.size, 1);
      assert.equal(session.dashboardPrompt?.(), undefined);
      emit("ui_prompt_start", ctx);
      assert.equal(
        session.dashboardPrompt?.()?.label,
        "Choose a day",
        "canonical binding accepts same symlinked folder",
      );
      emit("ui_prompt_end", context("old-session"));
      assert.ok(session.dashboardPrompt?.(), "old session cannot clear a current wait");
      // /new binds a new owner; /reload replaces the whole registration.
      if (n === 1) runtime = registerRuntimeSnapshot(pi as never, session);
    }
    assert.deepEqual(signals, [true, false, true, false, true]);
    session.reloadLifecycle.runtimeSnapshotUnsubscribe?.();
    assert.equal(session.dashboardPrompt?.(), undefined);
    assert.equal(hooks.get("ui_prompt_start")?.size, 0);
    assert.equal(hooks.get("ui_prompt_end")?.size, 0);
    assert.deepEqual(signals, [true, false, true, false, true, false]);
  } finally {
    session.reloadLifecycle.runtimeSnapshotUnsubscribe?.();
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
  }
});
