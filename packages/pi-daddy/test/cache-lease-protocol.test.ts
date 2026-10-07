import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCacheLeaseFrame } from "../src/kernel/cache-lease-protocol.ts";

test("lease protocol separates readiness, replies and irreversible loss", () => {
  assert.deepEqual(parseCacheLeaseFrame("READY 2 123 1000 1 8192 192 250\n"), {
    kind: "ready",
    parent: 123,
    uid: 1000,
    privileged: true,
    capacity: 8192,
    frameBytes: 192,
    breakMs: 250,
  });
  assert.deepEqual(parseCacheLeaseFrame("R 1 ACQUIRED 42 2096 36331\n"), {
    kind: "reply",
    seq: 1,
    status: "acquired",
    id: "42",
    dev: "2096",
    ino: "36331",
  });
  assert.deepEqual(parseCacheLeaseFrame("R 2 REFUSED 42 LEASE 11\n"), {
    kind: "reply",
    seq: 2,
    status: "refused",
    id: "42",
    reason: "LEASE",
    errno: 11,
  });
  assert.deepEqual(parseCacheLeaseFrame("R 3 VALID 42\n"), { kind: "reply", seq: 3, status: "valid", id: "42" });
  assert.deepEqual(parseCacheLeaseFrame("R 4 INVALID 42 BREAKING\n"), {
    kind: "reply",
    seq: 4,
    status: "invalid",
    id: "42",
    reason: "BREAKING",
  });
  assert.deepEqual(parseCacheLeaseFrame("R 5 RELEASED 42\n"), { kind: "reply", seq: 5, status: "released", id: "42" });
  assert.deepEqual(parseCacheLeaseFrame("E BREAK 42\n"), { kind: "break", id: "42" });
  assert.deepEqual(parseCacheLeaseFrame("E LOSS 42 TIMEOUT 0\n"), {
    kind: "loss",
    id: "42",
    reason: "TIMEOUT",
    errno: 0,
  });
  assert.deepEqual(parseCacheLeaseFrame("F ERROR PEER_GONE\n"), { kind: "fatal", reason: "PEER_GONE" });
});

test("unknown, malformed, overflowed or oversized lease evidence never becomes validity", () => {
  for (const frame of [
    "",
    "R 1 VALID 42",
    "R 1 VALID 42\r\n",
    "R  1 VALID 42\n",
    "R 1 VALID 42 extra\n",
    "R 0 VALID 42\n",
    "R 9007199254740992 VALID 42\n",
    "R 1 VALID -1\n",
    "R 1 VALID 0\n",
    "R 1 VALID 01\n",
    "R 1 VALID 18446744073709551616\n",
    "R 1 MAYBE 42\n",
    "E LOSS 42 TIMEOUT -1\n",
    "READY 1 123 1000 0 8192 192 250\n",
    "READY 2 123 0 1 8192 192 250\n",
    "READY 2 123 1000 2 8192 192 250\n",
    "READY 2 123 1000 1 8193 192 250\n",
    "READY 2 123 1000 1 8192 999 250\n",
    "E BREAK 42\nR 1 VALID 42\n",
    "E BREAK 4\0\n",
    `F ERROR ${"A".repeat(192)}\n`,
    "F ERROR café\n",
  ])
    assert.throws(() => parseCacheLeaseFrame(frame), /cache lease protocol/, JSON.stringify(frame));
});
