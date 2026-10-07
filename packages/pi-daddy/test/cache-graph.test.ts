import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheGraph, type CacheResultRef } from "../src/products/cache-graph.ts";

const limits = {
  workspaces: 2,
  observations: 12,
  entries: 4,
  runs: 4,
  edges: 24,
  keyBytes: 128,
  output: { bytes: 128, itemBytes: 32, payloads: 8, deliveries: 4 },
};
const outcome = (id: string, output = "pass") => ({
  executionId: id,
  startedAt: "2026-10-01T00:00:00Z",
  endedAt: "2026-10-01T00:00:01Z",
  output,
});
function setup() {
  const graph = new CacheGraph(limits),
    workspace = graph.workspace("/workspace/a");
  const source = graph.observe(workspace, "file:a", "first");
  return { graph, workspace, source };
}

test("dirty blocks reuse; only current unchanged reconciliation retains original provenance", () => {
  const { graph, workspace, source } = setup();
  const run = graph.begin(workspace, "check", [source], []);
  assert.ok(run);
  const original = graph.publish(run, outcome("exec-one"));
  assert.ok(original);
  const first = graph.acquire(workspace, "check");
  assert.ok(first);
  assert.equal(first.ref, original);
  assert.equal(first.execution.executionId, "exec-one");
  first.delivery.release();
  const earlier = graph.dirty(source),
    current = graph.dirty(source);
  assert.equal(graph.acquire(workspace, "check"), undefined);
  assert.equal(graph.reconcile(earlier, "first"), false, "late reconciliation cannot clear newer event");
  assert.equal(graph.acquire(workspace, "check"), undefined);
  assert.equal(graph.reconcile(current, "first"), true);
  const reused = graph.acquire(workspace, "check");
  assert.ok(reused);
  assert.equal(reused.ref, original);
  assert.deepEqual(reused.execution, first.execution);
  reused.delivery.release();
});

test("confirmed change deletes reverse edges/results/payloads; undo never resurrects", () => {
  const { graph, workspace, source } = setup();
  const irrelevant = graph.observe(workspace, "file:other", "other");
  const one = graph.begin(workspace, "affected", [source], []),
    two = graph.begin(workspace, "unrelated", [irrelevant], []);
  assert.ok(one);
  assert.ok(two);
  assert.ok(graph.publish(one, outcome("one")));
  assert.ok(graph.publish(two, outcome("two")));
  assert.equal(graph.stats().edges, 2);
  assert.equal(graph.reconcile(graph.dirty(source), "second"), true);
  assert.equal(graph.acquire(workspace, "affected"), undefined);
  assert.equal(graph.stats().entries, 1);
  assert.equal(graph.stats().edges, 1);
  assert.equal(graph.stats().output.bytes, 4);
  assert.equal(graph.reconcile(graph.dirty(source), "first"), true);
  assert.equal(graph.acquire(workspace, "affected"), undefined);
  const hit = graph.acquire(workspace, "unrelated");
  assert.ok(hit);
  hit.delivery.release();
});

test("dirty upstream blocks descendants; confirmed loss deletes a diamond closure once", () => {
  const { graph, workspace, source } = setup();
  function publish(key: string, deps: CacheResultRef[]) {
    const run = graph.begin(workspace, key, key === "a" ? [source] : [], deps);
    assert.ok(run);
    const ref = graph.publish(run, outcome(key));
    assert.ok(ref);
    return ref;
  }
  const a = publish("a", []),
    b = publish("b", [a]),
    c = publish("c", [a]);
  publish("d", [b, c]);
  const dirty = graph.dirty(source);
  assert.equal(graph.acquire(workspace, "d"), undefined);
  assert.equal(graph.stats().entries, 4);
  graph.reconcile(dirty, "first");
  const clean = graph.acquire(workspace, "d");
  assert.ok(clean);
  clean.delivery.release();
  graph.reconcile(graph.dirty(source), undefined);
  assert.equal(graph.stats().entries, 0);
  assert.equal(graph.stats().edges, 0);
  assert.equal(graph.stats().output.bytes, 0);
  assert.equal(graph.stats().observations, 0);
});

test("change-undo invalidates a running ticket and removes its edges without fabricating process exit", () => {
  const { graph, workspace, source } = setup();
  const run = graph.begin(workspace, "check", [source], []);
  assert.ok(run);
  graph.reconcile(graph.dirty(source), "second");
  graph.reconcile(graph.dirty(source), "first");
  assert.equal(graph.canJoin(run), false);
  assert.equal(graph.stats().runs, 1);
  assert.equal(graph.stats().edges, 0);
  assert.equal(graph.publish(run, outcome("old")), undefined);
  assert.equal(graph.stats().runs, 0);
  assert.equal(graph.acquire(workspace, "check"), undefined);
});

test("a superseded completion cannot replace a newer result, and execution incarnations are dependencies", () => {
  const { graph, workspace, source } = setup();
  const old = graph.begin(workspace, "check", [source], []);
  assert.ok(old);
  const newer = graph.begin(workspace, "check", [source], []);
  assert.ok(newer);
  const latest = graph.publish(newer, outcome("newer"));
  assert.ok(latest);
  assert.equal(graph.publish(old, outcome("old")), undefined);
  const dependent = graph.begin(workspace, "consumer", [], [latest]);
  assert.ok(dependent);
  graph.remove(latest);
  const rerun = graph.begin(workspace, "check", [source], []);
  assert.ok(rerun);
  assert.ok(graph.publish(rerun, outcome("replacement")));
  assert.equal(graph.publish(dependent, outcome("obsolete-consumer")), undefined);
  const hit = graph.acquire(workspace, "check");
  assert.ok(hit);
  assert.equal(hit.execution.executionId, "replacement");
  hit.delivery.release();
});

test("invalidation preserves already pinned delivery but not new access; pins remain charged", () => {
  const graph = new CacheGraph({ ...limits, output: { ...limits.output, bytes: 4, itemBytes: 4 } });
  const workspace = graph.workspace("/a"),
    source = graph.observe(workspace, "file", "first");
  const run = graph.begin(workspace, "check", [source], []);
  assert.ok(run);
  assert.ok(graph.publish(run, outcome("one")));
  const hit = graph.acquire(workspace, "check");
  assert.ok(hit);
  graph.remove(hit.ref);
  assert.equal(graph.acquire(workspace, "check"), undefined);
  assert.equal(hit.delivery.read(), "pass");
  assert.equal(graph.stats().entries, 0);
  assert.equal(graph.stats().edges, 0);
  assert.equal(graph.stats().output.bytes, 4);
  const next = graph.begin(workspace, "check", [source], []);
  assert.ok(next);
  assert.equal(graph.publish(next, outcome("two")), undefined, "pinned invalid bytes cause controlled storage refusal");
  hit.delivery.release();
  assert.equal(graph.stats().output.bytes, 0);
});

test("workspace/root object identities isolate equal strings, and foreign references refuse", () => {
  const { graph, workspace, source } = setup();
  const other = graph.workspace("/workspace/b");
  const run = graph.begin(workspace, "check", [source], []);
  assert.ok(run);
  const ref = graph.publish(run, outcome("one"));
  assert.ok(ref);
  assert.equal(graph.acquire(other, "check"), undefined);
  assert.throws(() => graph.begin(other, "check", [source], []), /workspace/);
  const foreign = new CacheGraph(limits);
  assert.throws(() => foreign.acquire(workspace, "check"), /foreign/);
  assert.throws(() => foreign.remove(ref), /foreign/);
  assert.throws(() => graph.begin(other, "consumer", [], [ref]), /workspace/);
});

test("admission bounds and oversized publication do not partially mutate runtime state", () => {
  const graph = new CacheGraph({ ...limits, entries: 1, runs: 1, edges: 1, observations: 1, workspaces: 1 });
  const workspace = graph.workspace("/a"),
    source = graph.observe(workspace, "file", "one");
  assert.throws(() => graph.workspace("/b"), /limit/);
  assert.throws(() => graph.observe(workspace, "other", "x"), /limit/);
  assert.throws(() => graph.observe(workspace, "x".repeat(129), "x"), /limit/);
  const run = graph.begin(workspace, "one", [source], []);
  assert.ok(run);
  assert.equal(graph.begin(workspace, "two", [source], []), undefined);
  assert.equal(graph.publish(run, outcome("bad", "x".repeat(33))), undefined);
  assert.equal(graph.stats().edges, 0);
  assert.equal(graph.stats().runs, 0);
  assert.equal(graph.stats().entries, 0);
  const again = graph.begin(workspace, "one", [source], []);
  assert.ok(again);
  assert.ok(graph.publish(again, outcome("good")));
  const next = graph.begin(workspace, "two", [], []);
  assert.ok(next);
  assert.ok(graph.publish(next, outcome("second")));
  assert.equal(graph.acquire(workspace, "one"), undefined, "entry-count bound evicts an older valid entry");
  assert.equal(graph.stats().entries, 1);
  assert.equal(graph.stats().edges, 0);
});

test("clear removes state, abandonment is idempotent, and handles cannot publish after clear", () => {
  const { graph, workspace, source } = setup();
  const run = graph.begin(workspace, "check", [source], []);
  assert.ok(run);
  graph.clear(workspace);
  assert.equal(graph.stats().runs, 1, "clear cannot fabricate supervisor completion");
  assert.equal(graph.stats().edges, 0);
  graph.abandon(run);
  graph.abandon(run);
  assert.equal(graph.publish(run, outcome("late")), undefined);
  assert.equal(graph.canJoin(run), false);
  assert.deepEqual(graph.stats(), {
    workspaces: 1,
    observations: 0,
    entries: 0,
    runs: 0,
    edges: 0,
    output: { bytes: 0, payloads: 0, deliveries: 0 },
  });
});
