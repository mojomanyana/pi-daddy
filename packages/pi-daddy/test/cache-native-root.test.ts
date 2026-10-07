import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
import { join } from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { CacheNativeRoot } from "../extensions/cache-native-root.ts";
import type { CacheNativeBrokerHandle, CacheNativeBrokerOptions } from "../src/executors/cache-native-broker.ts";
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(extra: Record<string, unknown> = {}) {
  const directory = await tempDir("cache-native-root-");
  const bytes = Buffer.from("fixture: ownership only, not executable ABI");
  let callback!: CacheNativeBrokerOptions;
  let stopped = 0,
    backendClosed = 0,
    allowed = true;
  const calls: string[] = [],
    diagnostics: unknown[] = [];
  const handle: CacheNativeBrokerHandle = {
    write: () => {},
    stop: async () => {
      stopped++;
    },
  };
  const root = new CacheNativeRoot({
    parent: { pid: process.pid, bootId: "927c7116-1149-4220-a967-a1cd8328bb9d", startTicks: "789" },
    cwd: directory,
    options: { shellPath: "/bin/bash", spawnHook: (c) => ({ ...c, env: { Z: "last", A: "first" } }) },
    native: {
      createBashToolDefinition,
      createLocalBashOperations: ({ shellPath } = {}) => ({
        exec: async (_command, _cwd, options) => {
          calls.push(shellPath!);
          options.onData(Buffer.from("raw"));
          return { exitCode: 0 };
        },
      }),
    },
    authorize: () => allowed,
    authorizeCall: () => allowed,
    images: {
      directory,
      image: bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
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
    eligible: () => true,
    run: async () => ({ exitCode: 0, signal: null }),
    closeBackend: async () => {
      backendClosed++;
    },
    onError: (error) => diagnostics.push(error),
    startBroker: async (options) => {
      callback = options;
      return handle;
    },
    ...extra,
  });
  const call = () =>
    root.definition.execute(
      "one",
      { command: "body", timeout: 3 },
      undefined,
      undefined,
      undefined as unknown as Parameters<typeof root.definition.execute>[4],
    );
  return {
    root,
    handle,
    calls,
    diagnostics,
    call,
    callback: () => callback,
    ready: () => callback.onData(Buffer.from("CP1 READY\n")),
    stopped: () => stopped,
    backendClosed: () => backendClosed,
    revoke: () => {
      allowed = false;
    },
    cleanup: async () => {
      const results = await Promise.allSettled([
        root.shutdown(),
        root.factory.shutdown(),
        root.issuer.close(),
        root.context.close(),
      ]);
      const visited = new Set<unknown>();
      const retry = async (error: unknown): Promise<void> => {
        if (!error || visited.has(error)) return;
        visited.add(error);
        if (error instanceof AggregateError) for (const cause of error.errors) await retry(cause);
        if (typeof (error as { cleanup?: unknown }).cleanup === "function")
          await (error as { cleanup(): Promise<void> }).cleanup().catch(() => {});
      };
      for (const result of results) if (result.status === "rejected") await retry(result.reason);
      await root.images.close().catch(() => {});
    },
  };
}
test("root native allocation waits for both supervised admission and CP1 readiness", async () => {
  let release!: (handle: CacheNativeBrokerHandle) => void, callback!: CacheNativeBrokerOptions;
  const f = await fixture({
    startBroker: (options: CacheNativeBrokerOptions) => {
      callback = options;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    const call = f.call();
    void call.catch(() => {});
    await turn();
    callback.onData(Buffer.from("CP1 READY\n"));
    await turn();
    assert.equal(f.calls.length, 0);
    assert.equal(f.root.stats().images.owned, 0);
    release(f.handle);
    await f.root.ready;
    assert.equal((await call).content[0].type, "text");
    assert.equal(f.calls.length, 1);
    assert.notEqual(f.calls[0], "/bin/bash");
    await f.root.shutdown();
    assert.equal(f.stopped(), 1);
    assert.equal(f.backendClosed(), 1);
    assert.equal(f.root.stats().factory.owned, 0);
    assert.equal(f.root.stats().images.rootOwned, false);
  } finally {
    release?.(f.handle);
    await f.cleanup();
  }
});
test("root native execution never precedes CP1 READY even after supervised startup", async () => {
  const f = await fixture();
  try {
    const call = f.call();
    void call.catch(() => {});
    await turn();
    await turn();
    assert.equal(f.calls.length, 0);
    assert.equal(f.root.stats().images.owned, 0);
    f.ready();
    await call;
    assert.equal(f.calls.length, 1);
  } finally {
    await f.cleanup();
  }
});
test("root teardown charges and joins a late broker and closes every independent owner", async () => {
  let release!: (handle: CacheNativeBrokerHandle) => void, callback!: CacheNativeBrokerOptions;
  const f = await fixture({
    startBroker: (options: CacheNativeBrokerOptions) => {
      callback = options;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    await turn();
    let done = false;
    const close = f.root.shutdown();
    close.then(() => {
      done = true;
    });
    assert.equal(close, f.root.shutdown());
    await turn();
    assert.equal(callback.signal?.aborted, true);
    assert.equal(done, false);
    assert.equal(f.backendClosed(), 1);
    release(f.handle);
    await close;
    assert.equal(f.stopped(), 1);
    assert.equal(f.root.stats().context.closed, true);
    await assert.rejects(f.call(), /authority|closed/);
  } finally {
    await f.cleanup();
  }
});
test("root teardown joins independent cleanup when backend throws a falsy error", async () => {
  const f = await fixture({
    closeBackend: async () => {
      throw undefined;
    },
  });
  try {
    await turn();
    f.ready();
    await f.root.ready;
    await assert.rejects(f.root.shutdown(), (error: unknown) => error instanceof AggregateError);
    assert.equal(f.stopped(), 1);
    assert.equal(f.root.stats().context.closed, true);
    assert.equal(f.root.stats().issuer.closed, true);
    assert.equal(f.root.stats().images.rootOwned, false);
    assert.equal(f.root.stats().faulted, true);
  } finally {
    await f.cleanup();
  }
});
test("root current revocation after startup wait cannot allocate or execute", async () => {
  const f = await fixture();
  try {
    const call = f.call();
    void call.catch(() => {});
    await turn();
    f.revoke();
    f.ready();
    await assert.rejects(
      call,
      (error: unknown) =>
        error instanceof AggregateError && error.errors.some((cause) => /authority/.test(String(cause))),
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.root.stats().images.owned, 0);
  } finally {
    await f.cleanup();
  }
});
for (const inherited of [false, true])
  test(`ordinary per-call denial preserves ${inherited ? "unsupported environment" : "missing timeout"} inputs`, async () => {
    const env = inherited
      ? Object.assign(Object.create({ INHERITED: "kept" }), { PATH: "/usr/bin:/bin" })
      : { PATH: "/usr/bin:/bin" };
    const seen: { env: unknown; timeout?: unknown; timeoutMs?: unknown }[] = [];
    const f = await fixture({
      options: {
        shellPath: "/bin/bash",
        spawnHook: (context: { command: string; cwd: string }) => ({ ...context, env }),
      },
      authorizeCall: (input: { env: unknown; timeout?: unknown; timeoutMs?: unknown }) => {
        seen.push(input);
        return false;
      },
    });
    try {
      await turn();
      f.ready();
      await f.root.ready;
      await assert.rejects(
        f.root.definition.execute(
          "ordinary-denied",
          {
            command: "body",
            ...(inherited ? { timeout: 1 } : {}),
          },
          undefined,
          undefined,
          undefined as unknown as Parameters<typeof f.root.definition.execute>[4],
        ),
        /authority/,
      );
      assert.equal(seen.length > 0, true);
      assert.equal(seen[0].env, env, "policy sees original unsupported native Record, not invented/cloned bindings");
      assert.equal(seen[0].timeout, inherited ? 1 : undefined);
      assert.equal(seen[0].timeoutMs, inherited ? 1000 : undefined);
      assert.deepEqual(f.calls, []);
      assert.equal(f.root.stats().images.owned, 0);
      assert.equal(f.root.stats().factory.owned, 0);
    } finally {
      await f.cleanup();
    }
  });
test("authorized unsupported native environment is passed through without fabricated timeout or bindings", async () => {
  const env = Object.assign(Object.create({ INHERITED: "kept" }), { PATH: "/usr/bin:/bin", UNSET: undefined });
  const seen: { env: unknown; timeout?: unknown; timeoutMs?: unknown }[] = [];
  const f = await fixture({
    options: {
      shellPath: "/bin/bash",
      spawnHook: (context: { command: string; cwd: string }) => ({ ...context, env }),
    },
    authorizeCall: (input: { env: unknown; timeout?: unknown; timeoutMs?: unknown }) => {
      seen.push(input);
      return true;
    },
  });
  try {
    await turn();
    f.ready();
    await f.root.ready;
    await f.root.definition.execute(
      "ordinary-allowed",
      { command: "body" },
      undefined,
      undefined,
      undefined as unknown as Parameters<typeof f.root.definition.execute>[4],
    );
    assert.equal(seen.length >= 2, true);
    assert.equal(
      seen.every((input) => input.env === env && input.timeout === undefined && input.timeoutMs === undefined),
      true,
    );
    assert.deepEqual(f.calls, ["/bin/bash"]);
    assert.equal(f.root.stats().images.owned, 0);
  } finally {
    await f.cleanup();
  }
});
test("throwing current per-call policy cannot become an ordinary bypass", async () => {
  const failure = Error("per-call authority unavailable");
  const f = await fixture({
    authorizeCall: () => {
      throw failure;
    },
  });
  try {
    await turn();
    f.ready();
    await f.root.ready;
    await assert.rejects(
      f.root.definition.execute(
        "ordinary-throw",
        { command: "body" },
        undefined,
        undefined,
        undefined as unknown as Parameters<typeof f.root.definition.execute>[4],
      ),
      (error) => error === failure,
    );
    assert.deepEqual(f.calls, []);
    assert.equal(f.root.stats().factory.owned, 0);
  } finally {
    await f.cleanup();
  }
});
test("authorized native hook cwd outside the cache workspace stays ordinary before image issuance", async () => {
  const f = await fixture({
    options: {
      shellPath: "/bin/bash",
      spawnHook: (context: { command: string }) => ({ ...context, cwd: "/other", env: { PATH: "/usr/bin:/bin" } }),
    },
  });
  try {
    await turn();
    f.ready();
    await f.root.ready;
    await f.call();
    assert.deepEqual(f.calls, ["/bin/bash"]);
    assert.equal(f.root.stats().images.owned, 0);
    assert.equal(f.root.stats().issuer.owned, 0);
  } finally {
    await f.cleanup();
  }
});
test("cache-only transport loss does not abort an already ordinary native invocation", async () => {
  let release!: () => void, originalSignal: AbortSignal | undefined;
  const f = await fixture({
    native: {
      createBashToolDefinition,
      createLocalBashOperations: () => ({
        exec: async (
          _command: string,
          _cwd: string,
          options: { signal?: AbortSignal; onData(bytes: Buffer): void },
        ) => {
          originalSignal = options.signal;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          options.onData(Buffer.from("ordinary"));
          return { exitCode: 0 };
        },
      }),
    },
  });
  const call = f.root.definition.execute(
    "ordinary",
    { command: "body" },
    undefined,
    undefined,
    undefined as unknown as Parameters<typeof f.root.definition.execute>[4],
  );
  void call.catch(() => {});
  try {
    await turn();
    f.ready();
    await f.root.ready;
    f.callback().onEnd(Error("cache transport lost"));
    await turn();
    assert.equal(originalSignal?.aborted, false, "optimization loss must not invent original command cancellation");
    release();
    assert.equal((await call).content[0].type, "text");
    assert.equal(f.root.stats().factory.owned, 0);
    await assert.rejects(f.root.shutdown(), /root cleanup unresolved/);
  } finally {
    release?.();
    await call.catch(() => {});
    await f.cleanup();
  }
});
test("root CP1 loss disables cache while fresh authorized calls retain the ordinary route", async () => {
  const f = await fixture();
  try {
    await turn();
    f.ready();
    await f.root.ready;
    f.callback().onEnd(Error("lost native control"));
    await turn();
    await f.call();
    assert.deepEqual(f.calls, ["/bin/bash"]);
    assert.equal(f.root.stats().unavailableBypasses, 1);
    f.revoke();
    await assert.rejects(f.call(), /authority/);
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.root.shutdown(), /root cleanup unresolved/);
    assert.equal(f.stopped(), 1);
    assert.equal(f.backendClosed(), 1);
  } finally {
    await f.cleanup();
  }
});
test("root invalid CP1 control after READY closes cache admission but keeps authorized ordinary execution", async () => {
  const f = await fixture();
  try {
    await turn();
    f.ready();
    await f.root.ready;
    f.ready(); // Duplicate control readiness is corruption, not another successful startup.
    await turn();
    await f.call();
    assert.deepEqual(f.calls, ["/bin/bash"]);
    assert.equal(f.root.stats().unavailableBypasses, 1);
    await assert.rejects(f.root.shutdown(), /root cleanup unresolved/);
    assert.equal(f.stopped(), 1);
    assert.equal(f.backendClosed(), 1);
    assert.equal(f.root.stats().faulted, true);
  } finally {
    await f.cleanup();
  }
});
test("root missing CP1 readiness has a bounded diagnostic and never issues cached native images", async () => {
  const f = await fixture({ readinessMs: 10 });
  try {
    await assert.rejects(f.root.ready, /readiness.*exceeded/);
    await assert.rejects(f.root.shutdown(), /root cleanup unresolved/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.stopped(), 1);
    assert.equal(f.root.stats().context.closed, true);
  } finally {
    await f.cleanup();
  }
});
