/**
 * G8 — child process handling (review findings A-R1/B-I5, A-R3, and failures returned as successes).
 *
 * `delegate` spawned `pi` with no output cap, no timeout, an abort listener attached too late to catch
 * an already-aborted signal, and a non-zero exit reported to the model as an ordinary result.
 *
 * These tests drive REAL child processes (`process.execPath -e …`), not a mocked `spawn`. A mock would
 * only prove that the code calls the functions it calls; a hang, a flood and a kill are the behaviours
 * under test, and they only exist in a real process.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { runChild } from "../src/run-child.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const node = (script: string, over = {}) => ({
  command: process.execPath,
  args: ["-e", script],
  env: process.env,
  cwd: process.cwd(),
  ...over,
});

test("captures output and a zero exit code", async () => {
  const r = await runChild(node("process.stdout.write('DONE')"));
  assert.equal(r.code, 0);
  assert.equal(r.text, "DONE");
  assert.equal(r.timedOut, false);
  assert.equal(r.truncated, false);
});

test("captures stderr as well as stdout", async () => {
  const r = await runChild(node("process.stderr.write('BOOM'); process.exit(3)"));
  assert.equal(r.code, 3);
  assert.ok(r.text.includes("BOOM"));
});

test("a non-zero exit is reported, not disguised as success", async () => {
  // The caller turns this into `isError`. Previously a child that died still returned its output as a
  // normal tool result, so the orchestrator read a failure as an answer.
  const r = await runChild(node("process.exit(9)"));
  assert.equal(r.code, 9);
});

test("output beyond the cap is truncated and the child is stopped", async () => {
  const r = await runChild(
    node("setInterval(() => process.stdout.write('x'.repeat(4096)), 1)", { maxOutputBytes: 8192 }),
  );
  assert.equal(r.truncated, true, "an unbounded child must not be able to exhaust the orchestrator");
  assert.ok(r.text.length <= 8192 + 512, `captured ${r.text.length} bytes, cap was 8192`);
});

test("a hanging child is killed at the timeout", async () => {
  const r = await runChild(node("setInterval(() => {}, 1000)", { timeoutMs: 300 }));
  assert.equal(r.timedOut, true, "a hung child used to hold the orchestrator's turn open forever");
  assert.notEqual(r.code, 0);
});

test("a child ignoring SIGTERM is still killed", async () => {
  const r = await runChild(
    node("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", {
      timeoutMs: 300,
      killGraceMs: 300,
    }),
  );
  assert.equal(r.timedOut, true, "SIGTERM must escalate to SIGKILL, or the timeout is advisory");
});

test("an already-aborted signal never spawns the child at all", async () => {
  // A-R3: the listener was attached after an await, and AbortSignal does not replay. A cancellation
  // issued in that window was lost and the child ran to completion outside it.
  const controller = new AbortController();
  controller.abort();
  const marker = join(await tempDir("g8-"), "child-ran");
  const r = await runChild(
    node(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`, { signal: controller.signal }),
  );
  assert.equal(r.aborted, true);
  assert.equal(r.code, null, "nothing was spawned, so there is no exit code");
  // The side effect is the real assertion: `code === null` would also hold if the child ran and was
  // killed by a signal. The marker file proves it never executed.
  assert.equal(existsSync(marker), false, "an already-aborted delegation must not run at all");
});

test("aborting mid-run kills the child", async () => {
  const controller = new AbortController();
  const running = runChild(node("setInterval(() => {}, 1000)", { signal: controller.signal }));
  setTimeout(() => controller.abort(), 150);
  const r = await running;
  assert.equal(r.aborted, true);
});

test("a command that does not exist is reported rather than thrown", async () => {
  const r = await runChild(node("", { command: "/nonexistent/definitely-not-a-binary" }));
  assert.ok(r.spawnError, "a spawn failure must surface as a result the tool can report");
});

test("ADR-0032: onOutput sees each chunk as it arrives, and the result is still whole", async () => {
  // The production change that breaks this: dropping onOutput, or calling it after `close` — the entire point
  // is that the parent can render progress BEFORE the child finishes. A delegation was a black box for up to
  // DEFAULT_TIMEOUT_MS, and this is the half of the fix that works without herdr.
  const chunks: string[] = [];
  const result = await runChild({
    command: process.execPath,
    args: ["-e", "process.stdout.write('one\\n'); setTimeout(() => process.stdout.write('two\\n'), 30)"],
    env: process.env,
    cwd: process.cwd(),
    onOutput: (chunk) => chunks.push(chunk),
  });
  assert.equal(result.code, 0);
  assert.match(chunks.join(""), /one/);
  assert.match(chunks.join(""), /two/);
  assert.match(result.text, /one\ntwo/, "streaming must not replace the assembled result");
});

test("ADR-0032: stderr is streamed too, because capture is one funnel for both", async () => {
  const chunks: string[] = [];
  await runChild({
    command: process.execPath,
    args: ["-e", "process.stderr.write('a warning')"],
    env: process.env,
    cwd: process.cwd(),
    onOutput: (chunk) => chunks.push(chunk),
  });
  assert.match(chunks.join(""), /a warning/);
});

test("ADR-0032: onOutput throwing does not kill the child — a renderer is not a governance control", async () => {
  const result = await runChild({
    command: process.execPath,
    args: ["-e", "process.stdout.write('hi')"],
    env: process.env,
    cwd: process.cwd(),
    onOutput: () => {
      throw new Error("renderer exploded");
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.text, "hi");
});

test("ADR-0032: streaming respects the same byte cap as capture", async () => {
  // Otherwise the cap would bound memory and not the transcript, and a runaway producer would flood the
  // parent's screen through the one path that was added to make it readable.
  const chunks: string[] = [];
  const result = await runChild({
    command: process.execPath,
    args: ["-e", "for (let i = 0; i < 5000; i++) process.stdout.write('x'.repeat(100))"],
    env: process.env,
    cwd: process.cwd(),
    maxOutputBytes: 1024,
    onOutput: (chunk) => chunks.push(chunk),
  });
  assert.equal(result.truncated, true);
  assert.ok(
    Buffer.byteLength(chunks.join("")) <= 1024 + 100,
    `streamed ${Buffer.byteLength(chunks.join(""))} bytes past a 1024 cap`,
  );
});
