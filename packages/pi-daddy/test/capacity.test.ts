/** Regressions: concurrent double-spend, zero inheritance widening, stale receipt refunds, and duplicate finalization. */
import assert from "node:assert/strict";
import test from "node:test";
import { createCapacityAllocator, type CapacityReservation } from "../src/kernel/capacity.ts";
import type { CapturedWorkerIdentity, CapturedWorkerCleanup } from "../src/kernel/captured-worker-contract.ts";

function reserve(
  allocator: ReturnType<typeof createCapacityAllocator>,
  id: string,
  allowance = 0,
): CapacityReservation {
  const value = allocator.reserve(id, allowance);
  assert.equal(value.ok, true);
  return value.reservation;
}
function identity(id: string): CapturedWorkerIdentity {
  return {
    revision: 1,
    executionId: id,
    nonce: "nonce",
    root: "/fixture",
    rootDevice: "1",
    rootInode: "2",
    bootId: "boot",
    pidNamespace: "pid:[1]",
    helperPid: 100,
    helperStartTicks: "200",
    helperSha256: "a".repeat(64),
    workerPid: 101,
    ownershipPath: "/fixture/ownership.json",
    receiptPath: "/fixture/receipt.json",
  };
}
function settled(actual: CapturedWorkerIdentity): CapturedWorkerCleanup {
  return {
    state: "settled",
    identity: actual,
    receipt: {
      state: "settled",
      identity: { ...actual },
      workerCode: 0,
      workerSignal: 0,
      reason: "worker-exit",
      reapedAll: true,
    },
  };
}
const notStarted: CapturedWorkerCleanup = { state: "not-started", reason: "local prelaunch refusal" };

test("overlapping reservations conserve disjoint subtree allowances and retain rounding slack", () => {
  const root = createCapacityAllocator(7);
  const a = reserve(root, "a", 3);
  const b = reserve(root, "b", 1);
  assert.equal(root.available, 1);
  assert.equal(root.reserved, 6);
  assert.equal(root.reserve("too-wide", 1).ok, false);
  const c = reserve(root, "c");
  assert.equal(root.available, 0);
  assert.equal(root.reserve("extra", 0).ok, false);
  const nested = createCapacityAllocator(a.childAllowance);
  reserve(nested, "grandchild", 2);
  assert.equal(nested.reserve("nested-extra", 0).ok, false);
  // Root child a + its three descendants, child b + one descendant, and child c fit exactly seven.
  assert.equal(a.cost + b.cost + c.cost, 7);
});

test("zero is a usable exhausted allowance and invalid numbers never grant capacity", () => {
  assert.equal(createCapacityAllocator(0).reserve("cannot-start", 0).ok, false);
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createCapacityAllocator(value));
    assert.equal(createCapacityAllocator(4).reserve("invalid", value).ok, false);
  }
  assert.equal(createCapacityAllocator(Number.MAX_SAFE_INTEGER).reserve("overflow", Number.MAX_SAFE_INTEGER).ok, false);
});

test("settled and proven-not-started return once, so repeated tasks do not exhaust a lifetime quota", () => {
  const root = createCapacityAllocator(2);
  const stopped = reserve(root, "before-start", 1);
  assert.equal(stopped.finalize(notStarted), "released");
  assert.equal(stopped.finalize(notStarted), "released");
  assert.equal(root.available, 2);
  for (let index = 0; index < 50; index++) {
    const id = `actual-${index}`;
    const item = reserve(root, id, 1);
    const actual = identity(id);
    item.bindOwnership(actual);
    assert.equal(item.finalize(settled(actual)), "released");
    assert.equal(item.finalize(settled(actual)), "released");
    assert.equal(root.available, 2);
  }
  assert.equal(root.reserve("before-start", 0).ok, false, "old occurrence IDs are never reused");
});

test("unknown keeps its allowance and cannot later be laundered as not-started", () => {
  const root = createCapacityAllocator(1);
  const item = reserve(root, "unknown");
  assert.equal(item.finalize({ state: "unknown", reason: "helper missing" }), "retained");
  assert.equal(item.finalize(notStarted), "retained");
  assert.equal(root.available, 0);
  assert.equal(root.reserve("would-overlap", 0).ok, false);
});

test("only exact originally bound settlement can reconcile uncertainty", () => {
  const root = createCapacityAllocator(1);
  const item = reserve(root, "bound");
  const original = identity("bound");
  item.bindOwnership(original);
  original.nonce = "mutated caller";
  const expected = identity("bound");
  assert.equal(item.finalize(notStarted), "retained");
  assert.equal(item.finalize(settled({ ...expected, nonce: "another-launch" })), "retained");
  const mismatchedReceipt = settled(expected);
  assert.equal(mismatchedReceipt.state, "settled");
  if (mismatchedReceipt.state === "settled") mismatchedReceipt.receipt.identity.rootInode = "different";
  assert.equal(item.finalize(mismatchedReceipt), "retained");
  assert.equal(root.available, 0);
  assert.equal(item.finalize(settled(expected)), "released");
  assert.equal(root.available, 1);
});

test("unbound or another execution's receipt cannot refund a reservation", () => {
  const root = createCapacityAllocator(1);
  const item = reserve(root, "bound");
  assert.equal(item.finalize(settled(identity("bound"))), "retained");
  assert.throws(() => item.bindOwnership(identity("other")));
  item.bindOwnership(identity("bound"));
  assert.throws(() => item.bindOwnership({ ...identity("bound"), helperStartTicks: "reused" }));
  assert.equal(item.finalize(settled(identity("other"))), "retained");
  assert.equal(item.finalize(settled(identity("bound"))), "released");
  assert.throws(() => item.bindOwnership(identity("bound")));
});
