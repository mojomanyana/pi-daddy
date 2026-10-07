import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CacheGraph,
  type CacheRunTicket,
  type CacheResultRef,
  type CacheDirtyToken,
} from "../src/products/cache-graph.ts";

test("bounded deterministic operation sequences preserve ownership/index counts and never resurrect entries", () => {
  const graph = new CacheGraph({
    workspaces: 1,
    observations: 4,
    entries: 6,
    runs: 8,
    edges: 14,
    keyBytes: 64,
    output: { bytes: 1024, itemBytes: 64, payloads: 16, deliveries: 2 },
  });
  const workspace = graph.workspace("/a");
  const values = ["a", "b", "c", "d"];
  let sources = values.map((value, index) => graph.observe(workspace, `source-${index}`, value));
  const dirty: Array<CacheDirtyToken | undefined> = Array(4).fill(undefined);
  const entries = new Map<string, { source: number; ref: CacheResultRef; value: string }>();
  const runs: Array<{ ticket: CacheRunTicket; source: number; key: string; eligible: boolean; order: number }> = [];
  let seed = 12345678;
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const edges = () => entries.size + runs.filter((run) => run.eligible).length;
  for (let step = 0; step < 1200; step++) {
    const source = random(4),
      key = `check-${random(6)}`;
    switch (random(7)) {
      case 0: {
        const ticket = graph.begin(workspace, key, [sources[source]], []);
        const expected = !dirty[source] && runs.length < 8 && edges() < 14;
        assert.equal(!!ticket, expected, `begin step ${step}`);
        if (ticket) runs.push({ ticket, source, key, eligible: true, order: step });
        break;
      }
      case 1: {
        if (!runs.length) break;
        const index = random(runs.length),
          run = runs[index];
        const value = `result-${step}`;
        const ref = graph.publish(run.ticket, {
          executionId: `exec-${step}`,
          output: value,
          startedAt: "2026-10-01T00:00:00Z",
          endedAt: "2026-10-01T00:00:01Z",
        });
        runs.splice(index, 1);
        const expected = run.eligible && !dirty[run.source];
        assert.equal(!!ref, expected, `publish step ${step}`);
        if (ref) {
          entries.set(run.key, { source: run.source, ref, value });
          for (const pending of runs)
            if (pending.key === run.key && pending.order < run.order) pending.eligible = false;
        }
        break;
      }
      case 2:
        dirty[source] = graph.dirty(sources[source]);
        break;
      case 3: {
        if (!dirty[source]) break;
        const change = !!random(2);
        if (change) {
          values[source] = `version-${step}`;
          for (const [id, entry] of entries) if (entry.source === source) entries.delete(id);
          for (const run of runs) if (run.source === source) run.eligible = false;
        }
        assert.equal(graph.reconcile(dirty[source]!, values[source]), true);
        dirty[source] = undefined;
        break;
      }
      case 4: {
        const entry = entries.get(key);
        if (entry) {
          graph.remove(entry.ref);
          graph.remove(entry.ref);
          entries.delete(key);
        }
        break;
      }
      case 5: {
        if (runs.length) {
          const index = random(runs.length);
          graph.abandon(runs[index].ticket);
          runs.splice(index, 1);
        }
        break;
      }
      case 6: {
        if (random(5)) break;
        graph.clear();
        entries.clear();
        for (const run of runs) run.eligible = false;
        dirty.fill(undefined);
        sources = values.map((value, index) => graph.observe(workspace, `source-${index}`, value));
        break;
      }
    }
    for (let index = 0; index < 6; index++) {
      const key = `check-${index}`,
        expected = entries.get(key),
        hit = graph.acquire(workspace, key);
      assert.equal(!!hit, !!expected && !dirty[expected.source], `lookup step ${step} ${key}`);
      if (hit) {
        assert.equal(hit.ref, expected!.ref);
        assert.equal(hit.delivery.read(), expected!.value);
        hit.delivery.release();
      }
    }
    for (const run of runs) assert.equal(graph.canJoin(run.ticket), run.eligible && !dirty[run.source]);
    const stats = graph.stats();
    assert.equal(stats.entries, entries.size);
    assert.equal(stats.runs, runs.length);
    assert.equal(stats.edges, edges());
    assert.equal(stats.observations, 4);
    assert.equal(stats.output.payloads, entries.size);
    assert.equal(stats.output.deliveries, 0);
    assert.equal(
      stats.output.bytes,
      [...entries.values()].reduce((sum, entry) => sum + Buffer.byteLength(entry.value), 0),
    );
  }
  graph.clear();
  for (const run of runs) graph.abandon(run.ticket);
  assert.equal(graph.stats().runs, 0);
  assert.equal(graph.stats().edges, 0);
  assert.equal(graph.stats().output.bytes, 0);
});
