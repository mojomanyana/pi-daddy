import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheGraph } from "../src/products/cache-graph.ts";
import { CacheScheduler, type OwnedCacheRun } from "../src/products/cache-scheduler.ts";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}
const result = {
  output: "ok",
  startedAt: "2026-10-01T00:00:00Z",
  endedAt: "2026-10-01T00:00:01Z",
  exitCode: 0,
  signal: null,
  cancelled: false,
  timedOut: false,
  complete: true,
};
const limits = {
  running: 2,
  pending: 2,
  requests: 8,
  requesters: 2,
  work: 8,
  validationMs: 50,
  completionMs: 50,
  calls: 8,
  streamBytes: 64,
  streamChunks: 4,
  replies: { bytes: 8, itemBytes: 8, payloads: 8, deliveries: 8 },
};
function setup(overrides: Partial<typeof limits> = {}) {
  const graph = new CacheGraph({
    workspaces: 2,
    observations: 4,
    entries: 8,
    runs: 8,
    edges: 8,
    keyBytes: 64,
    output: { bytes: 4096, itemBytes: 1024, payloads: 8, deliveries: 8 },
  });
  const scheduler = new CacheScheduler(graph, { ...limits, ...overrides }),
    workspace = graph.workspace("/a"),
    input = graph.observe(workspace, "input", "v");
  const actor = scheduler.attach(() => true);
  const tick = async () => {
    for (let n = 0; n < 5; n++) await new Promise<void>((ok) => setImmediate(ok));
  };
  const prepare = (key: string, start: () => Promise<OwnedCacheRun>) =>
    scheduler.prepare({
      workspace,
      key,
      inputs: [input],
      parents: [],
      shareable: true,
      validate: async () => true,
      start,
    });
  return { graph, scheduler, workspace, input, actor, tick, prepare };
}
test("synchronous stop throws never escape cancellation and cannot skip other owned teardown", async () => {
  const s = setup(),
    exitA = deferred<void>(),
    exitB = deferred<void>();
  let stopsA = 0,
    stopsB = 0;
  const a = s.prepare("a", async () => ({
    outcome: new Promise(() => {}),
    exited: exitA.promise,
    stop: () => {
      stopsA++;
      throw Error("sync stop fault");
    },
  }));
  const b = s.prepare("b", async () => ({
    outcome: new Promise(() => {}),
    exited: exitB.promise,
    stop: async () => {
      stopsB++;
      exitB.resolve();
    },
  }));
  const one = s.scheduler.createRequest(s.actor, a),
    two = s.scheduler.createRequest(s.actor, b);
  const p = s.scheduler.submit(one),
    q = s.scheduler.submit(two);
  await s.tick();
  assert.doesNotThrow(() => s.scheduler.cancel(one));
  let stopped!: Promise<void>;
  assert.doesNotThrow(() => {
    stopped = s.scheduler.shutdown();
  });
  assert.ok(stopped instanceof Promise);
  await p;
  await q;
  await s.tick();
  assert.equal(stopsA, 1);
  assert.equal(stopsB, 1);
  assert.equal(s.scheduler.stats().running, 1);
  assert.match(s.scheduler.failure?.message ?? "", /sync stop fault/);
  exitA.resolve();
  await assert.rejects(stopped, /sync stop fault/);
  assert.equal(s.scheduler.stats().failedStops, 1, "tree exit is not successful stop-resource cleanup");
});
test("unknown start cleanup faults the root, settles queued interests and stops active peers automatically", async () => {
  const s = setup(),
    peerExit = deferred<void>(),
    startGate = deferred<void>();
  let peerStops = 0,
    queuedStarts = 0;
  const peer = s.prepare("peer", async () => ({
    outcome: new Promise(() => {}),
    exited: peerExit.promise,
    stop: async () => {
      peerStops++;
      peerExit.resolve();
    },
  }));
  const broken = s.prepare("broken", async () => {
    await startGate.promise;
    throw Error("unknown cleanup");
  });
  const queued = s.prepare("queued", async () => {
    queuedStarts++;
    return { outcome: Promise.resolve(result), exited: Promise.resolve(), stop: async () => {} };
  });
  const a = s.scheduler.submit(s.scheduler.createRequest(s.actor, peer)),
    b = s.scheduler.submit(s.scheduler.createRequest(s.actor, broken));
  await s.tick();
  const c = s.scheduler.submit(s.scheduler.createRequest(s.actor, queued));
  await s.tick();
  assert.equal(s.scheduler.stats().queued, 1);
  startGate.resolve();
  assert.equal((await b).kind, "reject");
  const queuedReply = await Promise.race([c, new Promise<undefined>((ok) => setTimeout(() => ok(undefined), 100))]);
  assert.ok(queuedReply, "root fault stranded queued request");
  assert.equal(queuedReply.kind, "reject");
  await a;
  await s.tick();
  assert.equal(peerStops, 1);
  assert.equal(queuedStarts, 0);
  assert.equal(s.scheduler.stats().queued, 0);
  assert.equal(s.scheduler.stats().running, 1);
  await assert.rejects(s.scheduler.shutdown(), /unresolved/);
});
test("prestart removed input and malformed post-exit outcome release only known-safe ownership", async () => {
  for (const beforeStart of [true, false]) {
    const s = setup();
    let starts = 0;
    const work = s.prepare("a", async () => {
      starts++;
      return {
        outcome: Promise.resolve({ ...result, startedAt: "invalid" }),
        exited: Promise.resolve(),
        stop: async () => {},
      };
    });
    if (beforeStart) s.graph.reconcile(s.graph.dirty(s.input), undefined);
    const response = await s.scheduler.submit(s.scheduler.createRequest(s.actor, work));
    assert.ok(["reject", "bypass"].includes(response.kind));
    assert.equal(starts, beforeStart ? 0 : 1);
    assert.equal(s.scheduler.stats().running, 0);
    assert.equal(s.graph.stats().runs, 0);
    await s.scheduler.shutdown();
  }
});
test("verified exit releases process occupancy and missing outcome is bounded without reader cancellation", async () => {
  const s = setup(),
    started = deferred<void>();
  let launches = 0;
  const lost = s.prepare("lost", async () => ({
    outcome: new Promise(() => {}),
    exited: Promise.resolve(),
    stop: async () => {},
  }));
  const good = s.prepare("good", async () => {
    launches++;
    started.resolve();
    return { outcome: Promise.resolve(result), exited: Promise.resolve(), stop: async () => {} };
  });
  const a = s.scheduler.submit(s.scheduler.createRequest(s.actor, lost)),
    b = s.scheduler.submit(s.scheduler.createRequest(s.actor, lost, { force: true }));
  await s.tick();
  const c = s.scheduler.submit(s.scheduler.createRequest(s.actor, good));
  await Promise.race([
    started.promise,
    new Promise<void>((_, fail) => setTimeout(() => fail(Error("queue stayed blocked by exited runs")), 100)),
  ]);
  assert.equal(launches, 1);
  const replies = await Promise.all([a, b]);
  for (const r of replies) {
    assert.equal(r.kind, "reject");
    assert.match(r.reason ?? "", /outcome|completion/);
  }
  await c;
  await s.scheduler.shutdown();
});
test("prepare refuses UTF8/key/dependency/foreign/cross-workspace/unavailable-parent boundaries before storing plans", () => {
  const s = setup(),
    other = s.graph.workspace("/b"),
    foreignInput = s.graph.observe(other, "f", "v");
  const ticket = s.graph.begin(other, "parent", [foreignInput], [])!,
    parent = s.graph.publish(ticket, { ...result, executionId: "parent" })!;
  const own = s.graph.begin(s.workspace, "own", [s.input], [])!,
    ownParent = s.graph.publish(own, { ...result, executionId: "own" })!;
  s.graph.remove(ownParent);
  const base = {
    workspace: s.workspace,
    key: "x",
    inputs: [s.input],
    parents: [],
    shareable: true,
    validate: async () => true,
    start: async () => ({ outcome: Promise.resolve(result), exited: Promise.resolve(), stop: async () => {} }),
  };
  for (const patch of [
    { key: "é".repeat(33) },
    { inputs: Array(9).fill(s.input) },
    { inputs: [{} as typeof s.input] },
    { inputs: [foreignInput] },
    { parents: [parent] },
    { parents: [ownParent] },
  ]) {
    assert.throws(() => s.scheduler.prepare({ ...base, ...patch }), /key|bounds|foreign|another|unavailable/);
    assert.equal(s.scheduler.stats().prepared, 0);
  }
});
test("oversized and aggregate reply budgets preserve first completion but prevent unsafe retry relaunch", async () => {
  const s = setup();
  let starts = 0;
  const work = s.prepare("size", async () => {
    starts++;
    return {
      outcome: Promise.resolve({ ...result, output: "0123456789" }),
      exited: Promise.resolve(),
      stop: async () => {},
    };
  });
  const token = s.scheduler.createRequest(s.actor, work),
    first = await s.scheduler.submit(token);
  assert.equal(first.outcome?.output, "0123456789");
  assert.equal((await s.scheduler.submit(token)).kind, "reject");
  assert.equal(starts, 1);
  assert.equal(s.scheduler.stats().replies.bytes, 0);
  s.scheduler.acknowledge(token);
  const small = s.prepare("small", async () => ({
    outcome: Promise.resolve({ ...result, output: "1234" }),
    exited: Promise.resolve(),
    stop: async () => {},
  }));
  const retained = [];
  for (let n = 0; n < 3; n++) {
    const r = s.scheduler.createRequest(s.actor, small);
    retained.push(r);
    await s.scheduler.submit(r);
  }
  assert.equal(s.scheduler.stats().replies.bytes, 8);
  assert.equal((await s.scheduler.submit(retained[2])).kind, "reject");
  for (const r of retained) s.scheduler.acknowledge(r);
  assert.equal(s.scheduler.stats().replies.bytes, 0);
  assert.equal(s.scheduler.stats().requests, 0);
  const r = s.scheduler.createRequest(s.actor, small);
  assert.equal((await s.scheduler.submit(r)).kind, "reuse");
  assert.equal(s.scheduler.stats().replies.bytes, 4);
  await s.scheduler.shutdown();
});
test("empty stream chunks consume count budget and prevent publication", async () => {
  const s = setup();
  const work = s.prepare("chunks", async () => ({
    outcome: Promise.resolve(result),
    exited: Promise.resolve(),
    stop: async () => {},
  }));
  // Distinct prepared callback exercises the stream before its returned handle, not a test mutation hook.
  const special = s.scheduler.prepare({
    workspace: s.workspace,
    key: "empty",
    inputs: [s.input],
    parents: [],
    shareable: true,
    validate: async () => true,
    start: async ({ onData }) => {
      for (let n = 0; n < 5; n++) onData(Buffer.alloc(0));
      return { outcome: Promise.resolve(result), exited: Promise.resolve(), stop: async () => {} };
    },
  });
  const token = s.scheduler.createRequest(s.actor, special);
  assert.equal((await s.scheduler.submit(token)).published, false);
  assert.equal(s.graph.stats().entries, 0);
  assert.ok(work);
  await s.scheduler.shutdown();
});
