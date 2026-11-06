import assert from "node:assert/strict";
import { test } from "node:test";
import { registerDashboardSources } from "../extensions/dashboard-sources.ts";
import { registerDashboardLive } from "../extensions/dashboard-live.ts";
import { DASHBOARD_SOURCE_EVENT, validDashboardSourceUpdate } from "../src/kernel/dashboard-observation.ts";
const item = {
  id: "one",
  kind: "review",
  label: "Exact result review",
  state: "observed",
  details: ["Scope only; not authorization"],
};
test("optional source observations bind owner and replacement generation, reject replay and remain bounded", () => {
  const events = new Map<string, (x: any) => void>();
  const pi = {
    events: {
      on(name: string, fn: any) {
        events.set(name, fn);
        return () => events.delete(name);
      },
    },
  };
  let owner = { sessionId: "session", cwd: "/work" },
    now = 10_000;
  const sources = registerDashboardSources(
    pi as never,
    () => owner,
    () => now,
  );
  const register = (args: any = {}) => {
    let reply: any;
    events.get(DASHBOARD_SOURCE_EVENT)!({
      version: 1,
      ...owner,
      producer: "principal",
      producerVersion: "1.0",
      ...args,
      reply: (x: any) => (reply = x),
    });
    return reply;
  };
  assert.equal(register({ sessionId: "other" }).ok, false);
  const first = register();
  assert.equal(first.publish({ sequence: 1, items: [item] }), true);
  assert.equal(first.publish({ sequence: 1, items: [{ ...item, label: "replayed" }] }), false);
  assert.equal(first.publish({ sequence: 0, items: [item] }), false);
  assert.equal(first.publish({ sequence: 2, items: [{ ...item, action: "run-shell" }] }), false);
  assert.equal(first.publish({ sequence: 2, items: Array(9).fill(item) }), false);
  const observed = sources.snapshot()!;
  assert.equal(observed.sources[0].items[0].label, item.label);
  now += 1000;
  const replacement = register();
  assert.notEqual(first.generation, replacement.generation);
  assert.equal(first.publish({ sequence: 99, items: [item] }), false);
  assert.equal(replacement.publish({ sequence: 0, items: [item] }), true);
  replacement.close();
  assert.equal(replacement.publish({ sequence: 1, items: [item] }), false);
  assert.equal(sources.snapshot()!.sources[0].availability, "closed");
  for (let n = 0; n < 7; n++) assert.equal(register({ producer: `source-${n}` }).ok, true);
  assert.equal(register({ producer: "overflow" }).ok, false);
  owner = { ...owner }; // new native owner binding invalidates all prior in-process handles even same labels
  assert.equal(sources.snapshot()!.sources.length, 0);
  assert.equal(replacement.publish({ sequence: 2, items: [item] }), false);
  sources.close();
  assert.equal(events.size, 0);
  assert.equal(validDashboardSourceUpdate({ sequence: 0, items: [{ ...item, label: "x".repeat(241) }] }), false);
});
test("ordinary activity remains bounded metadata when capture is off and old owners cannot leak into a new session", () => {
  const hooks = new Map<string, (event: any, ctx: any) => void>();
  let owner = { sessionId: "session", cwd: "/work" };
  const view = registerDashboardLive(
    {
      on(name: string, fn: any) {
        hooks.set(name, fn);
      },
    } as never,
    () => owner,
  );
  const ctx = { sessionManager: { getSessionId: () => "session" }, model: { provider: "fixture", id: "local" } };
  hooks.get("agent_start")!({}, ctx);
  for (let n = 0; n < 60; n++)
    hooks.get("tool_execution_start")!({ toolName: "read", args: "PRIVATE INPUT", result: "PRIVATE OUTPUT" }, ctx);
  const live = view();
  assert.equal(live.turn?.state, "running");
  assert.equal(live.activity.length, 32);
  assert.doesNotMatch(JSON.stringify(live), /PRIVATE/);
  hooks.get("agent_end")!({}, ctx);
  assert.equal(view().turn?.state, "settled");
  owner = { sessionId: "new", cwd: "/other" };
  hooks.get("tool_execution_end")!({ toolName: "old" }, ctx);
  assert.deepEqual(view(), { activity: [] });
});

test("dashboard owner snapshots exclude internal private and circular lifecycle state", () => {
  const lifecycle: { token: string; self?: unknown } = { token: "PRIVATE OWNER TOKEN" };
  lifecycle.self = lifecycle;
  const owner = { sessionId: "session", cwd: "/work", lifecycle, privateHint: "PRIVATE OWNER HINT" };
  const sources = registerDashboardSources(
    { events: { on: () => () => {} } } as never,
    () => owner,
    () => 10_000,
  );
  const snapshot = sources.snapshot()!;
  let encoded = "";
  assert.doesNotThrow(() => {
    encoded = JSON.stringify(snapshot);
  });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "cwd",
    "generation",
    "observedAt",
    "sequence",
    "sessionId",
    "sources",
  ]);
  assert.equal(snapshot.sessionId, owner.sessionId);
  assert.equal(snapshot.cwd, owner.cwd);
  assert.equal(snapshot.sequence, 1);
  assert.doesNotMatch(encoded, /PRIVATE|lifecycle|privateHint/);
  assert.equal(sources.snapshot()!.sequence, 2);
  sources.close();
  assert.equal(sources.snapshot(), undefined);
});
