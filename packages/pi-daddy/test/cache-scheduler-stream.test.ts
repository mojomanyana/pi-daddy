import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheGraph } from "../src/products/cache-graph.ts";
import { CacheScheduler, type CacheRunOutcome } from "../src/products/cache-scheduler.ts";
const tick = async () => {
  for (let n = 0; n < 5; n++) await new Promise<void>((r) => setImmediate(r));
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const report = (): CacheRunOutcome => ({
  output: "result",
  exitCode: 0,
  signal: null,
  cancelled: false,
  timedOut: false,
  complete: true,
  startedAt: "2026-10-05T00:00:00Z",
  endedAt: "2026-10-05T00:00:01Z",
});
function setup(requests = 4) {
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
    pending: 4,
    requests,
    requesters: 4,
    work: 4,
    validationMs: 100,
    completionMs: 100,
    calls: 4,
    streamBytes: 1024,
    streamChunks: 16,
    replies: output,
  });
  const workspace = graph.workspace("/stream"),
    input = graph.observe(workspace, "input", "one"),
    done = deferred<CacheRunOutcome>(),
    exited = deferred<void>();
  let emit!: (b: Buffer) => void | Promise<void>,
    permit = true,
    starts = 0;
  const actor = scheduler.attach(() => permit),
    work = scheduler.prepare({
      workspace,
      key: "exact",
      inputs: [input],
      parents: [],
      shareable: true,
      validate: async () => true,
      start: async (options) => {
        starts++;
        emit = options.onData;
        return {
          outcome: done.promise,
          exited: exited.promise,
          stop: async () => {
            done.resolve({ ...report(), cancelled: true });
            exited.resolve();
          },
        };
      },
    });
  return {
    graph,
    scheduler,
    actor,
    work,
    emit: (b: Buffer) => emit(b),
    permit: (value: boolean) => {
      permit = value;
    },
    starts: () => starts,
    exit: () => exited.resolve(),
    complete: () => done.resolve(report()),
    finish: () => {
      done.resolve(report());
      exited.resolve();
    },
  };
}
test("fresh output and final result await each asynchronous reader", async () => {
  const s = setup(),
    gate = deferred<void>(),
    chunks: string[] = [];
  const req = s.scheduler.createRequest(s.actor, s.work, {
    onData: async (b) => {
      chunks.push(b.toString());
      await gate.promise;
    },
  });
  let finished = false;
  const result = s.scheduler.submit(req).then((r) => {
    finished = true;
    return r;
  });
  await tick();
  let drained = false;
  const delivery = Promise.resolve(s.emit(Buffer.from("one"))).then(() => {
    drained = true;
  });
  s.finish();
  await tick();
  try {
    assert.equal(drained, false);
    assert.equal(finished, false);
  } finally {
    gate.resolve();
    await delivery;
    await result;
    await s.scheduler.shutdown();
  }
  assert.deepEqual(chunks, ["one"]);
});
test("cached replay waits for async sinks and checks current permission after awaiting", async () => {
  const s = setup(),
    original = s.scheduler.createRequest(s.actor, s.work);
  const first = s.scheduler.submit(original);
  await tick();
  await s.emit(Buffer.from("cached"));
  s.finish();
  const prior = await first;
  s.scheduler.acknowledge(original);
  const gate = deferred<void>(),
    req = s.scheduler.createRequest(s.actor, s.work, { onData: async () => gate.promise });
  let settled = false;
  const hit = s.scheduler.submit(req).then((r) => {
    settled = true;
    return r;
  });
  await tick();
  try {
    assert.equal(settled, false);
    s.permit(false);
  } finally {
    gate.resolve();
  }
  const result = await hit;
  assert.equal(result.kind, "reject");
  assert.equal(s.starts(), 1);
  assert.ok(prior.executionId);
  await s.scheduler.shutdown();
});
test("cancelled async reader stays charged but cannot block another shared interest", async () => {
  const s = setup(2),
    gate = deferred<void>(),
    slow = s.scheduler.createRequest(s.actor, s.work, { onData: async () => gate.promise });
  const chunks: string[] = [],
    fast = s.scheduler.createRequest(s.actor, s.work, {
      onData: (b) => {
        chunks.push(b.toString());
      },
    });
  const a = s.scheduler.submit(slow),
    b = s.scheduler.submit(fast);
  await tick();
  const delivery = Promise.resolve(s.emit(Buffer.from("one")));
  s.scheduler.cancel(slow);
  assert.equal((await a).kind, "cancelled");
  s.scheduler.acknowledge(slow);
  try {
    assert.throws(() => s.scheduler.createRequest(s.actor, s.work), /admission/);
  } finally {
    gate.resolve();
  }
  await delivery;
  await s.emit(Buffer.from("two"));
  s.finish();
  assert.equal((await b).kind, "join");
  assert.deepEqual(chunks, ["one", "two"]);
  await s.scheduler.shutdown();
});
test("late join catchup and live async chunks retain order without duplicates", async () => {
  const s = setup(),
    first = s.scheduler.createRequest(s.actor, s.work),
    a = s.scheduler.submit(first);
  await tick();
  await s.emit(Buffer.from("one"));
  const gate = deferred<void>(),
    chunks: string[] = [];
  const second = s.scheduler.createRequest(s.actor, s.work, {
    onData: async (b) => {
      chunks.push(b.toString());
      if (chunks.length === 1) await gate.promise;
    },
  });
  const b = s.scheduler.submit(second);
  await tick();
  const delivery = Promise.resolve(s.emit(Buffer.from("two")));
  await tick();
  try {
    assert.deepEqual(chunks, ["one"]);
  } finally {
    gate.resolve();
  }
  await delivery;
  s.finish();
  await Promise.all([a, b]);
  assert.deepEqual(chunks, ["one", "two"]);
  await s.scheduler.shutdown();
});
test("async reader rejection detaches only itself and forbids success for that request", async () => {
  const s = setup(),
    failed = s.scheduler.createRequest(s.actor, s.work, {
      onData: async () => {
        throw Error("sink failed");
      },
    });
  const good = s.scheduler.createRequest(s.actor, s.work),
    a = s.scheduler.submit(failed),
    b = s.scheduler.submit(good);
  await tick();
  await s.emit(Buffer.from("x"));
  s.finish();
  assert.equal((await a).kind, "reject");
  assert.equal((await b).kind, "join");
  await s.scheduler.shutdown();
});
test("shutdown retains a cancelled, acknowledged reader until its pending callback settles", async () => {
  const s = setup(),
    gate = deferred<void>(),
    req = s.scheduler.createRequest(s.actor, s.work, { onData: async () => gate.promise });
  const result = s.scheduler.submit(req);
  await tick();
  const delivery = Promise.resolve(s.emit(Buffer.from("one")));
  s.scheduler.cancel(req);
  await result;
  s.scheduler.acknowledge(req);
  let stopped = false;
  const stopping = s.scheduler.shutdown().then(() => {
    stopped = true;
  });
  await tick();
  try {
    assert.equal(stopped, false);
    assert.equal(s.scheduler.stats().pendingReaders, 1);
    assert.equal(s.scheduler.forget(s.work), false);
  } finally {
    gate.resolve();
    await delivery;
    await stopping;
  }
});
test("undefined async reader rejection is still failure, never successful delivery", async () => {
  const s = setup(),
    req = s.scheduler.createRequest(s.actor, s.work, {
      onData: async () => {
        throw undefined;
      },
    }),
    result = s.scheduler.submit(req);
  await tick();
  await s.emit(Buffer.from("one"));
  assert.equal((await result).kind, "reject");
  await s.scheduler.shutdown();
});
test("trusted producer frames just beyond protocol bound reject without publishing", async () => {
  const s = setup(),
    req = s.scheduler.createRequest(s.actor, s.work),
    result = s.scheduler.submit(req);
  await tick();
  await s.emit(Buffer.alloc(262145));
  assert.equal((await result).kind, "reject");
  await s.scheduler.shutdown();
});
test("verified command exit releases running slot while async output remains finalizing", async () => {
  const s = setup(),
    gate = deferred<void>(),
    first = s.scheduler.createRequest(s.actor, s.work, { onData: async () => gate.promise });
  const a = s.scheduler.submit(first);
  await tick();
  const delivery = Promise.resolve(s.emit(Buffer.from("one")));
  s.finish();
  const second = s.scheduler.createRequest(s.actor, s.work, { force: true }),
    b = s.scheduler.submit(second);
  await tick();
  try {
    assert.equal(s.starts(), 2, "slow output is retained finalization, not another live process");
  } finally {
    gate.resolve();
    await delivery;
    await Promise.all([a, b]);
    await s.scheduler.shutdown();
  }
});
test("late finalizing join cannot succeed before catchup settles or hide sink rejection", async () => {
  const s = setup(),
    first = s.scheduler.createRequest(s.actor, s.work),
    a = s.scheduler.submit(first);
  await tick();
  await s.emit(Buffer.from("retained"));
  s.exit();
  await tick();
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((_, no) => {
    reject = no;
  });
  const late = s.scheduler.createRequest(s.actor, s.work, { onData: async () => gate });
  let finished = false;
  const b = s.scheduler.submit(late).then((r) => {
    finished = true;
    return r;
  });
  await tick();
  s.complete();
  await tick();
  try {
    assert.equal(finished, false, "post-exit catchup must join final delivery barrier");
  } finally {
    reject(Error("late catchup failed"));
  }
  assert.equal((await b).kind, "reject");
  await a;
  assert.equal(s.starts(), 1);
  await s.scheduler.shutdown();
});
test("revocation before streaming gives no bytes to an unauthorized reader", async () => {
  const s = setup(),
    chunks: Buffer[] = [],
    req = s.scheduler.createRequest(s.actor, s.work, {
      onData: (b) => {
        chunks.push(b);
      },
    }),
    a = s.scheduler.submit(req);
  await tick();
  s.permit(false);
  await s.emit(Buffer.from("private"));
  s.finish();
  assert.equal((await a).kind, "reject");
  assert.equal(chunks.length, 0);
  await s.scheduler.shutdown();
});
