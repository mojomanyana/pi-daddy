import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChecksumMembers } from "../src/kernel/cache-checksum-members.ts";
const hash = "ab".repeat(32);
const limits = { maxBytes: 1024, maxMembers: 2 };
const parse = (text: string) => parseChecksumMembers(Buffer.from(text), limits);

test("declared checksum members preserve order, exact paths and text/binary markers", () => {
  assert.deepEqual(parse(`${hash}  src/a.ts\n${hash} */usr/bin/gnusha256sum\n`), {
    kind: "members",
    members: [
      { path: "src/a.ts", sha256: hash, binary: false },
      { path: "/usr/bin/gnusha256sum", sha256: hash, binary: true },
    ],
  });
});
test("stdin and noncanonical/escaped record names bypass instead of declaring file dependencies", () => {
  for (const path of ["-", "a/../b", "./a", "a//b", "/", "a/", "a b", "日本語", "a\\nb", "a\0b"]) {
    assert.equal(parse(`${hash}  ${path}\n`).kind, "bypass", path);
  }
});
test("unsupported digest, marker, trailing record and malformed lines reject the entire inventory", () => {
  for (const text of [
    "",
    `${hash}  a`,
    `${hash.toUpperCase()}  a\n`,
    `${hash} ?a\n`,
    `${hash}  a\r\n`,
    `${hash}  a\n\n`,
    `${hash}  a\ninvalid\n`,
    `\\${hash}  a\n`,
  ]) {
    assert.equal(parse(text).kind, "bypass", JSON.stringify(text));
  }
});
test("duplicate declared names bypass even with matching digests; changed digests cannot hide ambiguity", () => {
  for (const second of [hash, "cd".repeat(32)]) {
    assert.equal(parse(`${hash}  a\n${second}  a\n`).kind, "bypass");
  }
});
test("explicit byte and member budgets admit their boundary and reject just beyond", () => {
  const record = Buffer.from(`${hash}  a\n`);
  assert.equal(parseChecksumMembers(record, { maxBytes: record.length, maxMembers: 1 }).kind, "members");
  assert.equal(parseChecksumMembers(record, { maxBytes: record.length - 1, maxMembers: 1 }).kind, "bypass");
  assert.equal(parse(`${hash}  a\n${hash}  b\n`).kind, "members");
  assert.equal(parse(`${hash}  a\n${hash}  b\n${hash}  c\n`).kind, "bypass");
});
test("malformed limits fail closed and name the offending field", () => {
  for (const field of ["maxBytes", "maxMembers"] as const) {
    for (const value of [0, -1, NaN, Infinity, 1.5]) {
      const result = parseChecksumMembers(Buffer.from(`${hash}  a\n`), { ...limits, [field]: value });
      assert.equal(result.kind, "bypass");
      if (result.kind === "bypass") assert.match(result.reason, new RegExp(field));
    }
  }
});
test("parsing retains no caller byte view and returns frozen declaration data, not eligibility", () => {
  const input = Buffer.from(`${hash}  a\n`),
    result = parseChecksumMembers(input, limits);
  input.fill(0);
  assert.equal(result.kind, "members");
  if (result.kind === "members") {
    assert.deepEqual(result.members, [{ path: "a", sha256: hash, binary: false }]);
    assert.equal(Object.isFrozen(result.members), true);
    assert.equal(Object.isFrozen(result.members[0]), true);
    assert.equal("eligible" in result, false);
  }
});
