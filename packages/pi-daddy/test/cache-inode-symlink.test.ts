/** Symlink inode metadata scope; NOT target immutability, source freshness or eligibility. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInodeFrame, INODE_MASK } from "../src/kernel/cache-inode-protocol.ts";
import { InodeEpochs } from "../src/kernel/cache-inode-epochs.ts";
const aliases = [
  { index: 0, wd: 1, dev: "42", ino: "10", kind: "symlink" },
  { index: 1, wd: 1, dev: "42", ino: "10", kind: "symlink" },
] as const;
test("canonical symlink watch frames preserve explicit type; unknown types still refuse", () => {
  assert.deepEqual(parseInodeFrame("I1 W 0 1 42 10 symlink\n"), { kind: "watch", object: aliases[0] });
  for (const type of ["Symlink", "socket", "symlink-target"])
    assert.throws(() => parseInodeFrame(`I1 W 0 1 42 10 ${type}\n`), /malformed or incompatible/);
});
test("symlink aliases share irreversible metadata/move epochs, never convert into target watches", () => {
  const state = new InodeEpochs(aliases),
    old = state.ticket([0, 1]);
  state.event({ wd: 1, mask: INODE_MASK.ATTRIB, cookie: 0, nameHex: "" });
  assert.equal(state.observationsUnchanged(old), false);
  const next = state.ticket([0]);
  state.event({ wd: 1, mask: INODE_MASK.MOVE_SELF, cookie: 0, nameHex: "" });
  assert.equal(state.observationsUnchanged(next), false);
  assert.equal(state.manifest()[0].kind, "symlink");
  assert.throws(() => new InodeEpochs([aliases[0], { ...aliases[1], kind: "file" }]), /identity/);
});
test("symlink membership/ISDIR/named self and loss evidence remain permanently incompatible", () => {
  for (const event of [
    { wd: 1, mask: INODE_MASK.CREATE, cookie: 0, nameHex: "61" },
    { wd: 1, mask: INODE_MASK.ATTRIB | INODE_MASK.ISDIR, cookie: 0, nameHex: "" },
    { wd: 1, mask: INODE_MASK.MOVE_SELF, cookie: 0, nameHex: "61" },
    { wd: 1, mask: INODE_MASK.IGNORED, cookie: 0, nameHex: "" },
  ]) {
    const state = new InodeEpochs(aliases),
      old = state.ticket([0]);
    assert.throws(() => state.event(event), /lost/);
    assert.equal(state.observationsUnchanged(old), false);
  }
});
