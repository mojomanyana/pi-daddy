import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheShellRoles } from "../src/governance/cache-shell-roles.ts";
import { CacheShellService } from "../src/products/cache-shell-service.ts";
import type { CacheBrokerPeer } from "../src/executors/cache-broker-channel.ts";
const owner = { pid: 123, bootId: "927c7116-1149-4220-a967-a1cd8328bb9d", startTicks: "456" };
const invocation = { cwd: "/workspace", shell: "/bin/bash", command: "literal", env: { X: "one" }, timeoutMs: 1000 };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function hello(command = "literal") {
  const num = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const text = (s: string) => Buffer.concat([num(Buffer.byteLength(s)), Buffer.from(s)]);
  const body = Buffer.concat([
    text("/bin/bash"),
    text("/workspace"),
    num(2),
    text("-c"),
    text(command),
    num(1),
    text("X=one"),
  ]);
  return Buffer.concat([Buffer.from("CS1\0"), num(body.length), body]);
}
function setup(extra: Record<string, unknown> = {}) {
  const roles = new CacheShellRoles(2);
  let permit = true,
    authorityFault = false,
    runs = 0,
    closed = 0,
    backend = 0,
    transport = 0;
  const role = roles.issue(owner, "/workspace", invocation, () => {
      if (authorityFault) throw Error("current grant unavailable");
      return permit;
    }),
    writes: Buffer[] = [],
    faults: unknown[] = [];
  const peer: CacheBrokerPeer = {
    identity: owner,
    send: async (bytes) => {
      writes.push(Buffer.from(bytes));
    },
    close: () => {
      closed++;
      service.closed(peer);
    },
  };
  const service = new CacheShellService({
    roles,
    clients: 2,
    workspace: "/workspace",
    handshakeMs: 100,
    eligible: () => true,
    validate: async () => "qualified",
    run: async (_input: unknown, options: { emit(channel: "stdout" | "stderr", bytes: Buffer): Promise<void> }) => {
      runs++;
      await options.emit("stdout", Buffer.from("original"));
      return { exitCode: 0, signal: null };
    },
    closeBackend: async () => {
      backend++;
    },
    stopTransport: async () => {
      transport++;
    },
    onError: (e: unknown) => {
      faults.push(e);
    },
    ...extra,
  });
  service.open(peer);
  return {
    service,
    roles,
    role,
    peer,
    writes,
    faults,
    count: () => runs,
    stops: () => [closed, backend, transport],
    revoke: () => {
      permit = false;
    },
    failAuthority: () => {
      authorityFault = true;
    },
  };
}
test("issued roles bind boot/PID/start, exact workspace/invocation and immutable generations", () => {
  const roles = new CacheShellRoles(1),
    role = roles.issue(owner, "/workspace", invocation, () => true),
    lease = roles.bind(owner)!;
  assert.equal(roles.bind({ ...owner, startTicks: "different" }), undefined);
  assert.equal(roles.bind({ ...owner, pid: 124 }), undefined);
  assert.throws(() => roles.issue(owner, "/workspace", invocation, () => true), /bound|identity/);
  roles.advance(role, () => false);
  roles.advance(role, () => true);
  assert.equal(roles.authorized(lease), false);
  assert.equal(roles.authorized(roles.bind(owner)!), true);
  roles.release(role);
  assert.equal(roles.authorized(lease), false);
  assert.equal(roles.size(), 0);
  assert.throws(() => roles.issue(owner, "/other", invocation, () => true), /workspace/);
  assert.throws(
    () => roles.issue(owner, "/workspace\0", { ...invocation, cwd: "/workspace\0" }, () => true),
    /invalid|malformed/,
  );
});
test("CS1 service offers but cannot execute, join or emit payload before client G", async () => {
  const s = setup();
  s.service.data(s.peer, hello());
  await turn();
  assert.deepEqual(s.writes, [Buffer.from("A")]);
  assert.equal(s.count(), 0);
  s.service.data(s.peer, Buffer.from("G"));
  await turn();
  await s.service.shutdown();
  assert.equal(s.count(), 1);
  assert.ok(s.writes.some((b) => b[0] === 79));
  assert.ok(s.writes.some((b) => b[0] === 88));
});
test("revocation at validation and between offer/commit cannot launch and produces explicit R", async () => {
  let release!: (value: string) => void;
  const s = setup({
    validate: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  s.service.data(s.peer, hello());
  await turn();
  s.revoke();
  release("qualified");
  await turn();
  assert.deepEqual(s.writes, [Buffer.from("R")]);
  assert.equal(s.count(), 0);
  await s.service.shutdown();
  const after = setup();
  after.service.data(after.peer, hello());
  await turn();
  after.revoke();
  after.service.data(after.peer, Buffer.from("G"));
  await turn();
  assert.equal(after.count(), 0);
  await after.service.shutdown();
});
test("unavailable current authority is an explicit refusal, not a disconnect optimization bypass", async () => {
  const s = setup();
  s.failAuthority();
  s.service.data(s.peer, hello());
  await turn();
  assert.deepEqual(s.writes, [Buffer.from("R")]);
  assert.equal(s.count(), 0);
  await assert.rejects(s.service.shutdown(), /unresolved/);
  assert.equal(s.faults.length, 1);
});
test("role generation replacement cannot revive an existing offer", async () => {
  const s = setup();
  s.service.data(s.peer, hello());
  await turn();
  s.roles.advance(s.role, () => false);
  s.roles.advance(s.role, () => true);
  s.service.data(s.peer, Buffer.from("G"));
  await turn();
  assert.equal(s.count(), 0);
  await s.service.shutdown();
});
test("unknown context or profile bypass; mismatched claimed invocation and premature G reject", async () => {
  for (const extra of [{ validate: async () => "bypass" }, { eligible: () => false }]) {
    const s = setup(extra);
    s.service.data(s.peer, hello());
    await turn();
    assert.deepEqual(s.writes, [Buffer.from("B")]);
    assert.equal(s.count(), 0);
    await s.service.shutdown();
  }
  const mismatch = setup();
  mismatch.service.data(mismatch.peer, hello("other"));
  await turn();
  assert.deepEqual(mismatch.writes, [Buffer.from("R")]);
  assert.equal(mismatch.count(), 0);
  await mismatch.service.shutdown();
  const early = setup();
  early.service.data(early.peer, Buffer.from("G"));
  await turn();
  assert.equal(early.count(), 0);
  await early.service.shutdown();
});
test("unknown kernel birth cannot attach using another actor's claimed role", async () => {
  const s = setup();
  const stranger = { ...s.peer, identity: { ...owner, pid: 124 } };
  s.service.open(stranger);
  s.service.data(stranger, hello());
  await turn();
  assert.equal(s.count(), 0);
  assert.equal(s.writes.length, 0);
  await s.service.shutdown();
});
test("output awaits bounded credits and current authority is checked after every await", async () => {
  let resume!: () => void,
    entered = false;
  const s = setup({
    run: async (_input: unknown, options: { emit(channel: "stdout", b: Buffer): Promise<void> }) => {
      entered = true;
      await options.emit("stdout", Buffer.alloc(9000));
      return { exitCode: 0, signal: null };
    },
  });
  const original = s.peer.send;
  s.peer.send = async (b) => {
    if (b[0] === 79 && !resume)
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
    await original(b);
  };
  s.service.data(s.peer, hello());
  await turn();
  s.service.data(s.peer, Buffer.from("G"));
  await turn();
  assert.equal(entered, true);
  s.revoke();
  resume();
  await turn();
  assert.ok(s.writes.every((b) => b.length <= 4096));
  assert.ok(!s.writes.some((b) => b[0] === 88));
  await s.service.shutdown();
});
test("disconnect retains late context ownership and shutdown joins independent backend/transport even on error", async () => {
  let release!: (value: string) => void,
    settled = false;
  const s = setup({
    validate: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  s.service.data(s.peer, hello());
  await turn();
  s.service.closed(s.peer);
  const stopping = s.service.shutdown().then(() => {
    settled = true;
  });
  await turn();
  assert.equal(settled, false);
  release("qualified");
  await stopping;
  assert.equal(s.count(), 0);
  assert.deepEqual(s.stops().slice(1), [1, 1]);
  const failure = setup({
    closeBackend: async () => {
      throw Error("backend cleanup unresolved");
    },
  });
  await assert.rejects(failure.service.shutdown(), /unresolved/);
  assert.equal(failure.stops()[2], 1);
});
test("malformed input churn cannot allocate unbounded owned tasks", async () => {
  const s = setup();
  for (let i = 0; i < 100; i++) s.service.data(s.peer, Buffer.from("CS2\0\0\0\0\0"));
  assert.ok(s.service.stats().owned <= 1);
  await s.service.shutdown();
});
test("unawaited output remains owned even when an adapter settles incorrectly", async () => {
  let release!: () => void,
    settled = false;
  const s = setup({
    run: async (_input: unknown, options: { emit(channel: "stdout", b: Buffer): Promise<void> }) => {
      void options.emit("stdout", Buffer.from("x")).catch(() => {});
      return { exitCode: 0, signal: null };
    },
  });
  const send = s.peer.send;
  s.peer.send = async (b) => {
    if (b[0] === 79)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await send(b);
  };
  s.service.data(s.peer, hello());
  await turn();
  s.service.data(s.peer, Buffer.from("G"));
  await turn();
  const stopping = s.service.shutdown().then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await turn();
  assert.equal(settled, false);
  release();
  await stopping;
  assert.ok(!s.writes.some((b) => b[0] === 88));
});
test("eligibility revocation cannot be converted to a B optimization bypass", async () => {
  for (const supported of [false, true]) {
    let validations = 0;
    const s = setup({
      eligible: () => {
        s.revoke();
        return supported;
      },
      validate: async () => {
        validations++;
        return "qualified";
      },
    });
    s.service.data(s.peer, hello());
    await turn();
    assert.deepEqual(s.writes, [Buffer.from("R")]);
    assert.equal(s.count(), 0);
    assert.equal(validations, 0);
    await s.service.shutdown();
  }
});
test("reading peers and retired late validators share one owner admission cap", async () => {
  const release: Array<(value: string) => void> = [];
  const s = setup({
    validate: () =>
      new Promise((resolve) => {
        release.push(resolve);
      }),
  });
  s.service.data(s.peer, hello());
  await turn();
  s.service.closed(s.peer);
  s.roles.release(s.role);
  const extra = (pid: number) => {
    const identity = { ...owner, pid };
    s.roles.issue(identity, "/workspace", invocation, () => true);
    const peer: CacheBrokerPeer = {
      identity,
      send: async () => {},
      close: () => {
        s.service.closed(peer);
      },
    };
    s.service.open(peer);
    return peer;
  };
  const first = extra(124),
    second = extra(125);
  s.service.data(first, hello());
  s.service.data(second, hello());
  await turn();
  try {
    assert.ok(s.service.stats().owned <= 2, "one retired validator plus one new transaction exhausts clients2");
  } finally {
    const stopping = s.service.shutdown();
    for (const settle of release) settle("qualified");
    await stopping;
  }
});
test("native role preserves nonlexical environment order and refuses different wire order", () => {
  const roles = new CacheShellRoles(1);
  const role = roles.issue(owner, "/workspace", { ...invocation, env: { Z: "last", A: "first" } }, () => true);
  const lease = roles.bind(owner)!;
  assert.deepEqual(Object.keys(roles.invocation(lease)!.env), ["Z", "A"]);
  const request = {
    shell: "/bin/bash",
    cwd: "/workspace",
    args: ["-c", "literal"],
    environment: ["Z=last", "A=first"],
  };
  assert.equal(roles.matches(lease, request), true);
  assert.equal(roles.matches(lease, { ...request, environment: [...request.environment].reverse() }), false);
  roles.release(role);
  assert.equal(roles.size(), 0);
});
test("an authority callback cannot return true for a lease it replaced during its own check", () => {
  const roles = new CacheShellRoles(1);
  const role = roles.issue(owner, "/workspace", invocation, () => {
    roles.advance(role, () => true);
    return true;
  });
  assert.equal(roles.authorized(roles.bind(owner)!), false);
  assert.equal(roles.authorized(roles.bind(owner)!), true);
});
test("handshake deadline and malformed commit never trigger a run or retry", async () => {
  const s = setup({ handshakeMs: 5 });
  s.service.data(s.peer, hello());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(s.count(), 0);
  await s.service.shutdown();
  const bad = setup();
  bad.service.data(bad.peer, hello());
  await turn();
  bad.service.data(bad.peer, Buffer.from("GG"));
  await turn();
  assert.equal(bad.count(), 0);
  await bad.service.shutdown();
});
