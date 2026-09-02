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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { runChild, takeBytes, timeoutFromEnv } from "../src/run-child.ts";
import { withRunChildTestControl } from "./run-child-test-control.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("an unset child timeout defaults to twenty minutes", () => {
  assert.equal(timeoutFromEnv(undefined), 20 * 60 * 1000);
});

const node = (script: string, over = {}) => ({
  command: process.execPath,
  args: ["-e", script],
  env: process.env,
  cwd: process.cwd(),
  ...over,
});

const COMPLETE_OBSERVER_STATUS = /^(?:exited:\d+|timeout|error:[^\n]+)\n$/;

function pollObserverStatus(
  readStatus: () => string,
  now: () => number,
  wait: () => void,
  limit: number,
  maxAttempts = 128,
): string {
  let status = "";
  let attempts = 0;
  while (!COMPLETE_OBSERVER_STATUS.test(status) && now() < limit && attempts++ < maxAttempts) {
    try { status = readStatus(); } catch {}
    if (!COMPLETE_OBSERVER_STATUS.test(status)) wait();
  }
  return status;
}

async function exitWhileControllerSleepsAcross(kind: "soft" | "hard") {
  const dir = await tempDir(`run-child-${kind}-deadline-`);
  const readyPath = join(dir, "ready");
  const releasePath = join(dir, "release");
  const exitedPath = join(dir, "exited");
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let deadline = 0;
  let hardDeadlineAt: number | undefined;
  let exiting = false;
  let testClockSelected = false;
  let outputSignal = "";
  if (kind === "hard") assert.equal(process.platform, "linux", "the OS-exit observer requires Linux /proc");
  const observer = `
    const {readFileSync,writeFileSync}=require("node:fs");
    const pid=Number(process.argv[1]), output=process.argv[2], limit=Number(process.argv[3]);
    const finish=(status)=>{writeFileSync(output,status+"\\n");};
    const observe=()=>{
      if(Date.now()>=limit) return finish("timeout");
      try {
        const state=readFileSync("/proc/"+pid+"/stat","utf8").match(/^\\d+ \\(.*\\) (.)/)?.[1];
        if(state==="Z") return finish("exited:"+Date.now());
      } catch(error) {
        if(error?.code==="ENOENT") return finish("exited:"+Date.now());
        return finish("error:"+(error?.code??"unknown"));
      }
      setTimeout(observe,5);
    };
    observe();
  `;
  const code = `
    const {existsSync,writeFileSync}=require("node:fs");
    const {spawn}=require("node:child_process");
    writeFileSync(${JSON.stringify(readyPath)},"ready");
    const release=()=>{
      if(!existsSync(${JSON.stringify(releasePath)})) return setTimeout(release,5);
      spawn(process.execPath,["-e","setTimeout(()=>{},1200)"],{detached:true,stdio:["ignore","inherit","inherit"]}).unref();
      ${kind === "hard" ? `spawn(process.execPath,["-e",${JSON.stringify(observer)},String(process.pid),${JSON.stringify(exitedPath)},String(Date.now()+9000)],{detached:true,stdio:"ignore"}).unref();` : ""}
      process.stdout.write("EX",()=>setTimeout(()=>process.stdout.write("ITING\\n",()=>process.exit(0)),20));
    };
    release();
  `;
  const request: Parameters<typeof runChild>[0] = {
    command: process.execPath,
    args: ["-e", code],
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: kind === "soft" ? 500 : 5_000,
    onSpawn: () => {
      const readinessLimit = Date.now() + 10_000;
      while (!existsSync(readyPath) && Date.now() < readinessLimit) Atomics.wait(sleeper, 0, 0, 10);
      assert.equal(existsSync(readyPath), true, "the child became ready before release");
      deadline = Date.now() + 500;
      writeFileSync(releasePath, "release");
    },
    onOutput: (chunk: string) => {
      const combinedSignal = outputSignal + chunk;
      const markerSeen = combinedSignal.includes("EXITING");
      outputSignal = combinedSignal.slice(-6);
      if (exiting || !markerSeen) return;
      exiting = true;
      if (kind === "soft") {
        Atomics.wait(sleeper, 0, 0, Math.max(0, deadline + 300 - Date.now()));
      } else if (hardDeadlineAt !== undefined) {
        Atomics.wait(sleeper, 0, 0, Math.max(0, hardDeadlineAt + 300 - Date.now()));
        const exitLimit = Date.now() + 1_000;
        while (!existsSync(exitedPath) && Date.now() < exitLimit) Atomics.wait(sleeper, 0, 0, 10);
        assert.equal(existsSync(exitedPath), true, "the OS observer reported before its independent bound");
        const status = pollObserverStatus(
          () => readFileSync(exitedPath, "utf8"),
          Date.now,
          () => { Atomics.wait(sleeper, 0, 0, 10); },
          Date.now() + 1_000,
        );
        assert.match(status, /^exited:\d+\n$/, "only zombie state or ENOENT establishes exit");
        assert.ok(Number(status.slice(7)) < hardDeadlineAt, "the OS process exited before its recorded hard deadline");
      }
    },
  };
  const result = kind === "hard"
    ? await withRunChildTestControl({
      hardDeadlineAtAfterSpawn: () => {
        testClockSelected = true;
        return (hardDeadlineAt = Date.now() + 500);
      },
    }, () => runChild(request))
    : await runChild(request);
  if (kind === "hard") assert.equal(testClockSelected, true, "the readiness-gated clock controlled this run");
  assert.equal(exiting, true, "the child reached its synchronized exit before the controller slept");
  return result;
}

test("partial observer status cannot establish exit", () => {
  const statuses = ["exited:1", "exited:123\n"];
  let reads = 0;
  const result = pollObserverStatus(
    () => statuses[Math.min(reads++, statuses.length - 1)]!,
    () => reads,
    () => {},
    4,
  );
  assert.equal(result, "exited:123\n");
});

test("observer terminal errors are complete but never exits", () => {
  for (const status of ["timeout\n", "error:EIO\n"]) {
    assert.equal(pollObserverStatus(() => status, () => 0, () => {}, 1), status);
    assert.doesNotMatch(status, /^exited:\d+\n$/);
  }
});

test("observer polling stops even when an injected clock is frozen", () => {
  let reads = 0;
  const result = pollObserverStatus(
    () => { reads++; return "exited:1"; },
    () => 0,
    () => {},
    1,
    3,
  );
  assert.equal(result, "exited:1");
  assert.equal(reads, 3);
});

test("observer polling retries read errors and expires permanent ones", () => {
  let reads = 0;
  const recovered = pollObserverStatus(
    () => { if (reads++ === 0) throw new Error("transient"); return "exited:7\n"; },
    () => reads,
    () => {},
    4,
  );
  assert.equal(recovered, "exited:7\n");
  let now = 0;
  const expired = pollObserverStatus(
    () => { throw new Error("permanent"); },
    () => now,
    () => { now++; },
    2,
  );
  assert.equal(expired, "");
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

test("exit signal is captured separately from the exit code", async () => {
  const r = await runChild(node("process.kill(process.pid, 'SIGTERM')"));
  assert.equal(r.code, null);
  assert.equal(r.signal, "SIGTERM");
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

test("a descendant retaining output pipes cannot make the timeout unbounded", async () => {
  const started = Date.now();
  const result = await runChild({
    command: process.execPath,
    args: ["-e", `const {spawn}=require('child_process');spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`],
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 30,
    killGraceMs: 20,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 500, "inherited pipes must not extend the hard bound");
});

test("a soft timeout cannot rewrite a child that already exited successfully", async () => {
  const timeoutAt = Date.now() + 500;
  const env = { ...process.env, PI_DADDY_TEST_TIMEOUT_AT: String(timeoutAt) };
  const code = `
    const {spawn}=require("node:child_process");
    spawn(process.execPath,["-e","setTimeout(()=>{},1000)"],{detached:true,stdio:["ignore","inherit","inherit"]}).unref();
    setTimeout(() => process.exit(0), Math.max(0, Number(process.env.PI_DADDY_TEST_TIMEOUT_AT) - Date.now() - 50));
  `;
  const result = await runChild({
    command: process.execPath, args: ["-e", code], env, cwd: process.cwd(), timeoutMs: 500,
  });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false, "pipe drainage cannot let the soft timer rewrite an exited child");
});

test("a delayed event loop cannot let the soft timeout rewrite an OS-exited child", async () => {
  const result = await exitWhileControllerSleepsAcross("soft");
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false, "soft timer delivery order is not evidence the OS process missed its timeout");
});

test("a delayed event loop cannot let the hard deadline rewrite an OS-exited child", async () => {
  const result = await exitWhileControllerSleepsAcross("hard");
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false, "timer delivery order is not evidence the OS process missed its deadline");
});

test("the hard deadline is snapshotted before onSpawn", async () => {
  const request: Parameters<typeof runChild>[0] = node("setTimeout(()=>process.exit(0),500)", {
    timeoutMs: 5_000,
    hardDeadlineAt: Date.now() + 100,
    onSpawn: () => { delete request.hardDeadlineAt; },
  });
  const result = await runChild(request);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL", "onSpawn cannot erase the pre-spawn hard bound");
});

test("a hard deadline cannot rewrite a child that already exited successfully", async () => {
  const hardDeadlineAt = Date.now() + 500;
  const env = { ...process.env, PI_DADDY_TEST_HARD_AT: String(hardDeadlineAt) };
  const code = `
    const {spawn}=require("node:child_process");
    spawn(process.execPath,["-e","setTimeout(()=>{},1000)"],{detached:true,stdio:["ignore","inherit","inherit"]}).unref();
    setTimeout(() => process.exit(0), Math.max(0, Number(process.env.PI_DADDY_TEST_HARD_AT) - Date.now() - 50));
  `;
  const result = await runChild({
    command: process.execPath,
    args: ["-e", code],
    env,
    cwd: process.cwd(),
    timeoutMs: 2_000,
    hardDeadlineAt,
  });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false, "retained descendant pipes cannot rewrite an exited child's result");
});

test("retained descendant pipes do not keep the controller process alive after settlement", async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), "src", "run-child.ts")).href;
  const code = `
    import {runChild} from ${JSON.stringify(moduleUrl)};
    await runChild({command:process.execPath,args:["-e",${JSON.stringify(`const{spawn}=require("child_process");spawn(process.execPath,["-e","setTimeout(()=>{},3000)"],{stdio:["ignore","inherit","inherit"]});setInterval(()=>{},1000)`)}],env:process.env,cwd:process.cwd(),timeoutMs:30,killGraceMs:20});
    process.stdout.write("DONE\\n");
  `;
  const started = Date.now();
  const controller = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  await once(controller, "close");
  assert.ok(Date.now() - started < 1000, "destroyed read ends must not keep the event loop alive");
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
  // **Exact, not `<= cap + 100`.** The slack had no derivation, and a reviewer showed it hid a real 60-byte
  // over-emission: injecting one extra write past the cap left the test green. The invariant is exact by
  // construction — what is streamed is a prefix of `text` — so the assertion should be too.
  assert.ok(Buffer.byteLength(chunks.join("")) <= 1024, `streamed ${Buffer.byteLength(chunks.join(""))} bytes past 1024`);
  assert.ok(Buffer.byteLength(result.text) <= 1024, "and the result must respect it as well");
});

test("ADR-0032: the cap holds in BYTES for non-ASCII, and never splits a character", async () => {
  // **The defect an ASCII-only test could not see.** `bytes` counted UTF-8 bytes while the trim counted UTF-16
  // code units, so any non-ASCII output overran by its encoding width: 300 bytes of CJK through a 100-byte cap,
  // and a measured 2048 bytes through the real 1024 default. An odd cap also split a surrogate pair, putting a
  // lone \ud83d into both the transcript and the returned answer.
  //
  // The production change that breaks this: trimming with `text.slice(0, maxOutputBytes)` again.
  for (const [name, expr] of [
    ["CJK", "'\\u4F60'.repeat(200)"],
    ["emoji", "'\\u{1F600}'.repeat(200)"],
    ["mixed", "('a\\u4F60\\u{1F600}').repeat(200)"],
  ] as const) {
    const chunks: string[] = [];
    const result = await runChild({
      command: process.execPath,
      args: ["-e", `process.stdout.write(${expr})`],
      env: process.env,
      cwd: process.cwd(),
      maxOutputBytes: 101, // odd on purpose: this is where a naive byte slice splits a character
      onOutput: (chunk) => chunks.push(chunk),
    });
    assert.ok(Buffer.byteLength(result.text) <= 101, `${name}: result was ${Buffer.byteLength(result.text)} bytes`);
    assert.ok(Buffer.byteLength(chunks.join("")) <= 101, `${name}: stream was over the cap`);
    assert.ok(!/[\uD800-\uDFFF]/.test(result.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")), `${name}: lone surrogate`);
    assert.ok(!result.text.includes("\uFFFD"), `${name}: a character was corrupted`);
  }
});

test("ADR-0032: a multi-byte character split across stdout chunks is not corrupted", async () => {
  // Pre-existing on main and measured: `String(chunk)` decodes each `data` Buffer independently, so a character
  // straddling a 65536-byte pipe boundary became U+FFFD — in the child's ANSWER. 300,000 bytes of CJK produced
  // twelve of them, because 65536 % 3 == 1. Emoji happened to survive (65536 % 4 == 0), which is why
  // width-dependent corruption went unnoticed. The production change that breaks this: dropping StringDecoder.
  const result = await runChild({
    command: process.execPath,
    args: ["-e", "process.stdout.write('\u4F60'.repeat(100000))"],
    env: process.env,
    cwd: process.cwd(),
  });
  assert.equal(result.truncated, false, "300000 bytes is under the 1 MiB default");
  assert.equal(result.text.length, 100000, "every character must survive the chunk boundaries");
  assert.ok(!result.text.includes("\uFFFD"), "and none may be replaced");
});

test("takeBytes keeps whole characters and respects the budget exactly", () => {
  assert.equal(takeBytes("abc", 2), "ab");
  assert.equal(takeBytes("\u4F60\u4F60", 4), "\u4F60", "3-byte characters: 4 bytes fits exactly one");
  assert.equal(takeBytes("\u{1F600}", 3), "", "a 4-byte character does not fit in 3 and must not be halved");
  assert.equal(takeBytes("abc", 0), "");
  assert.equal(takeBytes("abc", 99), "abc", "under budget passes through untouched");
});
