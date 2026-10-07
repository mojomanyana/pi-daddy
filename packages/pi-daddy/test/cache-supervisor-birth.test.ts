/** LC-002/003/013: bootstrap claims identify no namespace without independent source/parent verification. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { acquireCacheSupervisorNamespace, parseCacheSupervisorBirth } from "../src/executors/cache-supervisor-birth.ts";
const root = { pid: 100, bootId: "11111111-1111-1111-1111-111111111111", startTicks: "10" },
  launcher = { ...root, pid: 101, startTicks: "11" },
  birth = { ...root, pid: 102, startTicks: "12" };
const frame = (owner: unknown) => Buffer.from(JSON.stringify({ piDaddyCacheSupervisor: 1, birth: owner }));
test("malformed/extra/application frames cannot supply namespace birth authority", () => {
  assert.deepEqual(parseCacheSupervisorBirth(frame(birth)), birth);
  const atBound = Buffer.concat([frame(birth), Buffer.alloc(1024 - frame(birth).length, 32)]);
  assert.deepEqual(parseCacheSupervisorBirth(atBound), birth);
  assert.throws(() => parseCacheSupervisorBirth(Buffer.concat([atBound, Buffer.from(" ")])), /bootstrap birth.*bound/);
  for (const value of [
    "PENDING anything",
    '{"type":"owner","owner":{}}',
    "null",
    JSON.stringify({ piDaddyCacheSupervisor: 1, birth, ready: true }),
    JSON.stringify({ piDaddyCacheSupervisor: 1, birth: { ...birth, pid: -1 } }),
  ])
    assert.throws(() => parseCacheSupervisorBirth(Buffer.from(value)), /bootstrap birth/);
});
test("only independently matching private PID1 and launcher parent may be acquired", async () => {
  let status = "PPid:\t101\nNSpid:\t102\t1\n",
    actual = birth,
    ownerLive = true,
    observed = 0;
  const ports = {
    matches: async () => ownerLive,
    readOwner: async () => actual,
    status: async () => status,
    observe: async () => {
      observed++;
      return { owner: birth, procRoot: "private", closed: false, handle: { close: async () => {} } };
    },
  };
  await acquireCacheSupervisorNamespace(birth, root, launcher, ports);
  assert.equal(observed, 1);
  actual = { ...birth, startTicks: "13" };
  await assert.rejects(acquireCacheSupervisorNamespace(birth, root, launcher, ports), /birth changed/);
  actual = birth;
  for (const invalid of [
    "PPid:\t999\nNSpid:\t102\t1\n",
    "PPid:\t101\nNSpid:\t102\n",
    "PPid:\t101\nNSpid:\t102\t2\n",
    "unknown",
  ]) {
    status = invalid;
    await assert.rejects(acquireCacheSupervisorNamespace(birth, root, launcher, ports), /parent or namespacePID1/);
  }
  status = "PPid:\t101\nNSpid:\t102\t1\n";
  ownerLive = false;
  await assert.rejects(acquireCacheSupervisorNamespace(birth, root, launcher, ports), /source owner/);
  assert.equal(observed, 1, "no foreign application claim may create an observation owner");
});
