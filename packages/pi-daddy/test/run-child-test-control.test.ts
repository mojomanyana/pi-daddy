import assert from "node:assert/strict";
import { test } from "node:test";
import { runChild } from "../src/run-child.ts";
import { withRunChildTestControl } from "./run-child-test-control.ts";

const request = () => ({
  command: process.execPath,
  args: ["-e", "process.exit(0)"],
  env: process.env,
  cwd: process.cwd(),
  timeoutMs: 2_000,
});

const futureDeadline = () => Date.now() + 1_000;

test("test control does not cross into an overlapping uncontrolled run", async () => {
  let selections = 0;
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const arrive = async () => {
    if (++arrivals === 2) release();
    await barrier;
  };
  await Promise.all([
    withRunChildTestControl({
      hardDeadlineAtAfterSpawn: () => { selections++; return futureDeadline(); },
    }, async () => { await arrive(); return runChild(request()); }),
    (async () => { await arrive(); return runChild(request()); })(),
  ]);
  assert.equal(arrivals, 2, "both async scopes overlapped before either child started");
  assert.equal(selections, 1);
  await runChild(request());
  assert.equal(selections, 1, "control does not persist after its scoped run settles");
});

test("nested test control restores its outer context", async () => {
  let outer = 0;
  let inner = 0;
  await withRunChildTestControl({
    hardDeadlineAtAfterSpawn: () => { outer++; return futureDeadline(); },
  }, async () => {
    await withRunChildTestControl({
      hardDeadlineAtAfterSpawn: () => { inner++; return futureDeadline(); },
    }, () => runChild(request()));
    await runChild(request());
  });
  assert.deepEqual({ outer, inner }, { outer: 1, inner: 1 });
});

test("rejected test-control scope cannot leak into a later run", async () => {
  let selections = 0;
  await assert.rejects(withRunChildTestControl({
    hardDeadlineAtAfterSpawn: () => { selections++; return futureDeadline(); },
  }, async () => { throw new Error("expected"); }), /expected/);
  await runChild(request());
  assert.equal(selections, 0);
});
