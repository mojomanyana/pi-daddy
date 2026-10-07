import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { CacheNativeRoot, type CacheNativeRootOptions } from "../extensions/cache-native-root.ts";
import type { CacheNativeBrokerHandle } from "../src/executors/cache-native-broker.ts";
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function configuration() {
  const directory = await tempDir("cache-root-boundaries-"),
    image = Buffer.from("non-executable unit bytes");
  let stops = 0,
    closes = 0;
  const options: CacheNativeRootOptions = {
    cwd: directory,
    parent: { pid: process.pid, bootId: "927c7116-1149-4220-a967-a1cd8328bb9d", startTicks: "789" },
    options: { shellPath: "/bin/bash", spawnHook: (context) => ({ ...context, env: { PATH: "/usr/bin:/bin" } }) },
    native: { createBashToolDefinition, createLocalBashOperations: () => ({ exec: async () => ({ exitCode: 0 }) }) },
    authorize: () => true,
    authorizeCall: () => true,
    eligible: () => true,
    run: async () => ({ exitCode: 0, signal: null }),
    closeBackend: async () => {
      closes++;
    },
    onError: () => {},
    images: {
      directory,
      image,
      sha256: createHash("sha256").update(image).digest("hex"),
      socket: join(directory, "s"),
      admissionMs: 1000,
      maxLeases: 2,
      maxImageBytes: 1024,
      maxStorageBytes: 8192,
    },
    context: { checks: 2, maxReadBytes: 8192, maxTotalBytes: 65536, timeoutMs: 1000 },
    maxCalls: 2,
    maxPending: 2,
    handshakeMs: 1000,
    readinessMs: 1000,
    brokerPath: "/trusted/broker",
    startBroker: async (options) => {
      options.onData(Buffer.from("CP1 READY\n"));
      return {
        write: () => {},
        stop: async () => {
          stops++;
        },
      };
    },
  };
  return {
    options,
    stops: () => stops,
    closes: () => closes,
    remove: cleanupTempDirs,
  };
}
test("root shutdown is memoized before broker abort callbacks reenter", async () => {
  const f = await configuration();
  let root!: CacheNativeRoot, reentered: Promise<void> | undefined;
  const start = f.options.startBroker!;
  f.options.startBroker = async (options) => {
    options.signal!.addEventListener(
      "abort",
      () => {
        reentered = root.shutdown();
      },
      { once: true },
    );
    return start(options);
  };
  try {
    root = new CacheNativeRoot(f.options);
    await root.ready;
    const closing = root.shutdown();
    assert.equal(closing, reentered);
    await closing;
    assert.equal(f.stops(), 1);
    assert.equal(f.closes(), 1);
  } finally {
    await root?.shutdown().catch(() => {});
    await f.remove();
  }
});
test("root owns the full native final result even after operations and image retirement", async () => {
  const f = await configuration();
  let release!: () => void,
    finalized = false;
  f.options.native.createBashToolDefinition = (...args) => {
    const definition = createBashToolDefinition(...args);
    return {
      ...definition,
      execute: async (...args) => {
        const result = await definition.execute(...args);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        finalized = true;
        return result;
      },
    };
  };
  const root = new CacheNativeRoot(f.options);
  const call = root.definition.execute(
    "finalization",
    { command: "body", timeout: 3 },
    undefined,
    undefined,
    undefined as unknown as Parameters<typeof root.definition.execute>[4],
  );
  void call.catch(() => {});
  try {
    const deadline = Date.now() + 1000;
    while (!release && Date.now() < deadline) await turn();
    assert.equal(typeof release, "function");
    assert.equal(root.stats().factory.owned, 1);
    assert.equal(root.stats().images.owned, 0);
    let closed = false;
    const closing = root.shutdown().then(() => {
      closed = true;
    });
    await turn();
    assert.equal(closed, false);
    release();
    await call;
    await closing;
    assert.equal(finalized, true);
  } finally {
    release?.();
    await Promise.allSettled([call, root.shutdown()]);
    await f.remove();
  }
});
test("root captures original startup socket, executable and callback before async startup", async () => {
  const f = await configuration();
  const socket = f.options.images.socket,
    executable = f.options.brokerPath;
  let seen: string[] | undefined;
  f.options.startBroker = async (options) => {
    seen = [options.socket, options.executable];
    options.onData(Buffer.from("CP1 READY\n"));
    return { write: () => {}, stop: async () => {} };
  };
  const root = new CacheNativeRoot(f.options);
  f.options.images.socket = "/changed/socket";
  f.options.brokerPath = "/changed/broker";
  f.options.startBroker = async () => {
    throw Error("replacement startup callback");
  };
  try {
    await root.ready;
    assert.deepEqual(seen, [socket, executable]);
  } finally {
    await root.shutdown().catch(() => {});
    await f.remove();
  }
});
test("root rejects malformed startup handles and joins independent cleanup without fallback", async () => {
  const f = await configuration();
  f.options.startBroker = async () => null as unknown as CacheNativeBrokerHandle;
  const root = new CacheNativeRoot(f.options);
  try {
    await assert.rejects(root.ready, /broker allocation incompatible/);
    await assert.rejects(root.shutdown(), /root cleanup unresolved/);
    assert.equal(f.closes(), 1);
    assert.equal(root.stats().context.closed, true);
    assert.equal(root.stats().issuer.closed, true);
    assert.equal(root.stats().faulted, true);
  } finally {
    await f.remove();
  }
});
test("root validates configuration before calling startup or taking backend ownership", async () => {
  const f = await configuration();
  let starts = 0;
  f.options.startBroker = async () => {
    starts++;
    throw Error("not called");
  };
  try {
    for (const readinessMs of [0, 30001, 0.5, NaN])
      assert.throws(() => new CacheNativeRoot({ ...f.options, readinessMs }), /configuration/);
    assert.throws(
      () =>
        new CacheNativeRoot({
          ...f.options,
          options: { ...f.options.options, operations: { exec: async () => ({ exitCode: 0 }) } },
        }),
      /unsupported/,
    );
    assert.equal(starts, 0);
    assert.equal(f.closes(), 0);
  } finally {
    await f.remove();
  }
});
