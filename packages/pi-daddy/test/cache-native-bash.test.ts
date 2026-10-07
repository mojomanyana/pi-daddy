import assert from "node:assert/strict";
import { test } from "node:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { CacheNativeBashFactory } from "../extensions/cache-native-bash.ts";
async function waitUntil(ready: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!ready() && Date.now() < deadline) await new Promise<void>((r) => setImmediate(r));
  assert.equal(ready(), true, "native call must reach its owned boundary");
}
function setup(extra: Record<string, unknown> = {}) {
  const seen: Array<{ shellPath?: string; command: string; cwd: string; timeout?: number; env?: NodeJS.ProcessEnv }> =
    [];
  const allocations: Array<{
    invocation: { command: string; cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number };
    toolCallId: string;
  }> = [];
  let closed = 0,
    allowed = true;
  const factory = new CacheNativeBashFactory({
    cwd: "/work",
    options: {
      shellPath: "/bin/bash",
      commandPrefix: "prefix",
      exposeSessionEnvironment: false,
      spawnHook: (context) => ({ ...context, command: context.command + " hook", env: { Z: "last", A: "first" } }),
    },
    maxCalls: 2,
    native: {
      createBashToolDefinition,
      createLocalBashOperations: ({ shellPath } = {}) => ({
        exec: async (command, cwd, options) => {
          seen.push({ shellPath, command, cwd, timeout: options.timeout, env: options.env });
          options.onData(Buffer.from("raw"));
          return { exitCode: 0 };
        },
      }),
    },
    authorize: () => allowed,
    allocate: async (invocation, context) => {
      allocations.push({ invocation, toolCallId: context.toolCallId });
      return {
        shellPath: "/private/" + context.toolCallId,
        close: async () => {
          closed++;
        },
      };
    },
    ...extra,
  });
  // No session metadata requested: only the supplied native factory's execution boundary is under test.
  const ctx = undefined as unknown as Parameters<typeof factory.definition.execute>[4];
  const call = (id = "one", timeout: number | undefined = 3) =>
    factory.definition.execute(id, { command: "body", timeout }, undefined, undefined, ctx);
  return {
    factory,
    seen,
    allocations,
    call,
    closeCount: () => closed,
    revoke: () => {
      allowed = false;
    },
  };
}
test("effective authority seam refuses malformed callbacks or custom-operation interception", () => {
  assert.throws(() => setup({ authorizeCall: null }), /authority.*callback/);
  assert.throws(
    () =>
      setup({
        authorizeCall: () => true,
        options: {
          shellPath: "/bin/bash",
          operations: { exec: async () => ({ exitCode: 0 }) },
        },
      }),
    /authority.*default operations/,
  );
});
test("common per-call authority is rechecked after allocation before either native executor starts", async () => {
  let granted = true,
    allocated = false,
    closed = 0;
  let release!: (lease: { shellPath: string; close(): Promise<void> }) => void;
  const s = setup({
    authorizeCall: () => granted,
    allocate: async () => {
      allocated = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const call = s.call();
  void call.catch(() => {});
  try {
    await waitUntil(() => allocated);
    granted = false;
    release({
      shellPath: "/private/image",
      close: async () => {
        closed++;
      },
    });
    await assert.rejects(call, /authority/);
    assert.deepEqual(s.seen, []);
    assert.equal(closed, 1);
    assert.equal(s.factory.stats().owned, 0);
  } finally {
    release?.({
      shellPath: "/private/image",
      close: async () => {
        closed++;
      },
    });
    await call.catch(() => {});
    await s.factory.shutdown();
  }
});
test("owned native factory captures post-prefix/hook options and uses native shellPath operations", async () => {
  const s = setup();
  const result = await s.call();
  assert.equal(result.content.find((item) => item.type === "text")?.text, "raw");
  assert.deepEqual(
    s.allocations.map((a) => [
      a.toolCallId,
      a.invocation.command,
      a.invocation.timeoutMs,
      Object.keys(a.invocation.env),
    ]),
    [["one", "prefix\nbody hook", 3000, ["Z", "A"]]],
  );
  assert.equal(s.seen[0].shellPath, "/private/one");
  assert.equal(s.seen[0].command, "prefix\nbody hook");
  assert.equal(s.seen[0].timeout, 3);
  assert.equal(s.closeCount(), 1);
  assert.equal(s.factory.stats().owned, 0);
  await s.factory.shutdown();
});
test("unsupported unbounded timeout stays on original native route without invented default", async () => {
  const s = setup();
  await s.factory.definition.execute(
    "none",
    { command: "body" },
    undefined,
    undefined,
    undefined as unknown as Parameters<typeof s.factory.definition.execute>[4],
  );
  assert.equal(s.allocations.length, 0);
  assert.equal(s.seen[0].shellPath, "/bin/bash");
  assert.equal(s.seen[0].timeout, undefined);
  await s.factory.shutdown();
});
test("unsupported timeout objects are not coerced while preparing cache identity", async () => {
  const s = setup();
  let coerces = 0;
  const timeout = {
    valueOf: () => {
      coerces++;
      return 3;
    },
  };
  await s.call("malformed", timeout as unknown as number);
  assert.equal(coerces, 0);
  assert.equal(s.allocations.length, 0);
  assert.equal(s.seen[0].shellPath, "/bin/bash");
  assert.equal(s.seen[0].timeout, timeout);
  await s.factory.shutdown();
});
test("independent parallel tool contexts survive reversed allocation completion", async () => {
  const release = new Map<string, () => void>();
  const s = setup({
    allocate: async (_invocation: unknown, context: { toolCallId: string }) => {
      await new Promise<void>((resolve) => release.set(context.toolCallId, resolve));
      return { shellPath: "/private/" + context.toolCallId, close: async () => {} };
    },
  });
  const one = s.call("one", 1),
    two = s.call("two", 2);
  await waitUntil(() => release.size === 2);
  assert.equal(s.factory.stats().owned, 2);
  await assert.rejects(s.call("three"), /owner.*bound/);
  release.get("two")!();
  await two;
  release.get("one")!();
  await one;
  assert.deepEqual(
    s.seen.map((a) => [a.shellPath, a.timeout]),
    [
      ["/private/two", 2],
      ["/private/one", 1],
    ],
  );
  await s.factory.shutdown();
});
test("revocation after allocation cleans its lease without executing or falling back", async () => {
  let closes = 0;
  const s = setup({
    allocate: async () => {
      s.revoke();
      return {
        shellPath: "/private/denied",
        close: async () => {
          closes++;
        },
      };
    },
  });
  await assert.rejects(s.call(), /authority/);
  assert.equal(s.seen.length, 0);
  assert.equal(closes, 1);
  await s.factory.shutdown();
});
test("shutdown retains and joins a late allocation and cleanup owner", async () => {
  let release!: () => void, close!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    cleanup = new Promise<void>((r) => {
      close = r;
    });
  const s = setup({
    allocate: async () => {
      await gate;
      return { shellPath: "/private/late", close: () => cleanup };
    },
  });
  const call = s.call();
  void call.catch(() => {});
  await waitUntil(() => s.factory.stats().owned > 0);
  let settled = false;
  const stopping = s.factory.shutdown().then(() => {
    settled = true;
  });
  release();
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(settled, false);
  assert.equal(s.factory.stats().owned, 1);
  assert.equal(s.seen.length, 0);
  close();
  await assert.rejects(call, /aborted|closed/);
  await stopping;
  assert.equal(s.factory.stats().owned, 0);
});
test("failed lease cleanup faults admission and remains owned", async () => {
  const s = setup({
    allocate: async () => ({
      shellPath: "/private/failed",
      close: async () => {
        throw Error("close failed");
      },
    }),
  });
  await assert.rejects(s.call(), /cleanup.*unresolved/);
  assert.equal(s.factory.stats().owned, 1);
  assert.equal(s.factory.stats().retainedLeases, 1, "failed owner retains its actual lease, not just an error");
  await assert.rejects(s.call("next"), /fault|closed/);
  await assert.rejects(s.factory.shutdown(), /cleanup.*unresolved/);
});
test("known environment mutation during allocation closes stale image before ordinary native execution", async () => {
  const env = { Z: "last", A: "first" };
  let closes = 0;
  const s = setup({
    options: {
      shellPath: "/bin/bash",
      exposeSessionEnvironment: false,
      spawnHook: (context: { command: string; cwd: string }) => ({ ...context, env }),
    },
    allocate: async () => {
      env.Z = "changed";
      return {
        shellPath: "/private/stale",
        close: async () => {
          closes++;
        },
      };
    },
  });
  await s.call();
  assert.equal(s.seen[0].shellPath, "/bin/bash");
  assert.equal(s.seen[0].env?.Z, "changed");
  assert.equal(closes, 1);
  await s.factory.shutdown();
});
test("explicit no-resource allocation bypass uses the untouched native route", async () => {
  const s = setup({ allocate: async () => undefined });
  await s.call();
  assert.equal(s.seen[0].shellPath, "/bin/bash");
  assert.equal(s.seen[0].command, "prefix\nbody hook");
  assert.equal(s.closeCount(), 0);
  assert.equal(s.factory.stats().owned, 0);
  await s.factory.shutdown();
});
test("unknown allocation failure cannot cause fallback or release admission ownership", async () => {
  for (const reason of [Error("allocation ownership unknown"), undefined]) {
    const s = setup({
      allocate: async () => {
        throw reason;
      },
    });
    await assert.rejects(s.call(), /cleanup.*unresolved/);
    assert.equal(s.seen.length, 0);
    assert.equal(s.factory.stats().owned, 1);
    assert.equal(s.factory.stats().faulted, true);
    await assert.rejects(s.factory.shutdown(), /cleanup.*unresolved/);
  }
});
test("only undefined allocation certifies bypass; malformed false/null leases never execute", async () => {
  for (const lease of [null, false, { shellPath: "/private/malformed" }]) {
    const s = setup({ allocate: async () => lease });
    await assert.rejects(s.call(), /cleanup.*unresolved/);
    assert.equal(s.seen.length, 0);
    assert.equal(s.factory.stats().owned, 1);
    await assert.rejects(s.factory.shutdown(), /cleanup.*unresolved/);
  }
});
test("falsy cleanup throws still retain the lease and fail shutdown", async () => {
  const s = setup({
    allocate: async () => ({
      shellPath: "/private/falsy",
      close: async () => {
        throw undefined;
      },
    }),
  });
  await assert.rejects(s.call(), /cleanup.*unresolved/);
  assert.equal(s.factory.stats().owned, 1);
  assert.equal(s.factory.stats().retainedLeases, 1);
  await assert.rejects(s.factory.shutdown(), /cleanup.*unresolved/);
});
test("native execution failure retains its error while successful lease cleanup releases ownership", async () => {
  let closes = 0;
  const s = setup({
    native: {
      createBashToolDefinition,
      createLocalBashOperations: () => ({
        exec: async () => {
          throw Error("native operation failed");
        },
      }),
    },
    allocate: async () => ({
      shellPath: "/private/error",
      close: async () => {
        closes++;
      },
    }),
  });
  await assert.rejects(s.call(), /native operation failed/);
  assert.equal(closes, 1);
  assert.equal(s.factory.stats().owned, 0);
  assert.equal(s.factory.stats().faulted, false);
  await s.factory.shutdown();
});
test("a falsy native failure survives a simultaneous lease cleanup failure", async () => {
  const s = setup({
    native: {
      createBashToolDefinition,
      createLocalBashOperations: () => ({
        exec: async () => {
          throw false;
        },
      }),
    },
    allocate: async () => ({
      shellPath: "/private/both",
      close: async () => {
        throw Error("close failed");
      },
    }),
  });
  await assert.rejects(
    s.call(),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === false,
  );
  await assert.rejects(s.factory.shutdown(), /cleanup.*unresolved/);
});
test("malformed owner bounds are refused before creating a native factory", () => {
  for (const maxCalls of [0, 33, 1.5, NaN]) assert.throws(() => setup({ maxCalls }), /owner bound/);
});
for (const fail of [false, true])
  test(`complete native result finalization remains admission/lifetime-owned (${fail ? "failure" : "success"})`, async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const s = setup({
      maxCalls: 1,
      native: {
        createBashToolDefinition: (
          cwd: Parameters<typeof createBashToolDefinition>[0],
          options: Parameters<typeof createBashToolDefinition>[1],
        ) => {
          const native = createBashToolDefinition(cwd, options);
          return {
            ...native,
            execute: async (...args: Parameters<typeof native.execute>) => {
              const result = await native.execute(...args);
              enter();
              await gate;
              if (fail) throw Error("caller native failure");
              return result;
            },
          };
        },
        createLocalBashOperations: () => ({
          exec: async (command: string) => {
            seen.push(command);
            return { exitCode: 0 };
          },
        }),
      },
    });
    const first = s.call();
    void first.catch(() => {});
    await entered;
    const second = s.call("other");
    void second.catch(() => {});
    let settled = false;
    const stopping = s.factory.shutdown().then(() => {
      settled = true;
    });
    try {
      await new Promise<void>((r) => setImmediate(r));
      assert.equal(s.factory.stats().owned, 1);
      assert.equal(seen.length, 1, "finished operations must not free execute admission during finalization");
      assert.equal(settled, false, "shutdown must join the native definition, not just its operations");
    } finally {
      release();
      await second.catch(() => {});
      await first.catch(() => {});
      await stopping;
    }
    await assert.rejects(second, /owner.*bound/);
    if (fail) await assert.rejects(first, /caller native failure/);
    else await first;
    assert.equal(s.factory.stats().owned, 0);
  });
test("foreign custom native operations are not intercepted or reconstructed", async () => {
  const custom = { exec: async () => ({ exitCode: 0 }) };
  const s = setup({ options: { shellPath: "/bin/bash", operations: custom } });
  await s.call();
  assert.equal(s.allocations.length, 0);
  assert.equal(s.seen.length, 0);
  await s.factory.shutdown();
});
