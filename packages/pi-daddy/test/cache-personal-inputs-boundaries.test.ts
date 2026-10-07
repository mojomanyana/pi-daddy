import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { Dir } from "node:fs";
import { mkdir, open, readlink, rename, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, mock, test } from "node:test";
import { PersonalInputCleanupError, snapshotPersonalInputs } from "../src/executors/cache-personal-inputs.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
const limits = { paths: 8, bytes: 4096, entries: 8, ms: 1000 };
const barrier = async () => ({ clock: "c:1:1", epoch: 0, changed: [], fresh: true });
async function capture(path: string, kind: "file" | "directory" = "file") {
  return snapshotPersonalInputs({ inputs: [{ path, kind }], limits, barrier });
}
test("unsupported raw-byte directory names bypass rather than collide", async () => {
  const dir = await tempDir("cache-personal-bytes");
  const name = Buffer.concat([Buffer.from(dir + "/"), Buffer.from([0x80])]);
  await writeFile(name, "one");
  assert.equal((await capture(dir, "directory")).kind, "bypass");
});
test("unsupported raw-byte symlink targets bypass rather than manufacture absence", async () => {
  const dir = await tempDir("cache-personal-links"),
    path = join(dir, "link");
  await symlink(Buffer.from([0x80]), path);
  assert.equal((await capture(path)).kind, "bypass");
});
test("trailing slashes in declarations and symlink targets require directories", async () => {
  const dir = await tempDir("cache-personal-slash"),
    file = join(dir, "file");
  await writeFile(file, "one");
  await symlink("file/", join(dir, "link"));
  assert.equal((await capture(file + "/")).kind, "bypass");
  assert.equal((await capture(join(dir, "link"))).kind, "bypass");
});
test("pending barrier cancellation returns bypass and exposes outstanding cleanup", async () => {
  const dir = await tempDir("cache-personal-pending"),
    path = join(dir, "input");
  await writeFile(path, "one");
  let release!: (value: Awaited<ReturnType<typeof barrier>>) => void;
  const gate = new Promise<Awaited<ReturnType<typeof barrier>>>((resolve) => {
    release = resolve;
  });
  const control = new AbortController();
  const pending = snapshotPersonalInputs({
    inputs: [{ path, kind: "file" }],
    limits,
    barrier: () => gate,
    signal: control.signal,
  });
  control.abort();
  const value = await Promise.race([
    pending,
    new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 100)),
  ]);
  release(await barrier());
  assert.notEqual(value, "still pending");
  assert.ok(typeof value !== "string");
  if (typeof value !== "string") {
    assert.equal(value.kind, "bypass");
    if (value.kind === "bypass") await value.cleanup;
  }
});
test("pending barrier deadline returns bypass rather than hanging normal execution", async () => {
  const dir = await tempDir("cache-personal-deadline");
  let release!: (value: Awaited<ReturnType<typeof barrier>>) => void;
  const gate = new Promise<Awaited<ReturnType<typeof barrier>>>((resolve) => {
    release = resolve;
  });
  const pending = snapshotPersonalInputs({
    inputs: [{ path: dir, kind: "directory" }],
    limits: { ...limits, ms: 10 },
    barrier: () => gate,
  });
  const value = await Promise.race([
    pending,
    new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 100)),
  ]);
  release(await barrier());
  assert.notEqual(value, "still pending");
  assert.ok(typeof value !== "string");
  if (typeof value !== "string") {
    assert.equal(value.kind, "bypass");
    if (value.kind === "bypass") await value.cleanup;
  }
});
test("FIFO and looping symlinks bypass without blocking or following forever", async () => {
  const dir = await tempDir("cache-personal-special"),
    path = join(dir, "fifo");
  await promisify(execFile)("mkfifo", [path]);
  assert.equal((await capture(path)).kind, "bypass");
  await symlink("loop", join(dir, "loop"));
  assert.equal((await capture(join(dir, "loop"))).kind, "bypass");
});
test("cancelled pending file read retains its descriptor until joined cleanup", async () => {
  const dir = await tempDir("cache-personal-late"),
    path = join(dir, "input");
  await writeFile(path, "one");
  const probe = await open(path, "r"),
    prototype = Object.getPrototypeOf(probe);
  const original = prototype.read as (...args: unknown[]) => Promise<unknown>;
  let release!: () => void,
    entered!: () => void,
    fd = -1;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admission = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const replacement = mock.method(prototype, "read", async function (this: FileHandle, ...args: unknown[]) {
    fd = this.fd;
    entered();
    await gate;
    return original.apply(this, args);
  });
  const control = new AbortController();
  try {
    const pending = snapshotPersonalInputs({
      inputs: [{ path, kind: "file" }],
      limits,
      barrier,
      signal: control.signal,
    });
    await admission;
    control.abort();
    const result = await pending;
    assert.equal(result.kind, "bypass");
    assert.ok(fd >= 0);
    await readlink(`/proc/self/fd/${fd}`);
    release();
    if (result.kind === "bypass") await result.cleanup;
    await assert.rejects(readlink(`/proc/self/fd/${fd}`), { code: "ENOENT" });
  } finally {
    release();
    replacement.mock.restore();
    await probe.close();
  }
});

test("BOM-prefixed names and symlink targets retain literal UTF-8 identity", async () => {
  const dir = await tempDir("cache-personal-bom"),
    bom = "\uFEFFinput",
    path = join(dir, bom);
  await writeFile(path, "one");
  const first = await capture(dir, "directory");
  await rename(path, join(dir, "input"));
  const second = await capture(dir, "directory");
  assert.equal(first.kind, "observed");
  assert.equal(second.kind, "observed");
  if (first.kind === "observed" && second.kind === "observed") assert.notEqual(first.fingerprint, second.fingerprint);
  await writeFile(path, "one");
  await symlink(bom, join(dir, "link"));
  const linked = await capture(join(dir, "link"));
  await writeFile(path, "two");
  const changed = await capture(join(dir, "link"));
  assert.equal(linked.kind, "observed");
  assert.equal(changed.kind, "observed");
  if (linked.kind === "observed" && changed.kind === "observed")
    assert.notEqual(linked.fingerprint, changed.fingerprint);
});

test("directory close failure retains its owner and never certifies cleanup", async () => {
  const dir = await tempDir("cache-personal-close");
  let failed: Dir | undefined;
  const original = Dir.prototype.close;
  const replacement = mock.method(
    Dir.prototype,
    "close",
    function (this: Dir, callback?: (error?: NodeJS.ErrnoException | null) => void) {
      if (this.path === dir) {
        failed = this;
        const error = Error("synthetic directory close failure");
        if (callback) {
          queueMicrotask(() => callback(error));
          return;
        }
        return Promise.reject(error);
      }
      return new Promise<void>((resolve, reject) =>
        original.call(this, (error) => (error ? reject(error) : resolve())),
      );
    },
  );
  try {
    const value = await capture(dir, "directory");
    assert.equal(value.kind, "bypass");
    if (value.kind === "bypass") await assert.rejects(value.cleanup, PersonalInputCleanupError);
    assert.ok(failed);
  } finally {
    replacement.mock.restore();
    if (failed)
      await new Promise<void>((resolve, reject) =>
        original.call(failed!, (error) => (error ? reject(error) : resolve())),
      );
  }
});

test("final changed entries bypass even without a changed epoch", async () => {
  const dir = await tempDir("cache-personal-final");
  await mkdir(join(dir, "child"));
  let calls = 0;
  assert.equal(
    (
      await snapshotPersonalInputs({
        inputs: [{ path: dir, kind: "directory" }],
        limits,
        barrier: async () => ({ ...(await barrier()), changed: calls++ ? ["child"] : [] }),
      })
    ).kind,
    "bypass",
  );
});
