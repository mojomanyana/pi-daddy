/** Pure observation state; tickets are NOT source/freshness certificates. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInodeFrame, INODE_MASK, INODE_MAX_FRAME } from "../src/kernel/cache-inode-protocol.ts";
import { InodeEpochs } from "../src/kernel/cache-inode-epochs.ts";

const objects = [
  { index: 0, wd: 1, dev: "42", ino: "10", kind: "file" as const },
  { index: 1, wd: 1, dev: "42", ino: "10", kind: "file" as const },
  { index: 2, wd: 2, dev: "42", ino: "11", kind: "directory" as const },
];
test("inode frames are versioned, canonical and bounded with arbitrary filename bytes encoded", () => {
  assert.deepEqual(parseInodeFrame("I1 READY 3\n"), { kind: "ready", count: 3 });
  assert.deepEqual(parseInodeFrame("I1 W 0 1 42 10 file\n"), { kind: "watch", object: objects[0] });
  assert.deepEqual(parseInodeFrame("I1 E 2 256 0 ff20\n"), {
    kind: "event",
    wd: 2,
    mask: 256,
    cookie: 0,
    nameHex: "ff20",
  });
  assert.deepEqual(parseInodeFrame("I1 D 1\n"), { kind: "drained", seq: 1 });
  assert.deepEqual(parseInodeFrame("I1 ARMED\n"), { kind: "armed" });
  assert.deepEqual(parseInodeFrame("I1 F WATCH 13\n"), { kind: "fault", reason: "WATCH", errno: 13 });
  for (const frame of [
    "I2 ARMED\n",
    "I1 E 01 4 0 -\n",
    "I1 E 1 4 0 f\n",
    "I1 E 1 4 0 00\n",
    "I1 E 1 4 0 FF\n",
    "I1 E 1 4 0 2f\n",
    "I1 E 1 4 4294967296 -\n",
    "I1 E -2 4 0 -\n",
    "I1 D 0\n",
    "I1 READY 4097\n",
    "I1 ARMED",
    "I1 ARMED\r\n",
    "I1  ARMED\n",
    "I1 E 1 4 0 " + "aa".repeat(INODE_MAX_FRAME) + "\n",
  ])
    assert.throws(() => parseInodeFrame(frame), /inode observation frame/);
});

test("logical aliases share physical epochs; restore/coalescing/cookies never resurrect tickets", () => {
  const state = new InodeEpochs(objects),
    ticket = state.ticket([0, 1]),
    parent = state.ticket([2]);
  assert.equal(state.observationsUnchanged(ticket), true);
  state.event({ wd: 1, mask: INODE_MASK.ATTRIB, cookie: 0, nameHex: "" });
  assert.equal(state.observationsUnchanged(ticket), false);
  assert.equal(state.observationsUnchanged(parent), true);
  state.event({ wd: 1, mask: INODE_MASK.ATTRIB, cookie: 99, nameHex: "" });
  assert.equal(state.observationsUnchanged(ticket), false);
  const now = state.ticket([0]);
  assert.equal(
    state.observationsUnchanged(now),
    true,
    "new processed-observation baseline, NOT restored source validity",
  );
  state.event({ wd: 2, mask: INODE_MASK.MOVED_FROM, cookie: 7, nameHex: "66696c65" });
  assert.equal(state.observationsUnchanged(parent), false);
});

test("scope is fixed and immediate, never recursive or pathname-following", () => {
  const state = new InodeEpochs(objects),
    ticket = state.ticket([0, 2]);
  state.event({ wd: 2, mask: INODE_MASK.CREATE, cookie: 0, nameHex: "6e6577" });
  assert.equal(state.observationsUnchanged(ticket), false);
  assert.throws(() => state.ticket([3]), /uncovered/);
  assert.throws(() => state.ticket([]), /scope/);
  assert.throws(() => state.ticket([0, 0]), /scope/);
  const manifest = state.manifest();
  manifest[0].ino = "999";
  assert.equal(state.manifest()[0].ino, "10", "caller cannot change physical coverage");
});

test("lost streams, ignored/unmount/overflow and unknown watch/mask are irreversible", () => {
  for (const event of [
    { wd: -1, mask: INODE_MASK.OVERFLOW, cookie: 0, nameHex: "" },
    { wd: 1, mask: INODE_MASK.IGNORED, cookie: 0, nameHex: "" },
    { wd: 1, mask: INODE_MASK.UNMOUNT, cookie: 0, nameHex: "" },
    { wd: 99, mask: INODE_MASK.ATTRIB, cookie: 0, nameHex: "" },
    { wd: 1, mask: 1, cookie: 0, nameHex: "" },
  ]) {
    const state = new InodeEpochs(objects),
      ticket = state.ticket([0]);
    assert.throws(() => state.event(event), /inode observation/);
    assert.equal(state.observationsUnchanged(ticket), false);
    assert.throws(() => state.ticket([0]), /lost/);
  }
  const state = new InodeEpochs(objects),
    ticket = state.ticket([0]);
  state.lose("transport ended");
  assert.equal(state.observationsUnchanged(ticket), false);
  state.lose("new reason");
  assert.match(state.lossReason!, /transport ended/);
});

test("foreign/fabricated tickets and inconsistent physical identities refuse", () => {
  const first = new InodeEpochs(objects),
    second = new InodeEpochs(objects);
  assert.throws(() => first.observationsUnchanged(second.ticket([0])), /foreign or fabricated/);
  assert.throws(() => first.observationsUnchanged({}), /foreign or fabricated/);
  assert.throws(() => new InodeEpochs([...objects.slice(0, 1), { ...objects[1], ino: "12" }]), /identity/);
  assert.throws(() => new InodeEpochs([{ ...objects[0], index: 1 }]), /index/);
  assert.throws(() => new InodeEpochs([]), /count/);
});

test("one physical identity cannot acquire two different watch descriptors (REV-001)", () => {
  assert.throws(() => new InodeEpochs([objects[0], { ...objects[1], wd: 3 }]), /identity/);
});

test("incompatible watch type, self and membership evidence irreversibly loses observation (REV-003)", () => {
  for (const event of [
    { wd: 1, mask: INODE_MASK.CREATE, cookie: 0, nameHex: "61" },
    { wd: 1, mask: INODE_MASK.ATTRIB | INODE_MASK.ISDIR, cookie: 0, nameHex: "" },
    { wd: 2, mask: INODE_MASK.CREATE, cookie: 0, nameHex: "" },
    { wd: 2, mask: INODE_MASK.MOVE_SELF, cookie: 0, nameHex: "61" },
    { wd: 2, mask: INODE_MASK.MOVE_SELF | INODE_MASK.ISDIR, cookie: 0, nameHex: "" },
    { wd: 2, mask: INODE_MASK.ATTRIB, cookie: 0, nameHex: "" },
  ]) {
    const state = new InodeEpochs(objects),
      ticket = state.ticket([0]);
    assert.throws(() => state.event(event), /incompatible/);
    assert.equal(state.observationsUnchanged(ticket), false);
  }
  const state = new InodeEpochs(objects);
  // Exact audited inotify compatibility: directory MOVE_SELF/DELETE_SELF do NOT carry ISDIR.
  state.event({ wd: 2, mask: INODE_MASK.MOVE_SELF, cookie: 0, nameHex: "" });
  state.event({ wd: 2, mask: INODE_MASK.ATTRIB | INODE_MASK.ISDIR, cookie: 0, nameHex: "" });
  state.event({ wd: 2, mask: INODE_MASK.CREATE | INODE_MASK.ISDIR, cookie: 0, nameHex: "61" });
});

test("epoch exhaustion loses all tickets instead of wraparound", () => {
  const state = new InodeEpochs(objects, 2),
    ticket = state.ticket([2]);
  state.event({ wd: 1, mask: INODE_MASK.ATTRIB, cookie: 0, nameHex: "" });
  state.event({ wd: 1, mask: INODE_MASK.ATTRIB, cookie: 0, nameHex: "" });
  assert.throws(() => state.event({ wd: 1, mask: INODE_MASK.ATTRIB, cookie: 0, nameHex: "" }), /epoch/);
  assert.equal(state.observationsUnchanged(ticket), false);
});
