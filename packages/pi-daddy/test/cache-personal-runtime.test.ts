import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  PersonalCacheRuntime,
  type PersonalCacheInvocation,
  type PersonalCacheProfile,
} from "../src/products/cache-personal-runtime.ts";
import type { CacheRunOutcome } from "../src/products/cache-scheduler.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
const output = { bytes: 65536, itemBytes: 16384, payloads: 32, deliveries: 16 };
const graph = { workspaces: 1, observations: 8, entries: 8, runs: 8, edges: 32, keyBytes: 256, output };
const scheduler = {
  running: 2,
  pending: 8,
  requests: 16,
  requesters: 4,
  work: 8,
  validationMs: 1000,
  completionMs: 1000,
  calls: 16,
  streamBytes: 4096,
  streamChunks: 16,
  replies: output,
};
async function setup(env = { X: "one" } as Record<string, string>) {
  const root = await tempDir("cache-personal-runtime"),
    path = join(root, "input");
  await writeFile(path, "one");
  const profile: PersonalCacheProfile = {
    id: "unit",
    revision: "1",
    contract: "personal-best-effort-v1",
    cwd: root,
    shell: "/bin/bash",
    command: "literal command",
    env,
    inputs: [{ path, kind: "file" }],
    effects: "none",
    external: "none",
    deterministic: true,
  };
  let allowed = true,
    launches = 0,
    health = true,
    gate: Promise<void> | undefined,
    onBarrier: (() => void | Promise<void>) | undefined,
    closeFail = false;
  const runtime = new PersonalCacheRuntime({
    workspace: root,
    profiles: [profile],
    graph,
    scheduler,
    inputs: { paths: 16, bytes: 4096, entries: 32, ms: 500 },
    captures: 2,
    barrier: async () => {
      await onBarrier?.();
      return { clock: "c:1:1", epoch: 0, changed: [], fresh: health };
    },
    start: async (_invocation, options) => {
      launches++;
      const value = await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"));
      const outcome = (async (): Promise<CacheRunOutcome> => {
        await gate;
        options.onData(Buffer.from(value));
        return {
          output: value,
          startedAt: "2026-10-05T00:00:00Z",
          endedAt: "2026-10-05T00:00:01Z",
          exitCode: 0,
          signal: null,
          cancelled: false,
          timedOut: false,
          complete: true,
        };
      })();
      return {
        outcome,
        exited: outcome.then(() => {}),
        stop: async () => {
          await outcome;
        },
      };
    },
    closeInputs: async () => {
      if (closeFail) throw Error("fixture watcher close failed");
    },
  });
  const actor = runtime.attach(() => allowed),
    invocation: PersonalCacheInvocation = {
      cwd: root,
      shell: "/bin/bash",
      command: "literal command",
      env,
      timeoutMs: 3000,
    };
  return {
    runtime,
    actor,
    invocation,
    path,
    profile,
    count: () => launches,
    permit: (value: boolean) => {
      allowed = value;
    },
    healthy: (value: boolean) => {
      health = value;
    },
    hold: (value: Promise<void> | undefined) => {
      gate = value;
    },
    onBarrier: (value: () => void | Promise<void>) => {
      onBarrier = value;
    },
    closeFail: () => {
      closeFail = true;
    },
  };
}
test("personal runtime executes, reuses original provenance, edits and force rerun", async () => {
  const s = await setup();
  try {
    const a = await s.runtime.request(s.actor, s.invocation),
      b = await s.runtime.request(s.actor, s.invocation);
    assert.equal(a.kind, "execute");
    assert.equal(b.kind, "reuse");
    assert.equal(b.executionId, a.executionId);
    assert.deepEqual(b.outcome, a.outcome);
    assert.equal(s.count(), 1);
    await writeFile(s.path, "two");
    s.runtime.changed([s.path]);
    const c = await s.runtime.request(s.actor, s.invocation);
    assert.equal(c.kind, "execute");
    assert.equal(c.outcome?.output, "two");
    const d = await s.runtime.request(s.actor, s.invocation, { force: true });
    assert.equal(d.kind, "execute");
    assert.notEqual(d.executionId, c.executionId);
    assert.equal(s.count(), 3);
  } finally {
    await s.runtime.shutdown();
  }
});
test("unsupported command, lost watcher and revoked authority never use cached output", async () => {
  const s = await setup();
  try {
    await s.runtime.request(s.actor, s.invocation);
    assert.equal((await s.runtime.request(s.actor, { ...s.invocation, command: "different" })).kind, "bypass");
    s.healthy(false);
    assert.equal((await s.runtime.request(s.actor, s.invocation)).kind, "bypass");
    s.healthy(true);
    s.permit(false);
    assert.equal((await s.runtime.request(s.actor, s.invocation)).kind, "reject");
    assert.equal(s.count(), 1);
  } finally {
    await s.runtime.shutdown();
  }
});
test("reordered environment cannot reuse a profile qualified for another enumeration", async () => {
  const s = await setup({ Z: "last", A: "first" });
  try {
    const first = await s.runtime.request(s.actor, s.invocation);
    assert.equal(first.kind, "execute");
    assert.equal((await s.runtime.request(s.actor, s.invocation)).kind, "reuse");
    const reordered = await s.runtime.request(s.actor, { ...s.invocation, env: { A: "first", Z: "last" } });
    assert.equal(reordered.kind, "bypass");
    assert.equal(reordered.executionId, undefined);
    assert.equal(s.count(), 1);
  } finally {
    await s.runtime.shutdown();
  }
});
test("known observation loss removes old results even when bytes later match", async () => {
  const s = await setup();
  try {
    const first = await s.runtime.request(s.actor, s.invocation);
    s.healthy(false);
    assert.equal((await s.runtime.request(s.actor, s.invocation)).kind, "bypass");
    s.healthy(true);
    const resumed = await s.runtime.request(s.actor, s.invocation);
    assert.equal(resumed.kind, "execute");
    assert.notEqual(resumed.executionId, first.executionId);
  } finally {
    await s.runtime.shutdown();
  }
});

test("environment differs while touch and unrelated inputs preserve eligible cached output", async () => {
  const s = await setup();
  try {
    await s.runtime.request(s.actor, s.invocation);
    await writeFile(join(s.profile.cwd, "unrelated"), "other");
    s.runtime.changed([join(s.profile.cwd, "unrelated")]);
    assert.equal((await s.runtime.request(s.actor, s.invocation)).kind, "reuse");
    s.runtime.changed([s.path]);
    assert.equal((await s.runtime.request(s.actor, s.invocation)).kind, "reuse");
    assert.equal((await s.runtime.request(s.actor, { ...s.invocation, env: { X: "two" } })).kind, "bypass");
    assert.equal(s.count(), 1);
  } finally {
    await s.runtime.shutdown();
  }
});
test("simultaneous identical requests join; observed undo prevents in-flight publication", async () => {
  const s = await setup();
  let release!: () => void;
  s.hold(
    new Promise((r) => {
      release = r;
    }),
  );
  try {
    const a = s.runtime.request(s.actor, s.invocation),
      b = s.runtime.request(s.actor, s.invocation);
    const deadline = Date.now() + 1000;
    while (!s.count() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    await writeFile(s.path, "two");
    s.runtime.changed([s.path]);
    await writeFile(s.path, "one");
    s.runtime.changed([s.path]);
    release();
    const [one, two] = await Promise.all([a, b]);
    assert.equal(s.count(), 1);
    assert.deepEqual(new Set([one.kind, two.kind]), new Set(["execute", "join"]));
    assert.equal(one.published, false);
    s.hold(undefined);
    assert.equal((await s.runtime.request(s.actor, s.invocation)).kind, "execute");
  } finally {
    release();
    await s.runtime.shutdown();
  }
});
test("catch-up events before acquisition do not force an unrelated-input bypass", async () => {
  const s = await setup();
  try {
    await s.runtime.request(s.actor, s.invocation);
    let first = true;
    s.onBarrier(() => {
      if (first) {
        first = false;
        s.runtime.changed([join(s.profile.cwd, "unrelated")]);
      }
    });
    assert.equal((await s.runtime.request(s.actor, s.invocation)).kind, "reuse");
    assert.equal(s.count(), 1);
  } finally {
    await s.runtime.shutdown();
  }
});

test("revoked queued requester cannot begin filesystem observation", async () => {
  const s = await setup();
  let release!: () => void,
    entered!: () => void,
    calls = 0,
    secondAllowed = true;
  const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    barrierGate = new Promise<void>((resolve) => {
      release = resolve;
    });
  s.onBarrier(async () => {
    if (++calls === 1) {
      entered();
      await barrierGate;
    }
  });
  try {
    const first = s.runtime.request(s.actor, s.invocation);
    await enteredGate;
    const secondActor = s.runtime.attach(() => secondAllowed),
      second = s.runtime.request(secondActor, s.invocation);
    secondAllowed = false;
    release();
    const results = await Promise.all([first, second]);
    assert.equal(results[1].kind, "reject");
    assert.equal(calls, 8, "only the authorized request may run acquisition/check/start/final observation barriers");
  } finally {
    release();
    await s.runtime.shutdown();
  }
});
test("revocation during execution blocks both new streamed bytes and final outcome", async () => {
  const s = await setup();
  let release!: () => void;
  s.hold(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const chunks: Buffer[] = [];
  try {
    const result = s.runtime.request(s.actor, s.invocation, {
      onData: (bytes) => {
        chunks.push(bytes);
      },
    });
    const deadline = Date.now() + 1000;
    while (!s.count() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    s.permit(false);
    release();
    const done = await result;
    assert.equal(done.kind, "reject");
    assert.equal(done.outcome, undefined);
    assert.equal(chunks.length, 0);
  } finally {
    release();
    await s.runtime.shutdown();
  }
});
test("watcher close failure does not skip joining running work", async () => {
  const s = await setup();
  let release!: () => void;
  s.hold(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  s.closeFail();
  const request = s.runtime.request(s.actor, s.invocation);
  const deadline = Date.now() + 1000;
  while (!s.count() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  let settled = false;
  const closing = s.runtime.shutdown().then(
    () => {
      settled = true;
      return undefined;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const premature = settled;
  release();
  const error = await closing;
  await request;
  assert.equal(premature, false, "failed watcher close must still join owned running work");
  assert.ok(error instanceof AggregateError);
  assert.match(String(error.errors[0]), /watcher close failed/);
});

test("clear removes reusable state and restart starts cold", async () => {
  const s = await setup();
  try {
    await s.runtime.request(s.actor, s.invocation);
    s.runtime.clear();
    assert.equal((await s.runtime.request(s.actor, s.invocation)).kind, "execute");
    assert.equal(s.count(), 2);
  } finally {
    await s.runtime.shutdown();
  }
});
