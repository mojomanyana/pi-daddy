import assert from "node:assert/strict";
import { test } from "node:test";
import { registerDashboardSources } from "../extensions/dashboard-sources.ts";
import {
  DASHBOARD_SOURCE_EVENT,
  type DashboardSourceRefreshCallback,
  type DashboardSourceRegistrationReply,
  type DashboardSourceUpdate,
} from "../src/kernel/dashboard-observation.ts";

const fresh = (sequence = 0): DashboardSourceUpdate => ({
  sequence,
  items: [],
  inventory: {
    scope: "Current workspace",
    state: "available",
    summary: "Saved project notes",
    count: 1,
    limited: false,
    entries: [{ id: "note", title: "Print layout", summary: "Use a landscape layout" }],
  },
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const handlers = new Map<string, (value: unknown) => void>();
  let owner = { sessionId: "native", cwd: "/workspace" },
    time = 1_000_000;
  const sources = registerDashboardSources(
    {
      events: {
        on(name: string, handler: (value: unknown) => void) {
          handlers.set(name, handler);
          return () => handlers.delete(name);
        },
      },
    } as never,
    () => owner,
    () => time,
  );
  return {
    sources,
    advance(ms: number) {
      time += ms;
    },
    replaceOwner() {
      owner = { ...owner };
    },
    register(refresh?: DashboardSourceRefreshCallback) {
      let reply: DashboardSourceRegistrationReply | undefined;
      handlers.get(DASHBOARD_SOURCE_EVENT)!({
        version: 1,
        ...owner,
        producer: "bookie-memory",
        producerVersion: "test",
        ...(refresh ? { refresh } : {}),
        reply: (value: DashboardSourceRegistrationReply) => {
          reply = value;
        },
      });
      assert.ok(reply?.ok);
      assert.deepEqual(reply.capabilities, { inventory: 1, refresh: 1 });
      return reply;
    },
    current() {
      return sources.snapshot()!.sources[0];
    },
  };
}

test("visible demand refreshes zero-choice idle content beyond TTL; passive polls never renew its observed age", async () => {
  const f = fixture();
  let calls = 0;
  const source = f.register(() => fresh(++calls));
  assert.equal(source.publish(fresh()), true);
  const original = f.current().observedAt;
  f.advance(121_000);
  assert.equal(f.current().observedAt, original);
  assert.equal(calls, 0);
  assert.equal(f.sources.choices.requestRenewal(), false);
  assert.equal(f.sources.requestRefresh(), true);
  assert.equal(f.sources.requestRefresh(), true);
  assert.equal(f.current().refresh?.state, "checking");
  assert.equal(f.current().observedAt, original);
  await settle();
  assert.equal(calls, 1);
  assert.notEqual(f.current().observedAt, original);
  assert.equal(f.current().refresh?.state, "idle");
  assert.equal(f.sources.requestRefresh(), false);
  f.advance(29_999);
  assert.equal(f.sources.requestRefresh(), false);
  f.advance(1);
  assert.equal(f.sources.requestRefresh(), true);
  await settle();
  assert.equal(calls, 2);
  f.sources.close();
});

test("first visible demand is immediate and status-only publications cannot starve inventory refresh", async () => {
  const f = fixture();
  let sequence = 0,
    calls = 0;
  const source = f.register(() => {
    calls++;
    return fresh(++sequence);
  });
  source.publish({ sequence: sequence++, items: [] });
  assert.equal(f.sources.requestRefresh(), true, "initial status publication does not defer inventory for 30 seconds");
  await settle();
  assert.equal(calls, 1);
  assert.ok(f.current().inventory);
  for (let i = 0; i < 3; i++) {
    f.advance(10_000);
    source.publish({ sequence: ++sequence, items: [] });
    assert.equal(f.sources.requestRefresh(), i === 2, "spacing follows refresh attempts, not frequent status events");
  }
  await settle();
  assert.equal(calls, 2);
  assert.ok(f.current().inventory);
  f.sources.close();
});

test("undefined, thrown and invalid refreshes preserve original age and use bounded exponential backoff", async () => {
  const f = fixture();
  let calls = 0;
  const source = f.register(() => {
    calls++;
    if (calls === 2) throw Error("private diagnostic");
    if (calls === 3) return { ...fresh(calls), unexpected: true } as DashboardSourceUpdate;
    return undefined;
  });
  source.publish(fresh());
  const original = f.current().observedAt;
  f.advance(30_000);
  for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
    assert.equal(f.sources.requestRefresh(), true);
    await settle();
    const value = f.current();
    assert.equal(value.refresh?.state, "failed");
    assert.equal(Date.parse(value.refresh!.nextAttemptAt!) - Date.parse(value.refresh!.attemptedAt!), delay);
    assert.equal(value.observedAt, original);
    assert.doesNotMatch(JSON.stringify(value), /private diagnostic/);
    f.advance(delay - 1);
    assert.equal(f.sources.requestRefresh(), false);
    f.advance(1);
  }
  assert.equal(calls, 6);
  f.sources.close();
});

test("timeout aborts and fences a late result without overlapping an uncooperative callback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  let resolve!: (value: DashboardSourceUpdate) => void,
    signal!: AbortSignal,
    calls = 0;
  f.register((request) => {
    signal = request.signal;
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  assert.equal(f.sources.requestRefresh(), true);
  await settle();
  f.advance(5_000);
  t.mock.timers.tick(5_000);
  assert.equal(signal.aborted, true);
  assert.equal(f.current().refresh?.state, "failed");
  f.advance(300_000);
  assert.equal(f.sources.requestRefresh(), false);
  assert.equal(calls, 1);
  resolve(fresh());
  await settle();
  assert.equal(f.current().inventory, undefined);
  assert.equal(f.current().sequence, -1);
  assert.equal(f.sources.requestRefresh(), true);
  await settle();
  assert.equal(calls, 2);
  f.sources.close();
  resolve(fresh());
  await settle();
});

test("owner replacement, source replacement and close withdraw inventory and cancel late callbacks", async () => {
  for (const transition of ["owner", "replace", "close", "shutdown"] as const) {
    const f = fixture();
    let resolve!: (value: DashboardSourceUpdate) => void, signal!: AbortSignal;
    const source = f.register((request) => {
      signal = request.signal;
      return new Promise((done) => {
        resolve = done;
      });
    });
    source.publish(fresh());
    const detached = f.current();
    detached.inventory!.entries[0].title = "tampered";
    assert.equal(f.current().inventory!.entries[0].title, "Print layout");
    f.advance(30_000);
    f.sources.requestRefresh();
    await settle();
    if (transition === "owner") {
      f.replaceOwner();
      f.sources.snapshot();
    }
    if (transition === "replace") f.register();
    if (transition === "close") source.close();
    if (transition === "shutdown") f.sources.close();
    assert.equal(signal.aborted, true);
    resolve(fresh(1));
    await settle();
    assert.equal(source.publish(fresh(2)), false);
    assert.doesNotMatch(JSON.stringify(f.sources.snapshot()) ?? "", /Print layout|landscape/);
    f.sources.close();
  }
});

test("a refresh may close its source and its returned content cannot reopen it", async () => {
  const f = fixture();
  const source = f.register(() => {
    source.close();
    return fresh(1);
  });
  f.sources.requestRefresh();
  await settle();
  assert.equal(f.current().availability, "closed");
  assert.equal(f.current().inventory, undefined);
  assert.equal(f.sources.requestRefresh(), false);
  f.sources.close();
});

test("ordinary fresh publication recovers failed readiness and supersedes an older pending refresh", async () => {
  const f = fixture();
  let calls = 0,
    resolve!: (value: DashboardSourceUpdate) => void,
    signal!: AbortSignal;
  const source = f.register((request) => {
    calls++;
    if (calls === 1) return undefined;
    signal = request.signal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  f.sources.requestRefresh();
  await settle();
  assert.equal(f.current().refresh?.state, "failed");
  assert.equal(source.publish(fresh(1)), true);
  assert.equal(f.current().refresh?.state, "idle");
  assert.equal(f.sources.requestRefresh(), false);
  f.advance(30_000);
  f.sources.requestRefresh();
  await settle();
  assert.equal(calls, 2);
  const changed = fresh(2);
  changed.inventory!.entries[0].summary = "Use a portrait layout";
  assert.equal(source.publish(changed), true);
  assert.equal(signal.aborted, true);
  assert.equal(f.current().refresh?.state, "idle");
  const observed = f.current().observedAt;
  f.advance(30_000);
  assert.equal(f.sources.requestRefresh(), false, "the aborted callback cannot overlap another scan");
  resolve(fresh(99));
  await settle();
  assert.equal(f.current().sequence, 2);
  assert.equal(f.current().observedAt, observed);
  assert.equal(f.current().refresh?.state, "idle");
  assert.equal(f.sources.requestRefresh(), true);
  await settle();
  f.sources.close();
  resolve(fresh(3));
  await settle();
});

test("status publications with unchanged cached inventory do not cancel a pending inventory check", async () => {
  const f = fixture();
  let resolve!: (value: DashboardSourceUpdate) => void, signal!: AbortSignal;
  const source = f.register((request) => {
    signal = request.signal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  source.publish(fresh(0));
  f.sources.requestRefresh();
  await settle();
  source.publish(fresh(1));
  assert.equal(signal.aborted, false);
  source.publish({ sequence: 2, items: [] });
  assert.equal(signal.aborted, false);
  assert.equal(f.current().refresh?.state, "checking");
  resolve(fresh(3));
  await settle();
  assert.equal(f.current().sequence, 3);
  assert.ok(f.current().inventory);
  assert.equal(f.current().refresh?.state, "idle");
  f.sources.close();
});

test("a cancelled callback rejection cannot mark a newer ordinary inventory publication as failed", async () => {
  const f = fixture();
  const source = f.register(
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Error("cancelled old read")), { once: true });
      }),
  );
  f.sources.requestRefresh();
  await settle();
  assert.equal(source.publish(fresh(1)), true);
  await settle();
  assert.equal(f.current().refresh?.state, "idle");
  assert.equal(f.current().sequence, 1);
  assert.ok(f.current().inventory);
  f.sources.close();
});

test("cached and status-only events preserve failed readiness and backoff until a successful refresh", async () => {
  const f = fixture();
  let calls = 0,
    sequence = 0;
  const source = f.register(() => (++calls <= 2 ? undefined : fresh(++sequence)));
  source.publish(fresh(sequence));
  f.sources.requestRefresh();
  await settle();
  f.advance(30_000);
  f.sources.requestRefresh();
  await settle();
  const failed = f.current().refresh!;
  assert.equal(failed.state, "failed");
  assert.equal(Date.parse(failed.nextAttemptAt!) - Date.parse(failed.attemptedAt!), 60_000);
  source.publish(fresh(++sequence));
  assert.deepEqual(f.current().refresh, failed);
  source.publish({ sequence: ++sequence, items: [] });
  assert.deepEqual(f.current().refresh, failed);
  f.advance(59_999);
  assert.equal(f.sources.requestRefresh(), false);
  f.advance(1);
  assert.equal(f.sources.requestRefresh(), true);
  await settle();
  assert.equal(calls, 3);
  assert.equal(f.current().refresh?.state, "idle");
  assert.ok(f.current().inventory);
  f.sources.close();
});
