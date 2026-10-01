import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheGraph } from "../src/products/cache-graph.ts";
import { CacheScheduler, CacheStartFailure } from "../src/products/cache-scheduler.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}
const graphLimits = {
  workspaces: 1,
  observations: 2,
  entries: 4,
  runs: 2,
  edges: 8,
  keyBytes: 64,
  output: { bytes: 4096, itemBytes: 1024, payloads: 6, deliveries: 4 },
};
const limits = {
  running: 1,
  pending: 1,
  requests: 4,
  requesters: 2,
  work: 2,
  validationMs: 30,
  completionMs: 30,
  calls: 2,
  streamBytes: 64,
  streamChunks: 8,
  replies: { bytes: 64, itemBytes: 32, payloads: 4, deliveries: 4 },
};
const result = {
  output: "done",
  startedAt: "2026-10-01T00:00:00Z",
  endedAt: "2026-10-01T00:00:01Z",
  exitCode: 0,
  signal: null,
  cancelled: false,
  timedOut: false,
  complete: true,
};
function setup(overrides: Partial<typeof limits> = {}) {
  const graph = new CacheGraph(graphLimits),
    scheduler = new CacheScheduler(graph, { ...limits, ...overrides });
  const workspace = graph.workspace("/a"),
    input = graph.observe(workspace, "f", "v");
  const actor = scheduler.attach(() => true),
    exited = deferred<void>(),
    outcome = deferred<typeof result>();
  let data!: (bytes: Buffer) => void;
  let stops = 0;
  const plan = {
    workspace,
    key: "identity",
    inputs: [input],
    parents: [],
    shareable: true,
    validate: async () => true,
    start: async (options: { onData(bytes: Buffer): void }) => {
      data = options.onData;
      return {
        exited: exited.promise,
        outcome: outcome.promise,
        stop: async () => {
          stops++;
          await exited.promise;
        },
      };
    },
  };
  const work = scheduler.prepare(plan);
  const tick = async () => {
    for (let index = 0; index < 4; index++) await new Promise<void>((ok) => setImmediate(ok));
  };
  return {
    graph,
    scheduler,
    actor,
    work,
    plan,
    tick,
    send: (bytes: Buffer) => data(bytes),
    exited,
    outcome,
    stops: () => stops,
    finish: () => {
      outcome.resolve(result);
      exited.resolve();
    },
  };
}
test("missing/replaced scheduler limit keys refuse instead of creating permanently stalled queues", () => {
  const { running, ...rest } = limits;
  for (const bad of [
    { ...rest, other: running },
    { ...limits, running: undefined },
    { ...limits, extra: 1 },
  ])
    assert.throws(() => new CacheScheduler(new CacheGraph(graphLimits), bad as typeof limits), /limits/);
});
test("late join and completed reuse replay full exact binary stream, not just future output", async () => {
  const s = setup(),
    firstChunks: Buffer[] = [],
    joinedChunks: Buffer[] = [],
    hitChunks: Buffer[] = [];
  const first = s.scheduler.createRequest(s.actor, s.work, { onData: (bytes) => firstChunks.push(bytes) });
  const a = s.scheduler.submit(first);
  await s.tick();
  s.send(Buffer.from([0xff, 0xe2]));
  const join = s.scheduler.createRequest(s.actor, s.work, { onData: (bytes) => joinedChunks.push(bytes) });
  const b = s.scheduler.submit(join);
  await s.tick();
  s.send(Buffer.from([0x82, 0xac, 0]));
  s.finish();
  await a;
  await b;
  const hit = s.scheduler.createRequest(s.actor, s.work, { onData: (bytes) => hitChunks.push(bytes) });
  assert.equal((await s.scheduler.submit(hit)).kind, "reuse");
  assert.deepEqual(joinedChunks, firstChunks);
  assert.deepEqual(hitChunks, firstChunks);
  await s.scheduler.shutdown();
});
test("outcome arrival and stop dispatch cannot release a slot before verified exit", async () => {
  const s = setup(),
    request = s.scheduler.createRequest(s.actor, s.work),
    promise = s.scheduler.submit(request);
  await s.tick();
  s.outcome.resolve(result);
  await s.tick();
  assert.equal(s.scheduler.stats().running, 1);
  s.scheduler.cancel(request);
  await promise;
  await s.tick();
  assert.equal(s.stops(), 1);
  assert.equal(s.graph.stats().runs, 1);
  s.exited.resolve();
  await s.scheduler.shutdown();
});
test("shutdown needs exit proof but not a lost outcome once all request interests are cancelled", async () => {
  const s = setup(),
    request = s.scheduler.createRequest(s.actor, s.work),
    promise = s.scheduler.submit(request);
  await s.tick();
  const shutdown = s.scheduler.shutdown();
  await promise;
  s.exited.resolve();
  await shutdown;
  assert.equal(s.scheduler.stats().running, 0);
  assert.equal(s.graph.stats().runs, 0);
});
test("start cancellation race stops late returned owned handle without starting another execution", async () => {
  const s = setup(),
    gate = deferred<void>();
  let signal: AbortSignal | undefined;
  const work = s.scheduler.prepare({
    ...s.plan,
    key: "starting",
    start: async (options) => {
      signal = options.signal;
      await gate.promise;
      return {
        exited: s.exited.promise,
        outcome: s.outcome.promise,
        stop: async () => {
          s.exited.resolve();
        },
      };
    },
  });
  const request = s.scheduler.createRequest(s.actor, work),
    promise = s.scheduler.submit(request);
  await s.tick();
  s.scheduler.cancel(request);
  assert.equal((await promise).kind, "cancelled");
  assert.equal(signal?.aborted, true);
  gate.resolve();
  await s.scheduler.shutdown();
  assert.equal(s.graph.stats().runs, 0);
});
test("only explicitly verified failed-start cleanup releases ownership; unknown cleanup faults closed", async () => {
  for (const verified of [true, false]) {
    const s = setup(),
      work = s.scheduler.prepare({
        ...s.plan,
        key: "failure",
        start: async () => {
          throw new CacheStartFailure("start failed", verified);
        },
      });
    const request = s.scheduler.createRequest(s.actor, work);
    assert.equal((await s.scheduler.submit(request)).kind, "reject");
    if (verified) {
      await s.scheduler.shutdown();
      assert.equal(s.graph.stats().runs, 0);
    } else {
      assert.equal(s.scheduler.stats().running, 1);
      assert.equal(s.graph.stats().runs, 1);
      await assert.rejects(s.scheduler.shutdown(), /unresolved/);
    }
  }
});
test("stream bytes prevent new reusable output without discarding original completion", async () => {
  const s = setup(),
    request = s.scheduler.createRequest(s.actor, s.work),
    promise = s.scheduler.submit(request);
  await s.tick();
  s.send(Buffer.alloc(65));
  s.finish();
  const response = await promise;
  assert.equal(response.outcome?.output, "done");
  assert.equal(response.published, false);
  assert.equal(s.scheduler.stats().streamBytes, 0);
  assert.equal(s.graph.stats().entries, 0);
  await s.scheduler.shutdown();
});
