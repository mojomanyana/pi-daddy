import { test } from "node:test";
import assert from "node:assert/strict";
import { CacheNativeIssuer, CacheNativeIssuerCleanupError } from "../extensions/cache-native-issuer.ts";
import { CacheShellRoles } from "../src/governance/cache-shell-roles.ts";
import type { CacheNativeImageLease } from "../src/executors/cache-native-images.ts";
const bootId = "11111111-1111-1111-1111-111111111111";
const parent = { pid: 100, bootId, startTicks: "10" };
const connector = { pid: 200, bootId, startTicks: "20" };
const invocation = {
  cwd: "/work",
  shell: "/bin/bash",
  command: "printf 'one'",
  env: { Z: "last", A: "first" },
  timeoutMs: 1000,
};
function call(id = "one") {
  return { toolCallId: id, signal: new AbortController().signal };
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
function fixture(extra: Partial<ConstructorParameters<typeof CacheNativeIssuer>[0]> = {}) {
  let next = 0,
    closes = 0,
    permitted = true;
  const roles = new CacheShellRoles(8);
  const observed: Parameters<ConstructorParameters<typeof CacheNativeIssuer>[0]["context"]["validate"]>[] = [];
  const issuer = new CacheNativeIssuer({
    parent,
    workspace: "/work",
    maxCalls: 2,
    maxPending: 2,
    roles,
    images: {
      allocate: async () => ({
        shellPath: `/private/shell-${++next}`,
        image: { dev: "1", ino: String(next) },
        close: async () => {
          closes++;
        },
      }),
    },
    context: {
      validate: async (...args) => {
        observed.push(args);
        return { kind: "qualified" };
      },
    },
    authorize: () => permitted,
    select: async (owner) => `/private/shell-${owner.pid === 200 ? 1 : 2}`,
    ...extra,
  });
  return {
    issuer,
    roles,
    observed,
    closes: () => closes,
    deny: () => {
      permitted = false;
    },
    allow: () => {
      permitted = true;
    },
  };
}
test("native issuer binds distinct private images to exact independently frozen calls and connector birth", async () => {
  const f = fixture(),
    mutable = { ...invocation, env: { ...invocation.env } };
  const a = (await f.issuer.allocate(mutable, call("one")))!,
    b = (await f.issuer.allocate(invocation, call("two")))!;
  mutable.env.Z = "changed";
  assert.notEqual(a.shellPath, b.shellPath);
  try {
    assert.equal(await f.issuer.claim(connector), true);
    const other = { ...connector, pid: 201, startTicks: "21" };
    assert.equal(await f.issuer.claim(other), true);
    assert.equal(f.roles.size(), 2);
    assert.equal(f.roles.invocation(f.roles.bind(connector)!)!.env.Z, "last");
    assert.deepEqual(await f.issuer.validate(connector, invocation), { kind: "qualified" });
    assert.deepEqual(f.observed[0][1], { parent, image: { path: a.shellPath, dev: "1", ino: "1" }, invocation });
    assert.equal(
      (await f.issuer.validate(connector, { ...invocation, env: { A: "first", Z: "last" } }))!.kind,
      "reject",
    );
    assert.equal(f.observed.length, 1);
    assert.equal(await f.issuer.validate({ ...connector, startTicks: "999" }, invocation), undefined);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await f.issuer.close();
  }
  assert.equal(f.closes(), 2);
  assert.equal(f.roles.size(), 0);
  assert.deepEqual(f.issuer.stats(), { owned: 0, pending: 0, faulted: false, closed: true });
});
test("known current denial keeps attachment for R and never revives its issued lease", async () => {
  const f = fixture(),
    image = (await f.issuer.allocate(invocation, call()))!;
  await f.issuer.claim(connector);
  const lease = f.roles.bind(connector)!;
  assert.equal(f.roles.authorized(lease), true);
  f.deny();
  assert.equal(f.roles.attached(connector), true);
  assert.equal(f.roles.authorized(lease), false);
  f.allow();
  assert.equal(f.roles.authorized(lease), false);
  await image.close();
  await f.issuer.close();
});
test("a private native image may issue only one connector and unknown images issue no role", async () => {
  const f = fixture({ select: async (owner) => (owner.pid === 999 ? "/unknown" : "/private/shell-1") });
  const image = (await f.issuer.allocate(invocation, call()))!;
  assert.equal(await f.issuer.claim({ ...connector, pid: 999 }), false);
  await f.issuer.claim(connector);
  await assert.rejects(f.issuer.claim({ ...connector, pid: 201 }), /claimed/);
  await assert.rejects(f.issuer.claim(connector), /claimed/);
  assert.equal(f.roles.size(), 1);
  await image.close();
  await f.issuer.close();
});
test("issuer charges before late image allocation and close joins it before a no-resource result", async () => {
  const entered = deferred(),
    gate = deferred();
  let disposed = false;
  const f = fixture({
    maxCalls: 1,
    images: {
      allocate: async () => {
        entered.release();
        await gate.promise;
        return {
          shellPath: "/private/shell-1",
          image: { dev: "1", ino: "1" },
          close: async () => {
            disposed = true;
          },
        };
      },
    },
  });
  const pending = f.issuer.allocate(invocation, call());
  await entered.promise;
  await assert.rejects(f.issuer.allocate(invocation, call()), /bound/);
  let stopped = false;
  const stop = f.issuer.close().then(() => {
    stopped = true;
  });
  try {
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(stopped, false);
    assert.equal(f.issuer.stats().owned, 1);
  } finally {
    gate.release();
  }
  assert.equal(await pending, undefined);
  await stop;
  assert.equal(disposed, true);
  assert.equal(f.issuer.stats().owned, 0);
});
test("retirement revokes roles before waiting and joins pending selection before removing image", async () => {
  const entered = deferred(),
    gate = deferred();
  let delay = false;
  const f = fixture({
    select: async () => {
      if (delay) {
        entered.release();
        await gate.promise;
      }
      return "/private/shell-1";
    },
  });
  const image = (await f.issuer.allocate(invocation, call()))!;
  await f.issuer.claim(connector);
  delay = true;
  const pending = f.issuer.claim({ ...connector, pid: 201 });
  const rejected = assert.rejects(pending, /retir/);
  await entered.promise;
  const retiring = image.close();
  try {
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(f.roles.size(), 0);
    assert.equal(f.closes(), 0);
    assert.equal(f.issuer.stats().owned, 1);
  } finally {
    gate.release();
  }
  await rejected;
  await retiring;
  await f.issuer.close();
  assert.equal(f.closes(), 1);
});
test("retirement retains image ownership while actual native context validation settles", async () => {
  const entered = deferred(),
    gate = deferred();
  const f = fixture({
    context: {
      validate: async () => {
        entered.release();
        await gate.promise;
        return { kind: "qualified" };
      },
    },
  });
  const image = (await f.issuer.allocate(invocation, call()))!;
  await f.issuer.claim(connector);
  const pending = f.issuer.validate(connector, invocation);
  await entered.promise;
  const retiring = image.close();
  try {
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(f.closes(), 0);
    assert.equal(f.roles.size(), 0);
  } finally {
    gate.release();
  }
  assert.equal((await pending)!.kind, "reject");
  await retiring;
  await f.issuer.close();
});
test("issuer shutdown stops admission but never unpublishes an image still owned by a native consumer", async () => {
  const f = fixture(),
    image = (await f.issuer.allocate(invocation, call()))!;
  await f.issuer.claim(connector);
  let stopped = false;
  const stop = f.issuer.close().then(() => {
    stopped = true;
  });
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(stopped, false);
  assert.equal(f.roles.authorized(f.roles.bind(connector)!), false);
  assert.equal(f.closes(), 0);
  await assert.rejects(f.issuer.allocate(invocation, call()), /admission/);
  await image.close();
  await stop;
  assert.equal(f.closes(), 1);
});
test("first image cleanup failure is visible, retained and retried only by explicit cleanup owner", async () => {
  let attempts = 0;
  const f = fixture({
    images: {
      allocate: async () => ({
        shellPath: "/private/shell-1",
        image: { dev: "1", ino: "1" },
        close: async () => {
          if (++attempts === 1) throw Error("image close fault");
        },
      }),
    },
  });
  const image = (await f.issuer.allocate(invocation, call()))!;
  await f.issuer.claim(connector);
  let retry!: () => Promise<void>;
  await assert.rejects(image.close(), (error: unknown) => {
    assert.ok(error instanceof CacheNativeIssuerCleanupError);
    retry = error.cleanup;
    return true;
  });
  assert.equal(attempts, 1);
  assert.equal(f.issuer.stats().owned, 1);
  assert.equal(f.issuer.stats().faulted, true);
  assert.equal(f.roles.size(), 0);
  await assert.rejects(f.issuer.close(), CacheNativeIssuerCleanupError);
  assert.equal(attempts, 1);
  await retry();
  assert.equal(attempts, 2);
  assert.equal(f.issuer.stats().owned, 0);
  assert.equal(f.issuer.stats().faulted, true);
  await assert.rejects(f.issuer.close(), CacheNativeIssuerCleanupError);
});
test("undefined alone permits pre-allocation bypass; unknown allocation failure cannot certify no resources", async () => {
  const f = fixture({ images: { allocate: async () => undefined } });
  assert.equal(await f.issuer.allocate(invocation, call()), undefined);
  await f.issuer.close();
  for (const bad of [null, false, {}, undefined]) {
    const g = fixture({
      images: {
        allocate: async () => {
          if (bad === undefined) throw undefined;
          return bad as unknown as CacheNativeImageLease;
        },
      },
    });
    await assert.rejects(g.issuer.allocate(invocation, call()), CacheNativeIssuerCleanupError);
    assert.equal(g.issuer.stats().owned, 1);
    assert.equal(g.issuer.stats().faulted, true);
    await assert.rejects(g.issuer.close(), CacheNativeIssuerCleanupError);
  }
});
