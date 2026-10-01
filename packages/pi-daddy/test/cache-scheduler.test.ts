import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheGraph } from "../src/products/cache-graph.ts";
import { CacheScheduler, type CacheRunOutcome } from "../src/products/cache-scheduler.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const outcome = (output = "original result"): CacheRunOutcome => ({
  output,
  startedAt: "2026-10-01T00:00:00Z",
  endedAt: "2026-10-01T00:00:01Z",
  exitCode: 0,
  signal: null,
  cancelled: false,
  timedOut: false,
  complete: true,
});
function setup(running = 2) {
  const graph = new CacheGraph({
    workspaces: 2,
    observations: 8,
    entries: 8,
    runs: 8,
    edges: 24,
    keyBytes: 128,
    output: { bytes: 4096, itemBytes: 1024, payloads: 12, deliveries: 8 },
  });
  const scheduler = new CacheScheduler(graph, {
    running,
    pending: 8,
    requests: 16,
    requesters: 4,
    work: 8,
    validationMs: 100,
    completionMs: 100,
    calls: 16,
    streamBytes: 128,
    streamChunks: 16,
    replies: { bytes: 1024, itemBytes: 128, payloads: 16, deliveries: 8 },
  });
  const workspace = graph.workspace("/a"),
    source = graph.observe(workspace, "file", "first");
  let allowed = true,
    valid = true;
  const actor = scheduler.attach(() => allowed);
  const launches: Array<{
    done: ReturnType<typeof deferred<CacheRunOutcome>>;
    exited: ReturnType<typeof deferred<void>>;
    stops: number;
    signal: AbortSignal;
    data: (bytes: Buffer) => void;
  }> = [];
  const plan = {
    workspace,
    key: "exact-invocation-and-input-fingerprint",
    inputs: [source],
    parents: [],
    shareable: true,
    validate: async () => valid,
    start: async ({
      signal,
      onData,
    }: {
      executionId: string;
      signal: AbortSignal;
      onData: (bytes: Buffer) => void;
    }) => {
      const run = { done: deferred<CacheRunOutcome>(), exited: deferred<void>(), stops: 0, signal, data: onData };
      launches.push(run);
      return {
        outcome: run.done.promise,
        exited: run.exited.promise,
        stop: async () => {
          run.stops++;
          await run.exited.promise;
        },
      };
    },
  };
  const work = scheduler.prepare(plan);
  const finish = (index: number, result = outcome()) => {
    launches[index].done.resolve(result);
    launches[index].exited.resolve();
  };
  const tick = async () => {
    for (let index = 0; index < 5; index++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return {
    scheduler,
    graph,
    workspace,
    source,
    actor,
    work,
    plan,
    launches,
    finish,
    tick,
    permit: (value: boolean) => {
      allowed = value;
    },
    qualify: (value: boolean) => {
      valid = value;
    },
  };
}

test("identical authorized requests share one execution and completed repeat preserves provenance", async () => {
  const s = setup();
  const other = s.scheduler.attach(() => true);
  const one = s.scheduler.createRequest(s.actor, s.work),
    two = s.scheduler.createRequest(other, s.work);
  const first = s.scheduler.submit(one),
    second = s.scheduler.submit(two);
  await s.tick();
  assert.equal(s.launches.length, 1);
  s.finish(0);
  const a = await first,
    b = await second;
  assert.equal(a.kind, "execute");
  assert.equal(b.kind, "join");
  assert.equal(a.executionId, b.executionId);
  assert.notEqual(a.requestId, b.requestId);
  const third = s.scheduler.createRequest(s.actor, s.work),
    hit = await s.scheduler.submit(third);
  assert.equal(hit.kind, "reuse");
  assert.equal(hit.executionId, a.executionId);
  assert.deepEqual(hit.outcome, a.outcome);
  assert.equal(s.launches.length, 1);
  s.scheduler.acknowledge(one);
  s.scheduler.acknowledge(two);
  s.scheduler.acknowledge(third);
  await s.scheduler.shutdown();
});

test("same logical request retry never starts another execution and retired identity cannot relaunch", async () => {
  const s = setup(),
    request = s.scheduler.createRequest(s.actor, s.work);
  const a = s.scheduler.submit(request),
    retry = s.scheduler.submit(request);
  await s.tick();
  assert.equal(s.launches.length, 1);
  s.finish(0);
  assert.deepEqual(await a, await retry);
  assert.deepEqual(await s.scheduler.submit(request), await a);
  s.scheduler.acknowledge(request);
  s.scheduler.acknowledge(request);
  await assert.rejects(s.scheduler.submit(request), /acknowledged/);
  assert.equal(s.launches.length, 1);
  await s.scheduler.shutdown();
});

test("each hit, join, retry and queued dispatch checks current authority", async () => {
  const s = setup(1),
    first = s.scheduler.createRequest(s.actor, s.work),
    a = s.scheduler.submit(first);
  await s.tick();
  s.permit(false);
  assert.equal((await s.scheduler.submit(first)).kind, "reject");
  const denied = s.scheduler.createRequest(s.actor, s.work);
  assert.equal((await s.scheduler.submit(denied)).kind, "reject");
  assert.equal(s.launches.length, 1);
  s.finish(0);
  await a;
  const hit = s.scheduler.createRequest(s.actor, s.work);
  assert.equal((await s.scheduler.submit(hit)).kind, "reject");
  s.permit(true);
  const held = s.scheduler.createRequest(s.actor, s.work, { force: true });
  const wait = s.scheduler.submit(held);
  await s.tick();
  const otherWork = s.scheduler.prepare({ ...s.plan, key: "other-command" });
  const queued = s.scheduler.createRequest(s.actor, otherWork);
  const pending = s.scheduler.submit(queued);
  await s.tick();
  s.permit(false);
  s.finish(1);
  await wait;
  assert.equal((await pending).kind, "reject");
  assert.equal(s.launches.length, 2);
  await s.scheduler.shutdown();
});

test("one cancellation detaches only that interest; last cancellation retains slot until actual exit", async () => {
  const s = setup(1),
    one = s.scheduler.createRequest(s.actor, s.work),
    two = s.scheduler.createRequest(s.actor, s.work);
  const a = s.scheduler.submit(one),
    b = s.scheduler.submit(two);
  await s.tick();
  s.scheduler.cancel(one);
  assert.equal((await a).kind, "cancelled");
  assert.equal(s.launches[0].stops, 0);
  s.scheduler.cancel(two);
  assert.equal((await b).kind, "cancelled");
  await s.tick();
  assert.equal(s.launches[0].signal.aborted, true);
  assert.equal(s.launches[0].stops, 1);
  assert.equal(s.scheduler.stats().running, 1);
  assert.equal(s.graph.stats().runs, 1);
  s.finish(0, { ...outcome(), cancelled: true, complete: false });
  await s.tick();
  assert.equal(s.scheduler.stats().running, 0);
  assert.equal(s.graph.acquire(s.workspace, s.plan.key), undefined);
  await s.scheduler.shutdown();
});

test("request waiting deadline differs from execution bound and preserves another interest", async () => {
  const s = setup(),
    one = s.scheduler.createRequest(s.actor, s.work, { waitMs: 20 }),
    two = s.scheduler.createRequest(s.actor, s.work);
  const a = s.scheduler.submit(one),
    b = s.scheduler.submit(two);
  await s.tick();
  assert.equal((await a).kind, "timed-out");
  assert.equal(s.launches[0].signal.aborted, false);
  s.finish(0);
  assert.equal((await b).kind, "join");
  await s.scheduler.shutdown();
});

test("force request independently executes instead of joining ordinary work or hitting cache", async () => {
  const s = setup(),
    one = s.scheduler.createRequest(s.actor, s.work),
    two = s.scheduler.createRequest(s.actor, s.work, { force: true });
  const a = s.scheduler.submit(one),
    b = s.scheduler.submit(two);
  await s.tick();
  assert.equal(s.launches.length, 2);
  s.finish(1, outcome("fresh"));
  s.finish(0, outcome("older"));
  assert.notEqual((await a).executionId, (await b).executionId);
  const request = s.scheduler.createRequest(s.actor, s.work);
  assert.equal((await s.scheduler.submit(request)).outcome?.output, "fresh");
  await s.scheduler.shutdown();
});

test("input change blocks new obsolete joins and completion cannot publish after change undo", async () => {
  const s = setup(),
    one = s.scheduler.createRequest(s.actor, s.work),
    a = s.scheduler.submit(one);
  await s.tick();
  s.graph.reconcile(s.graph.dirty(s.source), "changed");
  s.graph.reconcile(s.graph.dirty(s.source), "first");
  const two = s.scheduler.createRequest(s.actor, s.work),
    b = s.scheduler.submit(two);
  await s.tick();
  assert.equal(s.launches.length, 2);
  s.finish(0);
  assert.equal((await a).published, false);
  s.finish(1);
  assert.equal((await b).published, true);
  await s.scheduler.shutdown();
});

test("unqualified source validation bypasses without launch; failed outcomes never publish", async () => {
  const s = setup();
  s.qualify(false);
  const bypass = s.scheduler.createRequest(s.actor, s.work);
  assert.equal((await s.scheduler.submit(bypass)).kind, "bypass");
  assert.equal(s.launches.length, 0);
  s.qualify(true);
  for (const patch of [
    { exitCode: 1 },
    { timedOut: true },
    { complete: false },
    { signal: "SIGTERM", exitCode: null },
  ]) {
    const request = s.scheduler.createRequest(s.actor, s.work),
      promise = s.scheduler.submit(request);
    await s.tick();
    s.finish(s.launches.length - 1, { ...outcome(), ...patch });
    assert.equal((await promise).published, false);
    assert.equal(s.graph.acquire(s.workspace, s.plan.key), undefined);
    s.scheduler.acknowledge(request);
  }
  await s.scheduler.shutdown();
});

test("stream callbacks receive exact private bytes and a failed reader cannot cancel another reader", async () => {
  const s = setup(),
    chunks: Buffer[] = [];
  const one = s.scheduler.createRequest(s.actor, s.work, {
    onData: (bytes) => {
      bytes.fill(0);
      throw new Error("reader failed");
    },
  });
  const two = s.scheduler.createRequest(s.actor, s.work, { onData: (bytes) => chunks.push(bytes) });
  const a = s.scheduler.submit(one),
    b = s.scheduler.submit(two);
  await s.tick();
  const original = Buffer.from([0xff, 0x00, 0xe2, 0x82, 0xac]);
  s.launches[0].data(original);
  assert.equal((await a).kind, "reject");
  assert.deepEqual(original, chunks[0]);
  assert.equal(s.launches[0].signal.aborted, false);
  s.finish(0);
  assert.equal((await b).kind, "join");
  await s.scheduler.shutdown();
});
