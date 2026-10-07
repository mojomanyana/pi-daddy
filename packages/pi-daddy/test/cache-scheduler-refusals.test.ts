import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheGraph } from "../src/products/cache-graph.ts";
import { CacheScheduler } from "../src/products/cache-scheduler.ts";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}
test("terminal pre-execution refusals can be acknowledged without leaking logical admission", async () => {
  const graph = new CacheGraph({
    workspaces: 1,
    observations: 1,
    entries: 1,
    runs: 1,
    edges: 2,
    keyBytes: 128,
    output: { bytes: 1024, itemBytes: 512, payloads: 2, deliveries: 2 },
  });
  const scheduler = new CacheScheduler(graph, {
    running: 1,
    pending: 1,
    requests: 2,
    requesters: 2,
    work: 1,
    validationMs: 30000,
    completionMs: 100,
    calls: 1,
    streamBytes: 64,
    streamChunks: 4,
    replies: { bytes: 64, itemBytes: 32, payloads: 2, deliveries: 2 },
  });
  const scope = graph.workspace("/a"),
    input = graph.observe(scope, "f", "v");
  const validate = deferred<boolean>();
  let starts = 0;
  const work = scheduler.prepare({
    workspace: scope,
    key: "x",
    inputs: [input],
    parents: [],
    shareable: true,
    validate: async () => validate.promise,
    start: async () => {
      starts++;
      throw Error("must not start");
    },
  });
  const denied = scheduler.attach(() => false),
    allowed = scheduler.attach(() => true);
  try {
    for (let n = 0; n < 6; n++) {
      const token = scheduler.createRequest(denied, work);
      assert.equal((await scheduler.submit(token)).kind, "reject");
      assert.doesNotThrow(() => scheduler.acknowledge(token));
      assert.equal(scheduler.stats().requests, 0);
    }
    const first = scheduler.createRequest(allowed, work),
      promise = scheduler.submit(first);
    const second = scheduler.createRequest(allowed, work);
    assert.equal((await scheduler.submit(second)).kind, "reject");
    assert.doesNotThrow(() => scheduler.acknowledge(second));
    assert.equal(scheduler.stats().requests, 1);
    scheduler.cancel(first);
    await promise;
    scheduler.acknowledge(first);
    assert.equal(scheduler.stats().requests, 0);
    assert.equal(starts, 0);
  } finally {
    validate.resolve(false);
    await scheduler.shutdown();
  }
});
