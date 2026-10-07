import assert from "node:assert/strict";
import { after, test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PersonalCacheRuntime } from "../src/products/cache-personal-runtime.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
async function setup(env = { X: "one" } as Record<string, string>) {
  const cwd = await tempDir("cache-normal"),
    path = join(cwd, "input");
  await writeFile(path, "one");
  const invocation = { cwd, shell: "/bin/bash", command: "explicit", env, timeoutMs: 3000 };
  const output = { bytes: 8192, itemBytes: 4096, payloads: 8, deliveries: 8 };
  let fresh = false,
    allowed = true,
    starts = 0,
    barrierWait: Promise<void> | undefined;
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
        inputs: [{ path, kind: "file" }],
      },
    ],
    graph: { workspaces: 1, observations: 4, entries: 4, runs: 4, edges: 16, keyBytes: 128, output },
    scheduler: {
      running: 1,
      pending: 1,
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
    barrier: async () => {
      await barrierWait;
      return { clock: "c:1:1", epoch: 0, changed: [], fresh };
    },
    closeInputs: async () => {},
    start: async (_, options) => {
      starts++;
      await options.onData(Buffer.from("fresh"));
      const outcome = Promise.resolve({
        output: "fresh",
        exitCode: 7,
        signal: null,
        cancelled: false,
        timedOut: false,
        complete: true,
        startedAt: "2026-10-05T00:00:00Z",
        endedAt: "2026-10-05T00:00:01Z",
      });
      return {
        outcome,
        exited: outcome.then(() => {}),
        stop: async () => {
          await outcome;
        },
      };
    },
  });
  const actor = runtime.attach(() => allowed);
  return {
    runtime,
    actor,
    invocation,
    count: () => starts,
    permit: (v: boolean) => {
      allowed = v;
    },
    healthy: () => {
      fresh = true;
    },
    holdBarrier: (gate: Promise<void>) => {
      barrierWait = gate;
    },
  };
}
test("known uncertainty grants one-use same-invocation no-start receipt for bounded normal execution", async () => {
  const s = await setup();
  try {
    const missed = await s.runtime.request(s.actor, s.invocation);
    assert.equal(missed.kind, "bypass");
    assert.equal(s.count(), 0);
    const chunks: Buffer[] = [];
    const ordinary = await s.runtime.uncached(s.actor, s.invocation, missed, {
      onData: (b) => {
        chunks.push(b);
      },
    });
    assert.equal(ordinary.kind, "execute");
    assert.equal(ordinary.outcome?.exitCode, 7);
    assert.equal(ordinary.published, false);
    assert.equal(s.count(), 1);
    assert.equal(Buffer.concat(chunks).toString(), "fresh");
    assert.equal((await s.runtime.uncached(s.actor, s.invocation, missed)).kind, "reject");
    assert.equal(s.count(), 1);
    const next = await s.runtime.request(s.actor, s.invocation);
    assert.equal(next.kind, "bypass");
    await s.runtime.uncached(s.actor, s.invocation, next);
    assert.equal(s.count(), 2);
  } finally {
    await s.runtime.shutdown();
  }
});
test("JSON receipt, changed invocation, foreign actor and revoked authority cannot authorize fallback", async () => {
  const s = await setup();
  try {
    const missed = await s.runtime.request(s.actor, s.invocation);
    assert.equal((await s.runtime.uncached(s.actor, s.invocation, { ...missed })).kind, "reject");
    assert.equal((await s.runtime.uncached(s.actor, { ...s.invocation, command: "other" }, missed)).kind, "reject");
    const other = s.runtime.attach(() => true);
    assert.equal((await s.runtime.uncached(other, s.invocation, missed)).kind, "reject");
    s.permit(false);
    assert.equal((await s.runtime.uncached(s.actor, s.invocation, missed)).kind, "reject");
    assert.equal(s.count(), 0);
  } finally {
    await s.runtime.shutdown();
  }
});
test("reordered environment cannot consume an exact no-start receipt", async () => {
  const s = await setup({ Z: "last", A: "first" });
  try {
    const missed = await s.runtime.request(s.actor, s.invocation);
    assert.equal(missed.kind, "bypass");
    const result = await s.runtime.uncached(s.actor, { ...s.invocation, env: { A: "first", Z: "last" } }, missed);
    assert.equal(result.kind, "reject");
    assert.equal(s.count(), 0);
  } finally {
    await s.runtime.shutdown();
  }
});
test("shutdown retirement is idempotent only for runtime-issued actors", async () => {
  const s = await setup();
  await s.runtime.shutdown();
  assert.doesNotThrow(() => s.runtime.disconnect(s.actor));
  assert.doesNotThrow(() => s.runtime.disconnect(s.actor));
  assert.throws(() => s.runtime.disconnect({} as typeof s.actor), /foreign/);
});
test("normal execution cannot outrun late input cleanup after capture deadline", async () => {
  const s = await setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  s.healthy();
  s.holdBarrier(gate);
  try {
    const receipt = await s.runtime.request(s.actor, s.invocation);
    assert.equal(receipt.kind, "bypass");
    const fresh = s.runtime.uncached(s.actor, s.invocation, receipt);
    for (let n = 0; n < 5; n++) await new Promise<void>((r) => setImmediate(r));
    assert.equal(s.count(), 0, "late snapshot owner stays charged before ordinary execution");
    assert.equal(s.runtime.stats().captures, 1);
    release();
    assert.equal((await fresh).kind, "execute");
    assert.equal(s.count(), 1);
  } finally {
    release();
    await s.runtime.shutdown();
  }
});
