import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheGraph } from "../src/products/cache-graph.ts";
import { CacheScheduler, type CacheWorkPlan, type CacheRunOutcome } from "../src/products/cache-scheduler.ts";
const tick = async () => {
  for (let n = 0; n < 6; n++) await new Promise<void>((r) => setImmediate(r));
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const outcome: CacheRunOutcome = {
  output: "raw",
  exitCode: 0,
  signal: null,
  cancelled: false,
  timedOut: false,
  complete: true,
  startedAt: "2026-10-05T00:00:00Z",
  endedAt: "2026-10-05T00:00:01Z",
};
function setup(requesters = 2) {
  const output = { bytes: 8192, itemBytes: 4096, payloads: 8, deliveries: 8 };
  const graph = new CacheGraph({
    workspaces: 1,
    observations: 4,
    entries: 4,
    runs: 4,
    edges: 16,
    keyBytes: 128,
    output,
  });
  const scheduler = new CacheScheduler(graph, {
    running: 1,
    pending: 1,
    requests: 4,
    requesters,
    work: 2,
    validationMs: 100,
    completionMs: 100,
    calls: 4,
    streamBytes: 1024,
    streamChunks: 8,
    replies: output,
  });
  const workspace = graph.workspace("/uncached"),
    gate = deferred<void>(),
    stopGate = deferred<void>(),
    earlyExited = deferred<void>();
  let launches = 0,
    allowed = true,
    holdStop = false,
    early = false;
  const plan = {
    workspace,
    key: "same",
    inputs: [],
    parents: [],
    shareable: true,
    cacheable: false,
    validate: async () => true,
    start: async () => {
      launches++;
      const done = gate.promise.then(() => outcome);
      return {
        outcome: done,
        exited: early ? earlyExited.promise : done.then(() => {}),
        stop: async () => {
          gate.resolve();
          if (holdStop) await stopGate.promise;
        },
      };
    },
  } satisfies CacheWorkPlan;
  const actor = scheduler.attach(() => allowed),
    work = scheduler.prepare(plan);
  return {
    scheduler,
    graph,
    actor,
    work,
    plan,
    gate,
    stopGate,
    count: () => launches,
    permit: (v: boolean) => {
      allowed = v;
    },
    holdStop: () => {
      holdStop = true;
    },
    exitEarly: () => {
      early = true;
      earlyExited.resolve();
    },
  };
}
test("uncached work never joins or publishes and shares ordinary execution queue bounds", async () => {
  const s = setup(),
    first = s.scheduler.createRequest(s.actor, s.work),
    a = s.scheduler.submit(first);
  await tick();
  const second = s.scheduler.createRequest(s.actor, s.work),
    b = s.scheduler.submit(second);
  await tick();
  try {
    assert.equal(s.count(), 1);
    assert.equal(s.scheduler.stats().queued, 1, "noncacheable second request must queue, not join");
    const third = s.scheduler.createRequest(s.actor, s.work);
    assert.equal((await s.scheduler.submit(third)).kind, "reject");
  } finally {
    s.gate.resolve();
    await Promise.all([a, b]);
  }
  assert.equal(s.count(), 2);
  assert.equal((await a).published, false);
  assert.equal((await b).kind, "execute");
  const next = await s.scheduler.submit(s.scheduler.createRequest(s.actor, s.work));
  assert.equal(next.kind, "execute");
  assert.equal(next.published, false);
  assert.equal(s.count(), 3);
  await s.scheduler.shutdown();
});
test("uncached execution still checks authority and refuses malformed cacheable policy", async () => {
  const s = setup();
  try {
    assert.throws(() => s.scheduler.prepare({ ...s.plan, cacheable: "no" } as unknown as CacheWorkPlan), /malformed/);
    s.permit(false);
    assert.equal((await s.scheduler.submit(s.scheduler.createRequest(s.actor, s.work))).kind, "reject");
    assert.equal(s.count(), 0);
  } finally {
    await s.scheduler.shutdown();
  }
});
test("cancellation after verified exit still starts and joins runner cleanup", async () => {
  const s = setup();
  s.holdStop();
  s.exitEarly();
  const req = s.scheduler.createRequest(s.actor, s.work),
    result = s.scheduler.submit(req);
  await tick();
  assert.equal(s.scheduler.stats().running, 0);
  assert.equal(s.scheduler.stats().finalizing, 1);
  s.scheduler.cancel(req);
  await result;
  let settled = false;
  const drain = s.scheduler.settle(req).then(() => {
    settled = true;
  });
  await tick();
  try {
    assert.equal(settled, false, "verified tree death cannot skip stop resource cleanup");
    assert.equal(s.scheduler.stats().pendingStops, 1);
  } finally {
    s.gate.resolve();
    s.stopGate.resolve();
    await drain;
    await s.scheduler.shutdown();
  }
});
test("pending stop remains an admission owner after ACK and actor disconnect", async () => {
  const s = setup(1);
  s.holdStop();
  s.exitEarly();
  const req = s.scheduler.createRequest(s.actor, s.work),
    r = s.scheduler.submit(req);
  await tick();
  s.scheduler.cancel(req);
  await r;
  s.scheduler.acknowledge(req);
  s.scheduler.disconnect(s.actor);
  await tick();
  try {
    assert.equal(s.scheduler.stats().running, 0);
    assert.equal(s.scheduler.stats().pendingStops, 1);
    assert.throws(() => s.scheduler.attach(() => true), /admission/);
    assert.equal(s.scheduler.forget(s.work), false);
  } finally {
    s.gate.resolve();
    s.stopGate.resolve();
    await s.scheduler.shutdown();
  }
});
test("settlement timeout faults admission rather than releasing uncertain stop ownership", async () => {
  const s = setup();
  s.holdStop();
  s.exitEarly();
  const req = s.scheduler.createRequest(s.actor, s.work),
    r = s.scheduler.submit(req);
  await tick();
  s.scheduler.cancel(req);
  await r;
  try {
    await assert.rejects(s.scheduler.settle(req), /cleanup/);
    s.scheduler.acknowledge(req);
    s.scheduler.disconnect(s.actor);
    assert.ok(s.scheduler.failure);
    assert.throws(() => s.scheduler.attach(() => true), /admission/);
    assert.equal(s.scheduler.forget(s.work), false);
  } finally {
    s.gate.resolve();
    s.stopGate.resolve();
    await s.scheduler.shutdown().catch(() => {});
  }
});
test("request settlement joins owned stop after verified exit, before acknowledgment", async () => {
  const s = setup();
  s.holdStop();
  const req = s.scheduler.createRequest(s.actor, s.work),
    result = s.scheduler.submit(req);
  await tick();
  s.scheduler.cancel(req);
  assert.equal((await result).kind, "cancelled");
  let settled = false;
  const stopping = s.scheduler.settle(req).then(() => {
    settled = true;
  });
  await tick();
  let shut = false;
  const shutdown = s.scheduler.shutdown().then(() => {
    shut = true;
  });
  await Promise.race([shutdown, new Promise<void>((r) => setTimeout(r, 40))]);
  try {
    assert.equal(settled, false, "actual exit does not release late runner stop cleanup");
    assert.equal(shut, false, "shutdown must join owned stop even after execution release");
  } finally {
    s.stopGate.resolve();
    await stopping;
    s.scheduler.acknowledge(req);
    await shutdown;
  }
});
