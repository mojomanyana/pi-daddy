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
const outcome = {
  output: "ok",
  startedAt: "2026-10-01T00:00:00Z",
  endedAt: "2026-10-01T00:00:01Z",
  exitCode: 0,
  signal: null,
  cancelled: false,
  timedOut: false,
  complete: true,
};
function setup() {
  const graph = new CacheGraph({
    workspaces: 1,
    observations: 1,
    entries: 4,
    runs: 4,
    edges: 4,
    keyBytes: 128,
    output: { bytes: 4096, itemBytes: 1024, payloads: 4, deliveries: 4 },
  });
  const scheduler = new CacheScheduler(graph, {
    running: 1,
    pending: 2,
    requests: 4,
    requesters: 2,
    work: 4,
    validationMs: 100,
    completionMs: 30000,
    calls: 4,
    streamBytes: 64,
    streamChunks: 4,
    replies: { bytes: 1024, itemBytes: 128, payloads: 4, deliveries: 4 },
  });
  const workspace = graph.workspace("/a"),
    input = graph.observe(workspace, "f", "v"),
    actor = scheduler.attach(() => true);
  const base = { workspace, key: "one", inputs: [input], parents: [], shareable: true, validate: async () => true };
  const tick = async () => {
    for (let i = 0; i < 5; i++) await new Promise<void>((ok) => setImmediate(ok));
  };
  return { graph, scheduler, actor, base, tick };
}
test("successful verified exit never calls physical stop or faults the next independent request", async () => {
  const s = setup();
  let stops = 0;
  const work = s.scheduler.prepare({
    ...s.base,
    start: async () => ({
      outcome: Promise.resolve(outcome),
      exited: Promise.resolve(),
      stop: () => {
        stops++;
        throw Error("unnecessary stop");
      },
    }),
  });
  const reply = await s.scheduler.submit(s.scheduler.createRequest(s.actor, work));
  await s.tick();
  assert.equal(reply.kind, "execute");
  assert.equal(reply.published, true);
  assert.equal(stops, 0);
  assert.equal(s.scheduler.failure, undefined);
  const next = await s.scheduler.submit(s.scheduler.createRequest(s.actor, work));
  assert.equal(next.kind, "reuse");
  await s.scheduler.shutdown();
});
test("actual exit releases occupancy BEFORE outcome settles or its distant completion timer expires", async () => {
  const s = setup(),
    report = deferred<typeof outcome>();
  let secondStarted = false;
  const work = s.scheduler.prepare({
    ...s.base,
    start: async () => ({ outcome: report.promise, exited: Promise.resolve(), stop: async () => {} }),
  });
  const reply = s.scheduler.submit(s.scheduler.createRequest(s.actor, work));
  await s.tick();
  try {
    assert.equal(s.scheduler.stats().running, 0);
    assert.equal(s.scheduler.stats().finalizing, 1);
    const next = s.scheduler.prepare({
      ...s.base,
      key: "two",
      start: async () => {
        secondStarted = true;
        return { outcome: Promise.resolve(outcome), exited: Promise.resolve(), stop: async () => {} };
      },
    });
    const nextReply = s.scheduler.submit(s.scheduler.createRequest(s.actor, next));
    await s.tick();
    assert.equal(secondStarted, true);
    report.resolve(outcome);
    await reply;
    await nextReply;
  } finally {
    report.resolve(outcome);
    await s.scheduler.shutdown();
  }
});
