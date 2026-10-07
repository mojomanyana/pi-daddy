import { test } from "node:test";
import assert from "node:assert/strict";
import { CacheNativeIssuer, CacheNativeIssuerCleanupError } from "../extensions/cache-native-issuer.ts";
import { CacheNativeContextCleanupError } from "../src/executors/cache-native-context.ts";
import { CacheShellRoles } from "../src/governance/cache-shell-roles.ts";
const parent = { pid: 100, bootId: "11111111-1111-1111-1111-111111111111", startTicks: "10" };
const owner = { ...parent, pid: 200, startTicks: "20" };
const invocation = {
  cwd: "/work",
  shell: "/bin/bash",
  command: "true",
  env: { Z: "last", A: "first" },
  timeoutMs: 1000,
};
const call = () => ({ toolCallId: "one", signal: new AbortController().signal });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
function fixture(extra: Partial<ConstructorParameters<typeof CacheNativeIssuer>[0]> = {}) {
  const roles = new CacheShellRoles(4);
  const issuer = new CacheNativeIssuer({
    parent,
    workspace: "/work",
    maxCalls: 1,
    maxPending: 1,
    roles,
    images: {
      allocate: async () => ({ shellPath: "/private/shell", image: { dev: "1", ino: "2" }, close: async () => {} }),
    },
    context: { validate: async () => ({ kind: "qualified" }) },
    authorize: () => true,
    select: async () => "/private/shell",
    ...extra,
  });
  return { issuer, roles };
}
test("native issuer retains the original image cleanup capability rather than a mutable provider alias", async () => {
  let released = false;
  const image = {
    shellPath: "/private/shell",
    image: { dev: "1", ino: "2" },
    close: async () => {
      released = true;
    },
  };
  const f = fixture({ images: { allocate: async () => image } });
  const lease = (await f.issuer.allocate(invocation, call()))!;
  image.close = async () => {};
  await lease.close();
  await f.issuer.close();
  assert.equal(released, true);
});
test("native selector admission is bounded before await and shutdown joins pending unknown selection", async () => {
  const ready = deferred(),
    gate = deferred();
  const f = fixture({
    select: async () => {
      ready.release();
      await gate.promise;
      return "/unknown";
    },
  });
  const pending = f.issuer.claim(owner);
  const failed = assert.rejects(pending, /admission/);
  await ready.promise;
  await assert.rejects(f.issuer.claim({ ...owner, pid: 201 }), /bound/);
  let stopped = false;
  const stop = f.issuer.close().then(() => {
    stopped = true;
  });
  try {
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(stopped, false);
    assert.equal(f.issuer.stats().pending, 1);
  } finally {
    gate.release();
  }
  await failed;
  await stop;
  assert.equal(f.issuer.stats().pending, 0);
});
test("post-allocation current denial never delivers a stale image or reports resource-free bypass", async () => {
  const ready = deferred(),
    gate = deferred();
  let permitted = true,
    disposed = false;
  const f = fixture({
    authorize: () => permitted,
    images: {
      allocate: async () => {
        ready.release();
        await gate.promise;
        return {
          shellPath: "/private/shell",
          image: { dev: "1", ino: "2" },
          close: async () => {
            disposed = true;
          },
        };
      },
    },
  });
  const pending = f.issuer.allocate(invocation, call());
  await ready.promise;
  permitted = false;
  let retry!: () => Promise<void>;
  const failed = assert.rejects(pending, (e: unknown) => {
    assert.ok(e instanceof CacheNativeIssuerCleanupError);
    retry = e.cleanup;
    return true;
  });
  gate.release();
  await failed;
  assert.equal(disposed, false);
  assert.equal(f.issuer.stats().owned, 1);
  assert.equal(f.issuer.stats().faulted, true);
  await assert.rejects(f.issuer.close(), CacheNativeIssuerCleanupError);
  await retry();
  assert.equal(disposed, true);
  assert.equal(f.issuer.stats().owned, 0);
});
test("resource-free allocator uncertainty cannot override current denial observed after its await", async () => {
  const ready = deferred(),
    gate = deferred();
  let permitted = true;
  const f = fixture({
    authorize: () => permitted,
    images: {
      allocate: async () => {
        ready.release();
        await gate.promise;
        return undefined;
      },
    },
  });
  const pending = f.issuer.allocate(invocation, call());
  await ready.promise;
  permitted = false;
  const denied = assert.rejects(pending, /authority changed/);
  gate.release();
  await denied;
  assert.equal(f.issuer.stats().owned, 0);
  await f.issuer.close();
});
test("a current-authority callback that closes admission cannot start a later allocation", async () => {
  let f!: ReturnType<typeof fixture>,
    attempted = 0,
    stopping!: Promise<void>;
  f = fixture({
    authorize: () => {
      stopping = f.issuer.close();
      return true;
    },
    images: {
      allocate: async () => {
        attempted++;
        return undefined;
      },
    },
  });
  await assert.rejects(f.issuer.allocate(invocation, call()), /admission/);
  await stopping;
  assert.equal(attempted, 0);
  assert.equal(f.issuer.stats().owned, 0);
});
test("reentrant current authorization cannot consume a slot and let the outer allocation exceed its bound", async () => {
  let f!: ReturnType<typeof fixture>,
    once = true,
    attempts = 0;
  let nested!: ReturnType<CacheNativeIssuer["allocate"]>;
  f = fixture({
    authorize: () => {
      if (once) {
        once = false;
        nested = f.issuer.allocate(invocation, { ...call(), toolCallId: "nested" });
      }
      return true;
    },
    images: {
      allocate: async () => {
        const id = ++attempts;
        return { shellPath: `/private/shell-${id}`, image: { dev: "1", ino: String(id) }, close: async () => {} };
      },
    },
  });
  const outer = f.issuer.allocate(invocation, call());
  try {
    await assert.rejects(outer, /owner bound/);
    assert.equal(attempts, 1);
    assert.equal(f.issuer.stats().owned, 1);
    assert.ok(await nested);
  } finally {
    const results = await Promise.allSettled([outer, nested]);
    for (const result of results) if (result.status === "fulfilled") await result.value?.close();
    await f.issuer.close();
  }
});
test("borrowed validator cleanup failure remains visible after image retirement and has an explicit cleanup owner", async () => {
  let cleaned = 0;
  const fault = new CacheNativeContextCleanupError([Error("proc close fault")], async () => {
    cleaned++;
  });
  const f = fixture({
    context: {
      validate: async () => {
        throw fault;
      },
    },
  });
  const lease = (await f.issuer.allocate(invocation, call()))!;
  await f.issuer.claim(owner);
  await assert.rejects(f.issuer.validate(owner, invocation), (e) => e === fault);
  assert.equal(f.issuer.stats().faulted, true);
  await lease.close();
  let retry!: () => Promise<void>;
  await assert.rejects(f.issuer.close(), (e: unknown) => {
    assert.ok(e instanceof CacheNativeIssuerCleanupError);
    retry = e.cleanup;
    assert.equal(e.errors[0], fault);
    return true;
  });
  assert.equal(cleaned, 0);
  await retry();
  assert.equal(cleaned, 1);
  await assert.rejects(f.issuer.close(), CacheNativeIssuerCleanupError);
});
test("native validation captures connector birth before queued work and includes the native abort signal", async () => {
  const ready = deferred(),
    gate = deferred();
  let observed: typeof owner | undefined, observedSignal: AbortSignal | undefined;
  const f = fixture({
    context: {
      validate: async (actual, _expected, signal) => {
        observed = { ...actual };
        observedSignal = signal;
        ready.release();
        await gate.promise;
        return { kind: "qualified" };
      },
    },
  });
  const controller = new AbortController();
  const image = (await f.issuer.allocate(invocation, { toolCallId: "one", signal: controller.signal }))!;
  await f.issuer.claim(owner);
  const mutable = { ...owner },
    pending = f.issuer.validate(mutable, invocation);
  mutable.pid = 999;
  mutable.startTicks = "999";
  await ready.promise;
  try {
    assert.deepEqual(observed, owner);
    controller.abort();
    assert.equal(observedSignal?.aborted, true);
  } finally {
    gate.release();
    await pending;
    await image.close();
    await f.issuer.close();
  }
});
test("explicit issuer retry joins independent physical cleanup even when another cleanup identity remains unknown", async () => {
  let attempts = 0;
  const f = fixture({
    context: {
      validate: async () => {
        throw Error("unknown validator cleanup");
      },
    },
    images: {
      allocate: async () => ({
        shellPath: "/private/shell",
        image: { dev: "1", ino: "2" },
        close: async () => {
          if (++attempts === 1) throw Error("image close fault");
        },
      }),
    },
  });
  const image = (await f.issuer.allocate(invocation, call()))!;
  await f.issuer.claim(owner);
  await assert.rejects(f.issuer.validate(owner, invocation), /unknown validator/);
  await assert.rejects(image.close(), CacheNativeIssuerCleanupError);
  let retry!: () => Promise<void>;
  await assert.rejects(f.issuer.close(), (e: unknown) => {
    assert.ok(e instanceof CacheNativeIssuerCleanupError);
    retry = e.cleanup;
    return true;
  });
  await assert.rejects(retry(), CacheNativeIssuerCleanupError);
  assert.equal(attempts, 2, "unknown cleanup cannot prevent independent physical owner retirement");
  assert.equal(f.issuer.stats().owned, 0);
  assert.equal(f.issuer.stats().faulted, true);
});
test("native current-authority callback faults cannot revive an already issued role", async () => {
  let fail = false;
  const f = fixture({
    authorize: () => {
      if (fail) throw Error("authority unavailable");
      return true;
    },
  });
  const image = (await f.issuer.allocate(invocation, call()))!;
  await f.issuer.claim(owner);
  const lease = f.roles.bind(owner)!;
  fail = true;
  assert.throws(() => f.roles.authorized(lease), /authority unavailable/);
  fail = false;
  assert.equal(f.roles.authorized(lease), false);
  await image.close();
  await f.issuer.close();
});
test("native issuer rejects malformed limits/parent and mismatched workspace before allocation", async () => {
  for (const extra of [
    { maxCalls: 0 },
    { maxPending: 33 },
    { parent: { ...parent, startTicks: "bad" } },
    { workspace: "relative" },
  ])
    assert.throws(() => fixture(extra), /configuration/);
  const f = fixture();
  await assert.rejects(f.issuer.allocate({ ...invocation, cwd: "/other" }, call()), /expectation/);
  assert.equal(f.issuer.stats().owned, 0);
  await f.issuer.close();
});
