import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheGraph, type CacheRunTicket } from "../src/products/cache-graph.ts";
const outcome = (executionId: string) => ({
  executionId,
  startedAt: "2026-10-01T00:00:00Z",
  endedAt: "2026-10-01T00:00:01Z",
  output: "pass",
});
const limits = {
  workspaces: 1,
  observations: 1,
  entries: 2,
  runs: 1,
  edges: 2,
  keyBytes: 64,
  output: { bytes: 24, itemBytes: 8, payloads: 3, deliveries: 1 },
};

test("large fan-out removal and replacement cannot exceed JS argument limits or corrupt ownership", () => {
  const fanout = 150_000;
  for (const replace of [false, true]) {
    const graph = new CacheGraph({ ...limits, runs: fanout + 1, edges: fanout + 1 });
    const workspace = graph.workspace("/a"),
      parent = graph.begin(workspace, "parent", [], []);
    assert.ok(parent);
    const ref = graph.publish(parent, outcome("original"));
    assert.ok(ref);
    const tickets: CacheRunTicket[] = [];
    for (let index = 0; index < fanout; index++) {
      const run = graph.begin(workspace, `dependent-${index}`, [], [ref]);
      assert.ok(run);
      tickets.push(run);
    }
    if (replace) {
      const run = graph.begin(workspace, "parent", [], []);
      assert.ok(run);
      assert.ok(graph.publish(run, outcome("replacement")));
    } else graph.remove(ref);
    assert.equal(graph.stats().edges, 0);
    assert.equal(graph.stats().runs, fanout);
    assert.equal(graph.stats().entries, replace ? 1 : 0);
    assert.equal(graph.stats().output.bytes, replace ? 4 : 0);
    assert.equal(graph.canJoin(tickets[0]), false);
    graph.clear();
    assert.equal(graph.stats().runs, fanout, "cache deletion is not actual command termination");
    assert.equal(graph.stats().entries, 0);
    assert.equal(graph.stats().output.bytes, 0);
    for (const run of tickets) graph.abandon(run);
    assert.equal(graph.stats().runs, 0);
    assert.equal(graph.stats().edges, 0);
  }
});

test("repeated workspace/global clears retain charged run slots until supervisor reports an outcome", () => {
  for (const complete of [false, true]) {
    const graph = new CacheGraph(limits),
      workspace = graph.workspace("/a");
    const old = graph.begin(workspace, "old", [], []);
    assert.ok(old);
    graph.clear(workspace);
    graph.clear();
    graph.clear(workspace);
    assert.equal(graph.stats().runs, 1);
    assert.equal(graph.canJoin(old), false);
    assert.equal(
      graph.begin(workspace, "new", [], []),
      undefined,
      "no new run while old execution still owns capacity",
    );
    if (complete) assert.equal(graph.publish(old, outcome("late")), undefined);
    else graph.abandon(old);
    assert.equal(graph.stats().runs, 0);
    assert.ok(graph.begin(workspace, "new", [], []));
  }
});
