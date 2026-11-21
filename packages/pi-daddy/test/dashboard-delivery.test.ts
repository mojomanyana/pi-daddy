import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { registerDashboardLive } from "../extensions/dashboard-live.ts";
import { registerDashboardSources } from "../extensions/dashboard-sources.ts";
import type { DashboardTaskDelivery } from "../src/kernel/dashboard-delivery.ts";
import { DASHBOARD_SOURCE_EVENT, type DashboardSourceRegistrationReply } from "../src/kernel/dashboard-observation.ts";
import { currentTaskItem } from "../src/products/dashboard-components.ts";
import { sessionDashboardItems } from "../src/products/dashboard-panels.ts";
import {
  dashboardScreenState,
  renderDashboardScreen,
  type DashboardScreenOptions,
} from "../src/products/dashboard-screen.ts";

function fixture() {
  let owner = { cwd: "/project", sessionId: "pi-one" };
  let now = Date.parse("2026-11-21T15:00:00.000Z");
  const events = new EventEmitter();
  const hooks = new EventEmitter();
  const pi = { events, on: hooks.on.bind(hooks) } as never;
  const live = registerDashboardLive(
    pi,
    () => owner,
    () => sources.selectedTaskId(),
  );
  const sources = registerDashboardSources(
    pi,
    () => owner,
    () => now,
    live.turnId,
  );
  return {
    sources,
    replaceOwner() {
      owner = { ...owner, sessionId: "pi-two" };
    },
    advance(milliseconds: number) {
      now += milliseconds;
    },
    emit(name: string, event: unknown = {}) {
      hooks.emit(name, event, { sessionManager: { getSessionId: () => owner.sessionId } });
    },
    register(producer: string, capabilities?: Record<string, number>, sessionId = owner.sessionId) {
      let received: DashboardSourceRegistrationReply | undefined;
      events.emit(DASHBOARD_SOURCE_EVENT, {
        version: 1,
        ...owner,
        sessionId,
        producer,
        producerVersion: "fixture",
        capabilities,
        reply: (reply: DashboardSourceRegistrationReply) => (received = reply),
      });
      assert.ok(received?.ok);
      return received;
    },
    options(width = 110, height = 32): DashboardScreenOptions {
      const screen = dashboardScreenState();
      screen.destination = "work";
      return {
        width,
        height,
        screen,
        items: [],
        connected: true,
        now: new Date(now),
        session: {
          auto: { enabled: false, source: "session" },
          rows: [],
          cost: null,
          pendingApprovals: [],
          observation: {
            version: 1,
            ...sources.snapshot()!,
            ...live(),
            resources: {
              scope: "owner-process",
              sampledAt: new Date(now).toISOString(),
              rssBytes: 1,
              hostHealth: "unknown",
            },
            capture: { diagnostics: false, transcripts: false },
          },
        },
      };
    },
  };
}

const open: DashboardTaskDelivery = {
  deliveryId: "delivery-one",
  revision: 2,
  state: "open",
  outcome: "Export the weekly report",
  outstanding: "Summary file missing",
  nextAction: "Write the summary file",
  evidence: ["Export receipt abc"],
};

test("a current report exposes the gap and next action while keeping evidence in task details", () => {
  const f = fixture();
  const producer = f.register("principal-delivery", { taskDelivery: 1 });
  assert.equal(producer.capabilities?.taskDelivery, 1);
  f.emit("agent_start");
  f.emit("tool_execution_start", { toolName: "bash", toolCallId: "setup" });
  f.emit("tool_execution_end", { toolName: "bash", toolCallId: "setup", isError: true });
  assert.equal(producer.publish({ sequence: 1, items: [], taskDelivery: open }), true);
  f.emit("tool_execution_start", { toolName: "write", toolCallId: "export" });
  f.emit("tool_execution_end", { toolName: "write", toolCallId: "export", isError: false });
  f.emit("agent_end");
  assert.equal(
    producer.publish({ sequence: 2, items: [], taskDelivery: { ...open, state: "partial", handoff: "fallback" } }),
    true,
  );
  // An unrelated turn can finish ordinary work without adding evidence to the prior delivery.
  f.emit("agent_start");
  f.emit("tool_execution_start", { toolName: "edit", toolCallId: "later" });
  f.emit("tool_execution_end", { toolName: "edit", toolCallId: "later", isError: false });
  f.emit("agent_end");
  for (const [width, height] of [
    [40, 18],
    [110, 32],
  ]) {
    const options = f.options(width, height);
    const frame = renderDashboardScreen(options);
    assert.match(frame, /Partial delivery · Export the weekly/);
    assert.match(frame, /Outstanding · Summary file missing/);
    assert.match(frame, /Next · Write the summary file/);
    assert.doesNotMatch(frame, /Export receipt abc/);
    assert.ok(sessionDashboardItems(options).some((item) => item.status === "turn-ended"));
    const task = currentTaskItem(options)!;
    assert.match(task.briefDetails!.join("\n"), /Fallback handoff recorded in Pi./);
    assert.match(task.briefDetails!.join("\n"), /Export receipt abc/);
    assert.match(task.briefDetails!.join("\n"), /Write a file · finished/);
    assert.match(task.briefDetails!.join("\n"), /Run a shell command · failed/);
    assert.doesNotMatch(task.briefDetails!.join("\n"), /Edit a file/);
    options.screen.selectedKey = task.key;
    options.screen.view = "details";
    assert.match(renderDashboardScreen(options), /Export receipt abc/);
  }
  f.emit("agent_start");
  assert.equal(
    producer.publish({
      sequence: 3,
      items: [],
      taskDelivery: {
        deliveryId: open.deliveryId,
        revision: 3,
        outcome: open.outcome,
        state: "verified",
        handoff: "assistant",
      },
    }),
    true,
  );
  assert.match(renderDashboardScreen(f.options()), /Delivery verified · Export the weekly report/);
  assert.doesNotMatch(renderDashboardScreen(f.options()), /Summary file missing/);
});

test("a selected task never inherits another task’s report and optional peers remain compatible", () => {
  const f = fixture();
  const bookie = f.register("bookie-memory", { taskHistory: 1 });
  assert.equal(
    bookie.publish({
      sequence: 1,
      items: [],
      taskHistory: { taskId: "selected", title: "Current ticket", observations: 0 },
    }),
    true,
  );
  const legacy = f.register("principal");
  assert.equal(legacy.publish({ sequence: 1, items: [], taskDelivery: open }), false);
  assert.equal(legacy.publish({ sequence: 1, items: [] }), true);
  assert.equal(currentTaskItem(f.options())?.label, "Current ticket");

  const producer = f.register("principal-delivery", { taskDelivery: 1 });
  const selected = { ...open, taskId: "selected" };
  f.emit("agent_start");
  f.emit("tool_execution_start", { toolName: "write", toolCallId: "previous-task" });
  assert.equal(producer.publish({ sequence: 1, items: [], taskDelivery: open }), true);
  assert.equal(currentTaskItem(f.options())?.label, "Current ticket");
  assert.equal(producer.publish({ sequence: 2, items: [], taskDelivery: selected }), true);
  assert.equal(currentTaskItem(f.options())?.label, "Delivery open · Export the weekly report");
  assert.equal(producer.publish({ sequence: 3, items: [], taskDelivery: { ...selected, revision: 1 } }), false);
  assert.equal(
    producer.publish({ sequence: 3, items: [], taskDelivery: { ...selected, evidence: ["x".repeat(241)] } }),
    false,
  );
  assert.equal(
    bookie.publish({
      sequence: 2,
      items: [],
      taskHistory: { taskId: "next", title: "Different ticket", observations: 0 },
    }),
    true,
  );
  assert.equal(currentTaskItem(f.options())?.label, "Different ticket");
  f.emit("tool_execution_end", { toolName: "write", toolCallId: "previous-task", isError: true });
  f.emit("tool_execution_start", { toolName: "read", toolCallId: "new-task" });
  f.emit("tool_execution_end", { toolName: "read", toolCallId: "new-task" });
  assert.equal(
    producer.publish({ sequence: 3, items: [], taskDelivery: { ...open, deliveryId: "second", taskId: "next" } }),
    true,
  );
  const nextActions = currentTaskItem(f.options())?.briefDetails?.join("\n") ?? "";
  assert.match(nextActions, /Read a project file · finished/);
  assert.doesNotMatch(nextActions, /Write a file/);
  bookie.close();
  assert.equal(currentTaskItem(f.options()), undefined);
  assert.equal(producer.publish({ sequence: 4, items: [], taskDelivery: { ...open, deliveryId: "standalone" } }), true);
  assert.ok(currentTaskItem(f.options()));
  const disconnected = f.options();
  disconnected.connected = false;
  assert.equal(currentTaskItem(disconnected), undefined);
  f.advance(120_001);
  assert.equal(currentTaskItem(f.options()), undefined);
  assert.equal(producer.publish({ sequence: 5, items: [], taskDelivery: { ...open, deliveryId: "standalone" } }), true);
  const successor = f.register("principal-delivery", { taskDelivery: 1 });
  assert.equal(producer.publish({ sequence: 6, items: [], taskDelivery: open }), false);
  assert.equal(successor.publish({ sequence: 0, items: [], taskDelivery: open }), true);
  f.replaceOwner();
  assert.equal(successor.publish({ sequence: 1, items: [], taskDelivery: open }), false);
  assert.deepEqual(f.sources.snapshot()?.sources, []);
});
