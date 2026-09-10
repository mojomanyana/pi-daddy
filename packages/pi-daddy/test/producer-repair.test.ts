import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, writeFile } from "node:fs/promises";
import { createResourceBudget, openResourceBudget } from "../src/resource-budget.ts";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
import { ownedRuntimeFixture } from "./owned-runtime-fixture.ts";

test("missing namespace prerequisites remain a failure but cannot leak the fixture listener", async () => {
  const dir = await tempDir("namespace-lifecycle-");
  const runtime = await ownedRuntimeFixture(dir);
  let result: any;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  try {
    await promisify(execFile)(runtime, ["--import", new URL("./effect-profile-missing-runtime.mjs", import.meta.url).pathname,
      "--test", "--test-name-pattern=^actual namespace denies", new URL("./effect-profile.test.ts", import.meta.url).pathname], { env, timeout: 8000 });
    assert.fail("a missing runtime must not pass its namespace test");
  } catch (error) { result = error; }
  await writeFile(join(dir, "missing-runtime.json"), JSON.stringify({ code: result.code, killed: result.killed, stdout: result.stdout, stderr: result.stderr }, null, 2));
  assert.equal(result.code, 1); assert.equal(result.killed, false);
  assert.match(result.stdout, /fixture missing bwrap prerequisite/);
  assert.match(result.stdout, /NAMESPACE_FIXTURE_LIFETIME.*"created":1,"leaked":0/);
});

test("ordinary inspect still refuses a real concurrent append without taking a control lock", async () => {
  const root = await tempDir("read-only-race-"), binding = await createResourceBudget({ directory: join(root, "budget"), authorityDigest: "a".repeat(64), limits: { maxAttempts: 2, maxInputBytes: 4, maxConcurrent: 2 } });
  const budget = openResourceBudget(binding), permit = await budget.reserve({ attemptId: "one", orderId: "order", experimentId: "experiment", kind: "primary", parentAttemptId: null, inputBytes: 1, inputDigest: "b".repeat(64) });
  const file = await open(join(binding.directory, "budget.jsonl"), "r"), proto = Object.getPrototypeOf(file), original = proto.read; await file.close();
  let first = true;
  proto.read = async function(...args: any[]) {
    const result = await Reflect.apply(original, this, args);
    if (first) { first = false; await permit.settle("completed"); }
    return result;
  };
  try { await assert.rejects(budget.inspect(), { code: "AUTHORITY_CHANGED" }); }
  finally { proto.read = original; }
  assert.equal((await budget.inspect()).active, 0, "failed readback is not proof of no settlement");
});
