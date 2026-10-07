import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheGraph } from "../src/products/cache-graph.ts";
import { CacheScheduler } from "../src/products/cache-scheduler.ts";
function setup() {
  const output = { bytes: 4096, itemBytes: 2048, payloads: 8, deliveries: 8 };
  const graph = new CacheGraph({
    workspaces: 1,
    observations: 8,
    entries: 8,
    runs: 8,
    edges: 16,
    keyBytes: 128,
    output,
  });
  const scheduler = new CacheScheduler(graph, {
    running: 1,
    pending: 8,
    requests: 8,
    requesters: 1,
    work: 1,
    validationMs: 100,
    completionMs: 100,
    calls: 8,
    streamBytes: 1024,
    streamChunks: 8,
    replies: output,
  });
  return { graph, scheduler, workspace: graph.workspace("/workspace") };
}
test("observed input events retire running tickets without deleting reconciled unchanged results", () => {
  const { graph, workspace } = setup(),
    input = graph.observe(workspace, "input", "one");
  const completed = graph.begin(workspace, "cached", [input], [])!;
  graph.publish(completed, {
    executionId: "first",
    startedAt: "2026-10-05T00:00:00Z",
    endedAt: "2026-10-05T00:00:01Z",
    output: "original",
  });
  const running = graph.begin(workspace, "running", [input], [])!;
  graph.invalidateRuns(input);
  const dirty = graph.dirty(input);
  assert.equal(graph.canJoin(running), false);
  graph.reconcile(dirty, "one");
  assert.equal(
    graph.publish(running, {
      executionId: "second",
      startedAt: "2026-10-05T00:00:00Z",
      endedAt: "2026-10-05T00:00:01Z",
      output: "must not publish",
    }),
    undefined,
  );
  const hit = graph.acquire(workspace, "cached")!;
  assert.equal(hit.delivery.read(), "original");
  hit.delivery.release();
});
test("unused preparation can be forgotten while live request preparation remains owned", async () => {
  const { graph, scheduler, workspace } = setup(),
    input = graph.observe(workspace, "input", "one");
  const plan = {
    workspace,
    key: "command",
    inputs: [input],
    parents: [],
    shareable: true,
    validate: async () => false,
    start: async () => {
      throw Error("must not start");
    },
  };
  const work = scheduler.prepare(plan),
    actor = scheduler.attach(() => true),
    request = scheduler.createRequest(actor, work);
  assert.equal(scheduler.forget(work), false);
  assert.equal((await scheduler.submit(request)).kind, "bypass");
  scheduler.acknowledge(request);
  assert.equal(scheduler.forget(work), true);
  assert.equal(scheduler.stats().prepared, 0);
  assert.ok(scheduler.prepare(plan));
  await scheduler.shutdown();
});
