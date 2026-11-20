import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDashboardSources } from "../extensions/dashboard-sources.ts";
import { DASHBOARD_SOURCE_EVENT } from "../src/kernel/dashboard-observation.ts";
import { currentTaskItem } from "../src/products/dashboard-components.ts";

test("selected task observations are scoped, explicitly partial, replaced on task switch and cleared on omission or close", () => {
  const events = new Map<string, (arg: any) => void>();
  const pi = {
    events: {
      on: (k: string, fn: (arg: any) => void) => {
        events.set(k, fn);
        return () => events.delete(k);
      },
    },
  };
  const owner = { cwd: "/work", sessionId: "s" };
  let now = 10000;
  const sources = registerDashboardSources(
    pi as never,
    () => owner,
    () => now,
  );
  function register(producer: string, modern: boolean) {
    let receiver: any;
    events.get(DASHBOARD_SOURCE_EVENT)!({
      version: 1,
      ...owner,
      producer,
      producerVersion: "1.0",
      ...(modern ? { capabilities: { taskHistory: 1 } } : {}),
      reply: (r: any) => (receiver = r),
    });
    return receiver;
  }
  const record = {
    taskId: "ticket",
    title: "Ticket",
    observations: 1,
    lastObservation: {
      owner: "pi-daddy",
      state: "settled",
      label: "Child settled",
      recordedAt: new Date(now).toISOString(),
    },
  };
  const update = { sequence: 1, items: [], taskHistory: record };
  const legacy = register("bookie-memory", false);
  assert.equal(legacy.publish(update), false);
  const other = register("principal", true);
  assert.equal(other.publish(update), false);
  const current = register("bookie-memory", true);
  assert.equal(current.capabilities.taskHistory, 1);
  assert.equal(current.publish(update), true);
  const selection = () =>
    currentTaskItem({ session: { observation: sources.snapshot() }, connected: true, now: new Date(now) } as never);
  assert.equal(selection()?.label, "Ticket");
  assert.match(selection()!.details.join(" "), /coverage is partial/);
  assert.equal(current.publish({ ...update, sequence: 2, taskHistory: { ...record, secret: "extra" } }), false);
  assert.equal(selection()?.label, "Ticket");
  assert.equal(current.publish({ sequence: 2, items: [] }), true);
  assert.equal(selection(), undefined);
  current.publish({ sequence: 3, items: [], taskHistory: { taskId: "two", title: "New task", observations: 0 } });
  assert.equal(selection()?.label, "New task");
  now += 130000;
  assert.equal(selection(), undefined);
  current.close();
  assert.equal(selection(), undefined);
});
