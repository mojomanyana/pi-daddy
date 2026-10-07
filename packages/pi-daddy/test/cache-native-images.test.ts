import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { constants } from "node:fs";
import { CacheNativeImages } from "../src/executors/cache-native-images.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
const bytes = Buffer.from("trusted fixture image bytes"),
  sha256 = createHash("sha256").update(bytes).digest("hex");
async function fixture(extra: Partial<ConstructorParameters<typeof CacheNativeImages>[0]> = {}) {
  const directory = await tempDir("cache-images-");
  return new CacheNativeImages({
    directory,
    image: bytes,
    sha256,
    socket: "/tmp/fixture-socket",
    admissionMs: 100,
    maxLeases: 2,
    maxImageBytes: 1024,
    maxStorageBytes: 20000,
    ...extra,
  });
}
test("private independent images and exact CF1 sidecars are owned through explicit lease retirement", async () => {
  const source = Buffer.from(bytes);
  const store = await fixture({ image: source });
  source.fill(0);
  const a = (await store.allocate("/bin/bash"))!,
    b = (await store.allocate("/bin/sh"))!;
  assert.ok(a);
  assert.ok(b);
  assert.notEqual(a.shellPath, b.shellPath);
  const root = dirname(a.shellPath);
  try {
    assert.deepEqual(await fs.readFile(a.shellPath), bytes);
    assert.equal(await fs.readFile(a.shellPath + ".config", "utf8"), "CF1\n/bin/bash\n/tmp/fixture-socket\n100\n");
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(a.shellPath)).mode & 0o777, 0o500);
    assert.equal((await fs.stat(a.shellPath + ".config")).mode & 0o777, 0o600);
    assert.equal(a.image.ino, String((await fs.stat(a.shellPath, { bigint: true })).ino));
    assert.equal(store.stats().owned, 2);
    const excess = store.allocate("/bin/bash");
    void excess.then((value) => value?.close()).catch(() => {});
    await assert.rejects(excess, /bound/);
    await a.close();
    await a.close();
    assert.equal(store.stats().owned, 1);
    assert.deepEqual(await fs.readFile(b.shellPath), bytes);
  } finally {
    await a.close();
    await b.close();
    await store.close();
  }
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
});
test("shutdown does not unpublish a delivered image before its native consumer retires", async () => {
  const store = await fixture(),
    lease = (await store.allocate("/bin/bash"))!;
  let settled = false;
  const closing = store.close().then(() => {
    settled = true;
  });
  try {
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(settled, false);
    assert.deepEqual(await fs.readFile(lease.shellPath), bytes);
    await assert.rejects(store.allocate("/bin/bash"), /closed/);
  } finally {
    await lease.close();
    await closing;
  }
});
test("known unsupported CF1 shell or initial cancellation certifies resource-free bypass", async () => {
  const store = await fixture();
  try {
    for (const shell of ["relative", "/line\nbreak", "/nul\0path", "/" + "a".repeat(4095)])
      assert.equal(await store.allocate(shell), undefined);
    assert.equal(await store.allocate("/bin/bash", AbortSignal.abort()), undefined);
    assert.equal(store.stats().owned, 0);
  } finally {
    await store.close();
  }
});
test("bad trusted digest, limits and sidecar settings fail before filesystem publication", async () => {
  for (const extra of [
    { sha256: "0".repeat(64) },
    { maxLeases: 0 },
    { maxImageBytes: 1 },
    { maxStorageBytes: 0 },
    { socket: "/" + "x".repeat(107) },
    { admissionMs: 0 },
  ])
    await assert.rejects(fixture(extra), /cache native image/);
});
test("partial publication and shutdown keep an awaited write charged until cleanup settles", async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const files = {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      return new Proxy(handle, {
        get(t, p) {
          if (p === "writeFile")
            return async (...a: Parameters<typeof handle.writeFile>) => {
              entered();
              await gate;
              return t.writeFile(...a);
            };
          const v = Reflect.get(t, p, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    },
  };
  const store = await fixture({ files }),
    pending = store.allocate("/bin/bash");
  await ready;
  let settled = false;
  const closing = store.close().then(() => {
    settled = true;
  });
  try {
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(settled, false);
    assert.equal(store.stats().owned, 1);
  } finally {
    release();
    const lease = await pending;
    if (lease) await lease.close();
    await closing;
  }
  assert.equal(await pending, undefined);
  assert.equal(store.stats().owned, 0);
});
test("failed file close remains owned and admission-faulted with explicit cleanup retry", async () => {
  let fail = false;
  const files = {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (typeof args[1] === "number" && args[1] & constants.O_DIRECTORY) return handle;
      return new Proxy(handle, {
        get(t, p) {
          if (p === "close")
            return async () => {
              if (fail) throw Error("owned image close fault");
              return t.close();
            };
          const v = Reflect.get(t, p, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    },
  };
  const store = await fixture({ files }),
    lease = (await store.allocate("/bin/bash"))!;
  fail = true;
  let retry!: () => Promise<void>;
  await assert.rejects(lease.close(), (error: unknown) => {
    const value = error as Error & { cleanup: () => Promise<void> };
    assert.match(value.message, /retain/);
    retry = value.cleanup;
    return true;
  });
  assert.equal(store.stats().owned, 1);
  assert.equal(store.stats().faulted, true);
  await assert.rejects(store.allocate("/bin/bash"), /faulted/);
  await assert.rejects(store.close(), /retain/);
  fail = false;
  await retry();
  assert.equal(store.stats().owned, 0);
});
test("named image replacement is not deleted; held original and directory remain owned until explicit repair", async () => {
  const store = await fixture(),
    lease = (await store.allocate("/bin/bash"))!,
    moved = lease.shellPath + ".moved";
  await fs.rename(lease.shellPath, moved);
  await fs.writeFile(lease.shellPath, "foreign replacement");
  let retry!: () => Promise<void>;
  await assert.rejects(lease.close(), (error: unknown) => {
    retry = (error as { cleanup: () => Promise<void> }).cleanup;
    return true;
  });
  assert.equal(await fs.readFile(lease.shellPath, "utf8"), "foreign replacement");
  assert.equal(store.stats().owned, 1);
  await fs.unlink(lease.shellPath);
  await fs.rename(moved, lease.shellPath);
  await retry();
});
test("root pathname replacement never recursively deletes foreign storage", async () => {
  const store = await fixture(),
    lease = (await store.allocate("/bin/bash"))!,
    root = dirname(lease.shellPath),
    moved = root + ".moved";
  await fs.rename(root, moved);
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(join(root, "foreign"), "keep");
  await lease.close();
  let retry!: () => Promise<void>;
  await assert.rejects(store.close(), (error: unknown) => {
    retry = (error as { cleanup: () => Promise<void> }).cleanup;
    return true;
  });
  assert.equal(await fs.readFile(join(root, "foreign"), "utf8"), "keep");
  await fs.unlink(join(root, "foreign"));
  await fs.rmdir(root);
  await fs.rename(moved, root);
  await retry();
});
