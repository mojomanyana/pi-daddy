import assert from "node:assert/strict";
import { constants, fstatSync } from "node:fs";
import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import * as reader from "../src/kernel/bounded-read.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);

// Enduring requirement: close failure is unresolved resource ownership, never valid data or absence.
// Real handles plus per-read trusted ports force faults without modifying Node's global operations.
type CleanupError = reader.BoundedReadCleanupError;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { promise, resolve };
}
async function fixture() {
  const dir = await tempDir("bounded-close-");
  const path = join(dir, "input");
  await writeFile(path, "actual bytes");
  let handle: FileHandle | undefined;
  const ports = {
    async open(name: string, flags: number) {
      assert.equal(flags, constants.O_RDONLY | constants.O_NONBLOCK);
      handle = await open(name, flags);
      return handle;
    },
    read: (fd: FileHandle, buffer: Buffer, offset: number, length: number, position: number) =>
      fd.read(buffer, offset, length, position),
    close: (fd: FileHandle) => fd.close(),
  };
  return {
    path,
    ports,
    handle: () => {
      assert.ok(handle);
      return handle;
    },
    async dispose() {
      if (handle && handle.fd !== -1) await handle.close();
      assert.equal(handle?.fd, -1, "all fixture handles must be closed before directory cleanup");
    },
  };
}
const limits = { maxBytes: 128, timeoutMs: 1000 };

test("pending acquisition/read remain owned and early cleanup joins them before closing", async () => {
  const f = await fixture(),
    opened = gate(),
    allowOpen = gate(),
    reading = gate(),
    allowRead = gate();
  const before = new Set(reader.retainedBoundedReadCleanups());
  let closes = 0,
    result: Promise<reader.BoundedReadResult> | undefined;
  try {
    result = reader.readBoundedFile(f.path, limits, {
      ...f.ports,
      async open(path, flags) {
        opened.resolve();
        await allowOpen.promise;
        return f.ports.open(path, flags);
      },
      async read(...args) {
        reading.resolve();
        await allowRead.promise;
        return f.ports.read(...args);
      },
      async close(handle) {
        closes++;
        await handle.close();
      },
    });
    await opened.promise;
    const owners = reader.retainedBoundedReadCleanups().filter((owner) => !before.has(owner));
    assert.equal(owners.length, 1, "pending open must be strongly charged before it returns a handle");
    let cleaned = false;
    const early = owners[0].cleanup().then(() => {
      cleaned = true;
    });
    await Promise.resolve();
    assert.equal(cleaned, false);
    allowOpen.resolve();
    await reading.promise;
    assert.equal(owners[0].handle, f.handle());
    assert.equal(closes, 0, "never close a pending read");
    assert.equal(cleaned, false);
    allowRead.resolve();
    assert.deepEqual(await result, { ok: true, text: "actual bytes" });
    await early;
    assert.equal(closes, 1);
    assert.equal(f.handle().fd, -1);
    assert.deepEqual(reader.retainedBoundedReadCleanups(), [...before]);
  } finally {
    allowOpen.resolve();
    allowRead.resolve();
    // Let the actual owned operation settle even when a regression assertion fails.
    await result;
    await f.dispose();
  }
});

for (const cause of [new Error("transient close"), undefined, null, false, 0, ""]) {
  test(`first close rejection (${String(cause)}) fails the read and retains the exact descriptor`, async () => {
    const f = await fixture();
    let closes = 0;
    try {
      const read = reader.readBoundedBytes(f.path, limits, {
        ...f.ports,
        async close(handle) {
          assert.equal(handle, f.handle());
          if (++closes === 1) throw cause;
          await handle.close();
        },
      });
      let failure!: CleanupError;
      await assert.rejects(read, (error: CleanupError) => {
        assert.equal(error.name, "BoundedReadCleanupError");
        assert.equal(error.cause, cause);
        failure = error;
        return true;
      });
      assert.equal(closes, 1, "no implicit retry after a transient failure");
      const handle = f.handle(),
        fd = handle.fd;
      assert.ok(fstatSync(fd).isFile(), "real FD is still open");
      assert.ok(reader.retainedBoundedReadCleanups().some((owner) => owner.handle === handle));
      await failure.cleanup();
      assert.ok(!reader.retainedBoundedReadCleanups().some((owner) => owner.handle === handle));
      assert.equal(closes, 2);
      assert.equal(handle.fd, -1);
      assert.throws(() => fstatSync(fd), { code: "EBADF" });
      await assert.rejects(read, (error) => error === failure, "successful retry cannot rewrite the read");
      await failure.cleanup();
      assert.equal(closes, 2, "released handle is never closed again");
    } finally {
      await f.dispose();
    }
  });
}

test("persistent cleanup failure remains owned; concurrent explicit retries never overlap a close", async () => {
  const f = await fixture(),
    entered = gate(),
    release = gate();
  const cause = Object.assign(new Error("close failed"), { code: "ENOENT" });
  let closes = 0,
    active = 0,
    peak = 0,
    failure!: CleanupError;
  try {
    const read = reader.readBoundedFile(f.path, limits, {
      ...f.ports,
      async close(handle) {
        closes++;
        peak = Math.max(peak, ++active);
        try {
          if (closes === 2) {
            entered.resolve();
            await release.promise;
          }
          if (closes <= 2) throw cause;
          await handle.close();
        } finally {
          active--;
        }
      },
    });
    await assert.rejects(read, (error: CleanupError) => {
      assert.equal(error.name, "BoundedReadCleanupError");
      assert.equal(error.cause, cause);
      failure = error;
      return true;
    });
    const retry = failure.cleanup();
    await entered.promise;
    const concurrent = failure.cleanup();
    assert.equal(closes, 2);
    assert.equal(peak, 1);
    assert.ok(fstatSync(f.handle().fd).isFile());
    release.resolve();
    await assert.rejects(retry, (error) => error === failure);
    await assert.rejects(concurrent, (error) => error === failure);
    assert.equal(closes, 2);
    await failure.cleanup();
    assert.equal(closes, 3);
    assert.equal(peak, 1);
    assert.equal(f.handle().fd, -1);
    await assert.rejects(read, (error) => error === failure);
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test("a pending first close is strongly owned and recovery joins it; later failures stay detectable", async () => {
  const f = await fixture(),
    entered = gate(),
    release = gate();
  const before = new Set(reader.retainedBoundedReadCleanups());
  const first = { close: "unknown failure" },
    later = false;
  let closes = 0,
    failure!: CleanupError,
    result: Promise<reader.BoundedReadBytes> | undefined;
  try {
    result = reader.readBoundedBytes(f.path, limits, {
      ...f.ports,
      async close(handle) {
        closes++;
        if (closes === 1) {
          entered.resolve();
          await release.promise;
          throw first;
        }
        if (closes === 2) throw later;
        await handle.close();
      },
    });
    await entered.promise;
    const owners = reader.retainedBoundedReadCleanups().filter((owner) => !before.has(owner));
    assert.equal(owners.length, 1);
    assert.equal(owners[0].handle, f.handle());
    const joined = owners[0].cleanup();
    assert.equal(closes, 1, "explicit cleanup may not overlap the pending first close");
    release.resolve();
    await assert.rejects(result, (error: CleanupError) => {
      assert.equal(error.cause, first);
      failure = error;
      return true;
    });
    await assert.rejects(joined, (error) => error === failure);
    await assert.rejects(failure.cleanup(), (error) => error === failure);
    assert.equal(failure.cause, first);
    assert.equal(failure.lastCause, later, "do not discard a distinct/falsy retry failure");
    assert.equal(closes, 2);
    await failure.cleanup();
    assert.equal(f.handle().fd, -1);
    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(reader.retainedBoundedReadCleanups(), [...before]);
  } finally {
    release.resolve();
    if (result) await result.catch(() => {}); // The rejection is asserted above; settle before fixture disposal.
    if (failure) await failure.cleanup();
    await f.dispose();
  }
});

test("close failure overrides ordinary read ENOENT instead of becoming typed absence", async () => {
  const f = await fixture(),
    closeCause = new Error("cleanup failed");
  let failure!: CleanupError,
    refusing = true;
  try {
    await assert.rejects(
      reader.readBoundedBytes(f.path, limits, {
        ...f.ports,
        async read() {
          throw Object.assign(new Error("read vanished"), { code: "ENOENT" });
        },
        async close(handle) {
          if (refusing) throw closeCause;
          await handle.close();
        },
      }),
      (error: CleanupError) => {
        assert.equal(error.name, "BoundedReadCleanupError");
        assert.equal(error.cause, closeCause);
        failure = error;
        return true;
      },
    );
    assert.ok(fstatSync(f.handle().fd).isFile());
    await assert.rejects(failure.cleanup(), (error) => error === failure);
    refusing = false;
    await failure.cleanup();
    assert.equal(f.handle().fd, -1);
  } finally {
    await f.dispose();
  }
});
