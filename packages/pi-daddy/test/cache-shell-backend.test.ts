import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { PersonalCacheRuntime } from "../src/products/cache-personal-runtime.ts";
import { CacheShellBackend } from "../src/products/cache-shell-backend.ts";
import { CacheStartFailure, type CacheResolution } from "../src/products/cache-scheduler.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
const tick = async () => {
  for (let n = 0; n < 5; n++) await new Promise<void>((r) => setImmediate(r));
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup() {
  const cwd = await tempDir("cache-backend"),
    input = join(cwd, "input");
  await writeFile(input, "one");
  const invocation = { cwd, shell: "/bin/bash", command: "explicit", env: { X: "one" }, timeoutMs: 3000 },
    output = { bytes: 8192, itemBytes: 4096, payloads: 8, deliveries: 8 };
  let starts = 0,
    healthy = true,
    permitted = true,
    status = 0,
    bad = false,
    spawnFail = false,
    gate: ReturnType<typeof deferred> | undefined,
    stopGate: ReturnType<typeof deferred> | undefined;
  const runtime = new PersonalCacheRuntime({
    workspace: cwd,
    profiles: [
      {
        ...invocation,
        id: "p",
        revision: "1",
        contract: "personal-best-effort-v1",
        effects: "none",
        external: "none",
        deterministic: true,
        inputs: [{ path: input, kind: "file" }],
      },
    ],
    graph: { workspaces: 1, observations: 4, entries: 4, runs: 4, edges: 16, keyBytes: 128, output },
    scheduler: {
      running: 1,
      pending: 2,
      requests: 4,
      requesters: 2,
      work: 4,
      validationMs: 100,
      completionMs: 100,
      calls: 4,
      streamBytes: 1024,
      streamChunks: 8,
      replies: output,
    },
    inputs: { paths: 4, bytes: 1024, entries: 8, ms: 100 },
    captures: 1,
    barrier: async () => ({ clock: "c:1:1", epoch: 0, changed: [], fresh: healthy }),
    closeInputs: async () => {},
    start: async (_, options) => {
      starts++;
      if (spawnFail) throw new CacheStartFailure("launch refused after attempt", true);
      const abort = () => gate?.resolve();
      options.signal.addEventListener("abort", abort, { once: true });
      const outcome = (async () => {
        await gate?.promise;
        await options.onData(
          bad
            ? Buffer.from('{"channel":"stdout","bytes":"###"}')
            : Buffer.from(
                JSON.stringify({ channel: "stdout", bytes: Buffer.from("live\0").toString("base64") }) + "\n",
              ),
        );
        return {
          output: "retained",
          exitCode: status,
          signal: null,
          cancelled: options.signal.aborted,
          timedOut: false,
          complete: true,
          startedAt: "2026-10-05T00:00:00Z",
          endedAt: "2026-10-05T00:00:01Z",
        };
      })();
      const exited = outcome.then(
        () => {},
        () => {},
      );
      return {
        outcome,
        exited,
        stop: async () => {
          abort();
          await exited;
          await stopGate?.promise;
          options.signal.removeEventListener("abort", abort);
        },
      };
    },
  });
  const decisions: CacheResolution[] = [],
    reasons: (string | undefined)[] = [],
    bypassRequests: (string | undefined)[] = [],
    chunks: Buffer[] = [],
    backend = new CacheShellBackend(runtime);
  const call = (signal = new AbortController().signal) =>
    backend
      .run(invocation, {
        signal,
        authorize: () => permitted,
        emit: async (_channel, b) => {
          chunks.push(Buffer.from(b));
        },
      })
      .then((result) => {
        if (!result) return;
        decisions.push(result.resolution);
        reasons.push(result.bypassReason);
        bypassRequests.push(result.bypassRequestId);
        return { exitCode: result.exitCode, signal: result.signal };
      });
  return {
    runtime,
    backend,
    call,
    invocation,
    chunks,
    decisions,
    reasons,
    bypassRequests,
    count: () => starts,
    healthy: (v: boolean) => {
      healthy = v;
    },
    permit: (v: boolean) => {
      permitted = v;
    },
    fail: () => {
      spawnFail = true;
    },
    bad: () => {
      bad = true;
    },
    status: (v: number) => {
      status = v;
    },
    hold: () => {
      gate = deferred();
      return gate;
    },
    holdStop: () => {
      stopGate = deferred();
      return stopGate;
    },
  };
}
test("private shell backend awaits raw bytes and retains original execution on repeat", async () => {
  const s = await setup();
  try {
    assert.deepEqual(await s.call(), { exitCode: 0, signal: null });
    assert.deepEqual(await s.call(), { exitCode: 0, signal: null });
    assert.equal(s.count(), 1);
    assert.equal(s.decisions[1].kind, "reuse");
    assert.equal(s.decisions[1].executionId, s.decisions[0].executionId);
    assert.deepEqual(Buffer.concat(s.chunks), Buffer.from("live\0live\0"));
  } finally {
    await s.runtime.shutdown();
  }
});
test("known pre-launch observation uncertainty runs ordinarily once without publishing", async () => {
  const s = await setup();
  s.healthy(false);
  s.status(7);
  try {
    assert.deepEqual(await s.call(), { exitCode: 7, signal: null });
    assert.equal(s.count(), 1);
    assert.equal(s.decisions.at(-1)?.published, false);
    assert.match(s.reasons.at(-1)!, /Watchman/);
    assert.ok(s.bypassRequests.at(-1), "keep cache lookup separate from subsequent normal request");
    assert.notEqual(s.bypassRequests.at(-1), s.decisions.at(-1)!.requestId);
    await s.call();
    assert.equal(s.count(), 2);
  } finally {
    await s.runtime.shutdown();
  }
});
test("attempted launch, malformed private stream and operation denial never trigger retry", async () => {
  const failed = await setup();
  failed.fail();
  try {
    await assert.rejects(failed.call(), /not retrying/);
    assert.equal(failed.count(), 1);
  } finally {
    await failed.runtime.shutdown();
  }
  const bad = await setup();
  bad.bad();
  try {
    await assert.rejects(bad.call(), /not retrying/);
    assert.equal(bad.count(), 1);
  } finally {
    await bad.runtime.shutdown();
  }
  const denied = await setup();
  denied.permit(false);
  try {
    assert.equal(await denied.call(), undefined);
    assert.equal(denied.count(), 0);
  } finally {
    await denied.runtime.shutdown();
  }
});
test("concurrent runtime shutdown retires a cached backend reader without foreign-handle fault", async () => {
  const s = await setup();
  await s.call();
  const gate = deferred(),
    entered = deferred(),
    control = new AbortController();
  const hit = s.backend.run(s.invocation, {
    signal: control.signal,
    authorize: () => true,
    emit: async () => {
      entered.resolve();
      await gate.promise;
    },
  });
  await entered.promise;
  const closing = s.runtime.shutdown();
  control.abort();
  // Reader ownership delays both shutdown and bridge; eventual actor retirement is not a foreign handle.
  await new Promise<void>((r) => setTimeout(r, 30));
  gate.resolve();
  try {
    await closing;
    assert.equal(await hit, undefined);
  } finally {
    control.abort();
    gate.resolve();
    await hit.catch(() => {});
  }
});
test("aborted committed call must expose unsettled cleanup instead of ordinary cancellation", async () => {
  const s = await setup(),
    gate = s.hold(),
    stop = s.holdStop(),
    control = new AbortController();
  const call = s.call(control.signal);
  const deadline = Date.now() + 1000;
  while (!s.count() && Date.now() < deadline) await new Promise<void>((r) => setTimeout(r, 5));
  control.abort();
  try {
    await assert.rejects(call, /cleanup/);
    assert.equal(s.count(), 1);
  } finally {
    gate.resolve();
    stop.resolve();
    await call.catch(() => {});
    await s.runtime.shutdown().catch(() => {});
  }
});
test("committed backend cancellation cannot settle before last-interest runner cleanup", async () => {
  const s = await setup(),
    gate = s.hold(),
    stop = s.holdStop(),
    abort = new AbortController();
  let done = false;
  const call = s.call(abort.signal).then((value) => {
    done = true;
    return value;
  });
  const deadline = Date.now() + 1000;
  while (!s.count() && Date.now() < deadline) await new Promise<void>((r) => setTimeout(r, 5));
  abort.abort();
  await tick();
  try {
    assert.equal(s.count(), 1);
    assert.equal(done, false);
  } finally {
    gate.resolve();
    stop.resolve();
    await call;
    await s.runtime.shutdown();
  }
});
