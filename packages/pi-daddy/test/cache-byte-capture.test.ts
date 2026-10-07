/** Actual local FD operations with FAKE guards: sequencing/ownership tests, never OS source proof. */
import assert from "node:assert/strict";
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { fstatSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { captureByteVector, ByteCaptureCleanupError } from "../src/executors/cache-byte-capture.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
import type { CacheLeaseAcquisition } from "../src/executors/cache-lease-bridge.ts";
after(cleanupTempDirs);
const limits = { maxFiles: 4, maxFileBytes: 200_000, maxTotalBytes: 400_000, timeoutMs: 2000 };
async function input(bytes = "input") {
  const root = await tempDir("byte-capture-unit-");
  const path = join(root, "file");
  await writeFile(path, bytes);
  const file = await open(path, "r"),
    info = await file.stat({ bigint: true });
  return { file, path, spec: { fd: file.fd, dev: info.dev, ino: info.ino } };
}
function guards() {
  const calls: string[] = [],
    fds: number[] = [];
  let broken = false,
    count = 0;
  return {
    calls,
    fds,
    break() {
      broken = true;
    },
    restore() {
      broken = false;
    },
    async acquire(fd: number): Promise<CacheLeaseAcquisition> {
      const id = String(++count);
      calls.push(`acquire:${id}`);
      fds.push(fd);
      return {
        ok: true,
        lease: {
          id,
          async check() {
            calls.push(`check:${id}`);
            return !broken;
          },
          async release() {
            calls.push(`release:${id}`);
          },
        },
      };
    },
  };
}
function closed(fds: number[]) {
  for (const fd of fds) assert.throws(() => fstatSync(fd), { code: "EBADF" });
}

test("owns readonly copies; all guards acquired before reads; immutable metadata and copied bytes", async () => {
  const a = await input("alpha"),
    b = await input("beta"),
    g = guards();
  const proto = Object.getPrototypeOf(a.file),
    original = proto.read;
  const spy = mock.method(proto, "read", async function (this: typeof a.file, ...args: unknown[]) {
    if (g.fds.includes(this.fd)) {
      assert.ok(g.calls.includes("acquire:2"));
      g.calls.push("read");
    }
    return Reflect.apply(original, this, args);
  });
  try {
    const result = await captureByteVector({ inputs: [a.spec, b.spec], leases: g, limits });
    if (result.kind !== "captured") assert.fail(result.reason);
    const c = result.capture;
    try {
      await a.file.close();
      await b.file.close();
      assert.equal(c.copyCapturedBytes(0).toString(), "alpha");
      const copy = c.copyCapturedBytes(0);
      copy.fill(0);
      assert.equal(c.copyCapturedBytes(0).toString(), "alpha");
      assert.equal(c.items[0].sha256, createHash("sha256").update("alpha").digest("hex"));
      assert.ok(Object.isFrozen(c.items) && Object.isFrozen(c.items[0]));
      assert.equal("eligible" in c, false);
      assert.equal(await c.guardsUnbroken(), true);
    } finally {
      await c.release();
    }
    await c.release();
    closed(g.fds);
    assert.throws(() => c.copyCapturedBytes(0), /released|retired/);
  } finally {
    spy.mock.restore();
    await a.file.close();
    await b.file.close();
  }
});

test("borrowed FD closure/reuse during acquisition cannot redirect owned reads or inherited offsets", async () => {
  const a = await input("original"),
    b = await input("replacement"),
    g = guards();
  let reused: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await b.file.close();
    const leases = {
      async acquire(fd: number) {
        const result = await g.acquire(fd);
        const borrowed = a.file.fd;
        await a.file.close();
        reused = await open(b.path, "r");
        assert.equal(reused.fd, borrowed, "control actually reuses the borrowed numeric descriptor");
        return result;
      },
    };
    const result = await captureByteVector({ inputs: [a.spec], leases, limits });
    if (result.kind !== "captured") assert.fail(result.reason);
    try {
      assert.equal(result.capture.copyCapturedBytes(0).toString(), "original");
    } finally {
      await result.capture.release();
    }
    closed(g.fds);
    assert.equal((await reused!.readFile()).toString(), "replacement", "capture must not consume caller offset");
  } finally {
    await a.file.close();
    await b.file.close();
    if (reused) await reused.close();
  }
});

test("lost guard retires copies permanently even when fake validity or bytes are restored", async () => {
  const a = await input(),
    g = guards();
  try {
    const r = await captureByteVector({ inputs: [a.spec], leases: g, limits });
    if (r.kind !== "captured") assert.fail(r.reason);
    try {
      g.break();
      assert.equal(await r.capture.guardsUnbroken(), false);
      g.restore();
      assert.equal(await r.capture.guardsUnbroken(), false);
      assert.throws(() => r.capture.copyCapturedBytes(0), /retired/);
    } finally {
      await r.capture.release();
    }
    closed(g.fds);
  } finally {
    await a.file.close();
  }
});

test("partial admission refusal releases earlier guard and owned descriptors", async () => {
  const a = await input(),
    b = await input(),
    g = guards();
  try {
    const leases = {
      async acquire(fd: number) {
        if (g.fds.length) return { ok: false as const, reason: "LEASE: 11" };
        return g.acquire(fd);
      },
    };
    const r = await captureByteVector({ inputs: [a.spec, b.spec], leases, limits });
    assert.equal(r.kind, "bypass");
    if (r.kind === "bypass") assert.match(r.reason, /LEASE: 11/);
    assert.ok(g.calls.includes("release:1"));
    closed(g.fds);
  } finally {
    await a.file.close();
    await b.file.close();
  }
});

test("per-file, total and descriptor budgets reject without producing a vector", async () => {
  const a = await input("1234"),
    b = await input("1234");
  try {
    for (const bound of [{ maxFileBytes: 3 }, { maxTotalBytes: 7 }, { maxFiles: 1 }]) {
      const g = guards(),
        r = await captureByteVector({ inputs: [a.spec, b.spec], leases: g, limits: { ...limits, ...bound } });
      assert.equal(r.kind, "bypass");
      closed(g.fds);
    }
    const g = guards(),
      r = await captureByteVector({
        inputs: [a.spec, b.spec],
        leases: g,
        limits: { ...limits, maxFileBytes: 4, maxTotalBytes: 8, maxFiles: 2 },
      });
    if (r.kind !== "captured") assert.fail(r.reason);
    await r.capture.release();
    closed(g.fds);
  } finally {
    await a.file.close();
    await b.file.close();
  }
});

test("invalid/missing named limits and unsupported memory ceilings refuse before descriptor I/O", async () => {
  const g = guards();
  const inputs = [{ fd: 987654321, dev: 1n, ino: 1n }];
  for (const field of ["maxFiles", "maxFileBytes", "maxTotalBytes", "timeoutMs"] as const) {
    for (const value of [undefined, 0, -1, NaN, Infinity, 1.5]) {
      const bad = { ...limits, [field]: value } as typeof limits;
      const result = await captureByteVector({ inputs, leases: g, limits: bad });
      assert.equal(result.kind, "bypass");
      if (result.kind === "bypass") assert.match(result.reason, new RegExp(field));
    }
  }
  const huge = await captureByteVector({ inputs, leases: g, limits: { ...limits, maxTotalBytes: 33 * 1024 * 1024 } });
  assert.equal(huge.kind, "bypass");
  assert.deepEqual(g.calls, []);
});

test("stale descriptor identity and nonregular descriptor are refused before guard acquisition", async () => {
  const a = await input(),
    dir = await open(await tempDir("byte-capture-directory-"), "r"),
    g = guards();
  try {
    const st = await dir.stat({ bigint: true });
    for (const spec of [
      { ...a.spec, ino: a.spec.ino + 1n },
      { fd: dir.fd, dev: st.dev, ino: st.ino },
    ]) {
      const r = await captureByteVector({ inputs: [spec], leases: g, limits });
      assert.equal(r.kind, "bypass");
    }
    assert.deepEqual(g.fds, []);
  } finally {
    await a.file.close();
    await dir.close();
  }
});

test("same physical inode aliases share a guard while retaining ordered copies", async () => {
  const a = await input(),
    g = guards();
  try {
    const r = await captureByteVector({ inputs: [a.spec, a.spec], leases: g, limits });
    if (r.kind !== "captured") assert.fail(r.reason);
    try {
      assert.equal(r.capture.items.length, 2);
      assert.equal(g.fds.length, 1);
      assert.deepEqual(r.capture.copyCapturedBytes(0), r.capture.copyCapturedBytes(1));
    } finally {
      await r.capture.release();
    }
    closed(g.fds);
  } finally {
    await a.file.close();
  }
});

test("abort during admission and timeout between read chunks clean up, not pretend a hard I/O deadline", async () => {
  const a = await input("x".repeat(150_000)),
    g = guards(),
    abort = new AbortController();
  try {
    const leases = {
      async acquire(fd: number) {
        const r = await g.acquire(fd);
        abort.abort();
        return r;
      },
    };
    const r = await captureByteVector({ inputs: [a.spec], leases, limits, signal: abort.signal });
    assert.equal(r.kind, "bypass");
    closed(g.fds);
    let now = 0;
    const timed = await captureByteVector({
      inputs: [a.spec],
      leases: guards(),
      limits: { ...limits, timeoutMs: 7 },
      now: () => ++now,
    });
    assert.equal(timed.kind, "bypass");
    if (timed.kind === "bypass") assert.match(timed.reason, /time/);
  } finally {
    await a.file.close();
  }
});

test("deadline expiry inside the final digest refuses capture and releases guards (REV-001)", async () => {
  const a = await input(),
    g = guards();
  let clock = 0;
  const original = crypto.createHash;
  const spy = mock.method(crypto, "createHash", (...args: Parameters<typeof original>) => {
    const hash = original(...args),
      digest = hash.digest.bind(hash);
    mock.method(hash, "digest", (...digestArgs: unknown[]) => {
      const result = Reflect.apply(digest, hash, digestArgs);
      clock = 11;
      return result;
    });
    return hash;
  });
  syncBuiltinESMExports();
  let result: Awaited<ReturnType<typeof captureByteVector>> | undefined;
  try {
    result = await captureByteVector({
      inputs: [a.spec],
      leases: g,
      limits: { ...limits, timeoutMs: 10 },
      now: () => clock,
    });
    assert.equal(result.kind, "bypass");
    if (result.kind === "bypass") assert.match(result.reason, /time budget/);
    assert.ok(g.calls.includes("release:1"));
    closed(g.fds);
  } finally {
    if (result?.kind === "captured") await result.capture.release();
    spy.mock.restore();
    syncBuiltinESMExports();
    await a.file.close();
  }
});

test("cleanup failure surfaces an owned retry capability; retry cannot restore capture delivery", async () => {
  const a = await input(),
    g = guards();
  let failRelease = true;
  try {
    const leases = {
      async acquire(fd: number) {
        const r = await g.acquire(fd);
        if (!r.ok) return r;
        return {
          ok: true as const,
          lease: {
            ...r.lease,
            async release() {
              if (failRelease) throw new Error("release fault");
              await r.lease.release();
            },
          },
        };
      },
    };
    const r = await captureByteVector({ inputs: [a.spec], leases, limits });
    if (r.kind !== "captured") assert.fail(r.reason);
    await assert.rejects(
      r.capture.release(),
      (e: unknown) => e instanceof ByteCaptureCleanupError && /cleanup unresolved/.test(e.message),
    );
    assert.throws(() => r.capture.copyCapturedBytes(0), /released|retired/);
    failRelease = false;
    await r.capture.release();
    closed(g.fds);
    let captured: ByteCaptureCleanupError | undefined;
    failRelease = true;
    const broken = {
      async acquire(fd: number) {
        const result = await leases.acquire(fd);
        g.break();
        return result;
      },
    };
    try {
      await captureByteVector({ inputs: [a.spec], leases: broken, limits });
    } catch (e) {
      assert.ok(e instanceof ByteCaptureCleanupError);
      captured = e;
    }
    assert.ok(captured);
    failRelease = false;
    await captured.cleanup();
    closed(g.fds);
  } finally {
    mock.restoreAll();
    await a.file.close();
  }
});
