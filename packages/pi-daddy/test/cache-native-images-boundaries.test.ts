import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { CacheNativeImages } from "../src/executors/cache-native-images.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
async function fixture(extra: Partial<ConstructorParameters<typeof CacheNativeImages>[0]> = {}) {
  const image = Buffer.from("known image bytes");
  return new CacheNativeImages({
    directory: await tempDir("cache-image-boundaries-"),
    image,
    sha256: createHash("sha256").update(image).digest("hex"),
    socket: "/tmp/socket",
    admissionMs: 100,
    maxLeases: 1,
    maxImageBytes: 100,
    maxStorageBytes: 10000,
    ...extra,
  });
}
test("artifact byte budget refuses before directory allocation without faulting existing ownership", async () => {
  const store = await fixture({ maxStorageBytes: 1 });
  try {
    await assert.rejects(store.allocate("/bin/bash"), /storage bound/);
    assert.deepEqual(store.stats(), { owned: 0, reservedBytes: 0, rootOwned: false, faulted: false });
  } finally {
    await store.close();
  }
});
test("actual directory close failure retains its descriptor after rmdir and retry cannot delete a replacement", async () => {
  let fail = true,
    directoryFD = -1;
  const files = {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const h = await fs.open(...args);
      if (!(typeof args[1] === "number" && args[1] & constants.O_DIRECTORY)) return h;
      directoryFD = h.fd;
      return new Proxy(h, {
        get(t, p) {
          if (p === "close")
            return async () => {
              if (fail) throw Error("directory close fault");
              return t.close();
            };
          const v = Reflect.get(t, p, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    },
  };
  const store = await fixture({ files }),
    lease = (await store.allocate("/bin/bash"))!,
    root = dirname(lease.shellPath);
  await lease.close();
  let retry!: () => Promise<void>;
  await assert.rejects(store.close(), (error: unknown) => {
    retry = (error as { cleanup: () => Promise<void> }).cleanup;
    return true;
  });
  assert.equal(store.stats().rootOwned, true);
  await fs.stat(`/proc/self/fd/${directoryFD}`);
  await fs.mkdir(root);
  await fs.writeFile(join(root, "foreign"), "keep");
  fail = false;
  await retry();
  await assert.rejects(fs.stat(`/proc/self/fd/${directoryFD}`), { code: "ENOENT" });
  assert.equal(await fs.readFile(join(root, "foreign"), "utf8"), "keep");
  assert.equal(store.stats().rootOwned, false);
});
test("a publication-time writable descriptor close fault never delivers an executable lease and retains its real fd", async () => {
  let fail = true,
    writerFD = -1;
  const files = {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const h = await fs.open(...args);
      if (!(typeof args[1] === "number" && args[1] & constants.O_CREAT)) return h;
      writerFD = h.fd;
      return new Proxy(h, {
        get(t, p) {
          if (p === "close")
            return async () => {
              if (fail) throw Error("image writer close fault");
              return t.close();
            };
          const v = Reflect.get(t, p, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    },
  };
  const store = await fixture({ files });
  await assert.rejects(store.allocate("/bin/bash"), /publication failed; retain/);
  assert.equal(store.stats().owned, 1);
  assert.equal(store.stats().faulted, true);
  await fs.stat(`/proc/self/fd/${writerFD}`);
  let retry!: () => Promise<void>;
  await assert.rejects(store.close(), (error: unknown) => {
    retry = (error as { cleanup: () => Promise<void> }).cleanup;
    return true;
  });
  fail = false;
  await retry();
  await assert.rejects(fs.stat(`/proc/self/fd/${writerFD}`), { code: "ENOENT" });
  assert.equal(store.stats().owned, 0);
  assert.equal(store.stats().rootOwned, false);
});
test("cancellation arriving during a native image write waits for I/O and releases partial publication", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const files = {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const h = await fs.open(...args);
      if (typeof args[1] === "number" && args[1] & constants.O_DIRECTORY) return h;
      return new Proxy(h, {
        get(t, p) {
          if (p === "writeFile")
            return async (...a: Parameters<typeof h.writeFile>) => {
              enter();
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
    controller = new AbortController();
  let settled = false;
  const pending = store.allocate("/bin/bash", controller.signal).then((value) => {
    settled = true;
    return value;
  });
  await entered;
  controller.abort();
  try {
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(settled, false);
    assert.equal(store.stats().owned, 1);
  } finally {
    release();
    const value = await pending;
    if (value) await value.close();
    await store.close();
  }
  assert.equal(await pending, undefined);
  assert.equal(store.stats().owned, 0);
});
