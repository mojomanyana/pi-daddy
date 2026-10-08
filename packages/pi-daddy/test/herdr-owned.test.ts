import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { writeFile, readFile } from "node:fs/promises";

import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runHerdrOwned } from "../src/executors/herdr-owned.ts";
import { runCapturedExecution } from "../src/executors/captured-execution.ts";
import { piFixtureScript } from "./pi-fixture.ts";
const launchers: ChildProcess[] = [];
after(() => {
  for (const child of launchers) if (child.exitCode === null) child.kill("SIGKILL");
});
/** Exercise actual packaged socket launcher/native helper; fake only Herdr's delivery of the command to its owned pane. */
function transport(options: { killLauncher?: boolean; failCreate?: boolean } = {}) {
  return async (args: string[]) => {
    if (args[0] === "tab" && args[1] === "create")
      return options.failCreate
        ? { code: 1, stdout: '{"error":{"message":"server unavailable"}}', stderr: "" }
        : { code: 0, stdout: '{"result":{"root_pane":{"pane_id":"owned-pane","tab_id":"owned-tab"}}}', stderr: "" };
    if (args[0] === "pane" && args[1] === "run") {
      const child = spawn("/bin/sh", ["-c", args[3]], { stdio: "ignore" });
      launchers.push(child);
      if (options.killLauncher) setTimeout(() => child.kill("SIGKILL"), 400);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "tab" && args[1] === "close") return { code: 0, stdout: '{"result":{}}', stderr: "" };
    throw Error("unexpected pane transport");
  };
}
const launcherPath = fileURLToPath(new URL("../src/executors/herdr-launcher.ts", import.meta.url));
test("pane launcher preserves exact JSON final and proves cleanup independently of UI state", async () => {
  const cwd = await tempDir("pd-herdr-test-"),
    sessionPath = join(cwd, "session.jsonl");
  const script = join(cwd, "fixture.cjs"),
    final = "  complete public answer 🙂\n";
  await writeFile(script, piFixtureScript("process.stdout.write(" + JSON.stringify(final) + ")"));
  const result = await runCapturedExecution(
    {
      executionId: "herdr-final",
      command: process.execPath,
      args: [script, "--session", sessionPath, "task"],
      sessionPath,
      cwd,
      env: { PATH: process.env.PATH },
      timeoutMs: 5000,
    },
    (request) => runHerdrOwned(request, { exec: transport(), launcherPath }),
  );
  assert.equal(result.final.state, "complete");
  assert.equal(result.text, final);
  assert.equal(result.cleanup.state, "settled");
  assert.equal(result.code, 0);
});
test("cancellation kills detached descendants and preserves the matching settlement receipt", async () => {
  const cwd = await tempDir("pd-herdr-cancel-"),
    signal = new AbortController();
  const result = await runHerdrOwned(
    {
      executionId: "herdr-cancel",
      command: process.execPath,
      args: [
        "-e",
        "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)",
      ],
      cwd,
      env: process.env,
      ownershipDir: join(cwd, "owner"),
      signal: signal.signal,
      timeoutMs: 5000,
      killGraceMs: 100,
      onSpawn: () => setTimeout(() => signal.abort(), 100),
    },
    { exec: transport(), launcherPath },
  );
  assert.equal(result.aborted, true);
  assert.equal(result.cleanup.state, "settled");
  if (result.cleanup.state === "settled") {
    assert.equal(result.cleanup.receipt.reapedAll, true);
    assert.equal(result.cleanup.receipt.reason, "cancelled");
  }
});
test("launcher death becomes a failed result but native owner-loss still reaps the tree", async () => {
  const cwd = await tempDir("pd-herdr-loss-");
  const result = await runHerdrOwned(
    {
      executionId: "herdr-lost",
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd,
      env: process.env,
      ownershipDir: join(cwd, "owner"),
      timeoutMs: 5000,
      killGraceMs: 100,
    },
    { exec: transport({ killLauncher: true }), launcherPath },
  );
  assert.ok(result.spawnError);
  assert.equal(result.cleanup.state, "settled");
  if (result.cleanup.state === "settled") assert.equal(result.cleanup.receipt.reason, "owner-loss");
});
test("creation failure never launches a worker", async () => {
  const cwd = await tempDir("pd-herdr-before-");
  const result = await runHerdrOwned(
    {
      executionId: "before",
      command: process.execPath,
      args: ["-e", "process.exit(99)"],
      cwd,
      env: process.env,
      ownershipDir: join(cwd, "owner"),
      timeoutMs: 1000,
    },
    { exec: transport({ failCreate: true }), launcherPath },
  );
  assert.equal(result.cleanup.state, "not-started");
  assert.equal(result.code, null);
});
