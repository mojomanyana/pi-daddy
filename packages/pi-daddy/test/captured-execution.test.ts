import assert from "node:assert/strict";
import { test, after } from "node:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { runCapturedExecution } from "../src/executors/captured-execution.ts";
import { piFixtureScript } from "./pi-fixture.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
test("diagnostic truncation and broken observers cannot stop or replace the complete final", async () => {
  const cwd = await tempDir("captured-observation-");
  const script = join(cwd, "child.cjs"),
    sessionPath = join(cwd, "session.jsonl");
  const final = "  COMPLETE\n🙂 end  ";
  await writeFile(
    script,
    piFixtureScript(
      `process.stderr.write('D'.repeat(100000));setTimeout(()=>process.stdout.write(${JSON.stringify(final)}),100);`,
    ),
  );
  const out = await runCapturedExecution({
    command: process.execPath,
    args: [script, "--session", sessionPath, "task"],
    sessionPath,
    executionId: "exec-observation-test",
    cwd,
    env: process.env,
    timeoutMs: 5000,
    maxOutputBytes: 128,
    onOutput: () => {
      throw Error("display unavailable");
    },
    onObservation: () => {
      throw Error("retention unavailable");
    },
  });
  assert.equal(out.code, 0);
  assert.equal(out.final.state, "complete");
  assert.equal(out.cleanup.state, "settled");
  assert.equal(out.text, final);
  assert.equal(out.diagnostics.length, 128);
  assert.equal(out.diagnosticsTruncated, true);
  assert.equal(out.truncated, false);
});

test("ownership directory allocation failure proves no helper or child started", async () => {
  const cwd = await tempDir("captured-prelaunch-");
  const old = process.env.TMPDIR;
  process.env.TMPDIR = join(cwd, "missing", "parent");
  let ownership = false;
  try {
    const out = await runCapturedExecution({
      command: process.execPath,
      args: ["-e", "process.exit(99)", "task"],
      sessionPath: join(cwd, "session.jsonl"),
      executionId: "exec-before-helper",
      cwd,
      env: process.env,
      onOwnership: () => {
        ownership = true;
      },
    });
    assert.equal(out.cleanup.state, "not-started");
    assert.equal(out.final.state, "unavailable");
    assert.equal(out.code, null);
    assert.equal(ownership, false);
    assert.match(out.spawnError!, /before helper launch/);
  } finally {
    if (old === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = old;
  }
});
