/** Actual namespace Bash sink pressure; retention bounds must not discard fresh bytes/status. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { startPersonalBash } from "../src/executors/cache-personal-bash.ts";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const quoted = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
test(
  "real Bash pauses asynchronous output delivery and preserves fresh overflow bytes",
  { skip: !enabled, timeout: 15000 },
  async () => {
    const hold = gate(),
      entered = gate(),
      control = new AbortController(),
      counts = { stdout: 0, stderr: 0 };
    let calls = 0;
    const run = await startPersonalBash(
      {
        cwd: process.cwd(),
        shell: "/bin/bash",
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: 8000,
        command: `exec ${quoted(process.execPath)} -e ${quoted("process.stdout.write(Buffer.alloc(2*1024*1024,97));process.stderr.write(Buffer.alloc(1024*1024,98));process.exitCode=7")}`,
      },
      {
        owner: await readCacheOwner(process.pid),
        executionId: randomUUID(),
        signal: control.signal,
        outputBytes: 1024,
        onData: async (bytes) => {
          const frame = JSON.parse(bytes.toString()) as { channel: keyof typeof counts; bytes: string };
          counts[frame.channel] += Buffer.from(frame.bytes, "base64").length;
          if (++calls === 1) {
            entered.resolve();
            await hold.promise;
          }
          await tick(1);
        },
      },
    );
    try {
      await entered.promise;
      await tick(80);
      assert.equal(calls, 1, "one pending sink must backpressure actual producer pipe");
      hold.resolve();
      const outcome = await run.outcome;
      await run.exited;
      assert.equal(outcome.exitCode, 7);
      assert.equal(outcome.complete, false);
      assert.deepEqual(counts, { stdout: 2 * 1024 * 1024, stderr: 1024 * 1024 });
    } finally {
      hold.resolve();
      control.abort();
      await run.stop();
    }
  },
);
test(
  "missing terminal after actual owned namespace exit remains a loud failure",
  { skip: !enabled, timeout: 15000 },
  async () => {
    const run = await startPersonalBash(
      {
        cwd: process.cwd(),
        shell: "/bin/bash",
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: 3000,
        command: "kill -TERM 1",
      },
      {
        owner: await readCacheOwner(process.pid),
        executionId: randomUUID(),
        signal: new AbortController().signal,
        onData: () => {},
      },
    );
    try {
      await assert.rejects(run.outcome, /without terminal frame/);
      await run.exited;
    } finally {
      await run.stop();
    }
  },
);
test(
  "cancelled Bash proves namespace death but does not release pending sink cleanup",
  { skip: !enabled, timeout: 15000 },
  async () => {
    const hold = gate(),
      entered = gate(),
      control = new AbortController();
    const run = await startPersonalBash(
      {
        cwd: process.cwd(),
        shell: "/bin/bash",
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: 8000,
        command: `exec ${quoted(process.execPath)} -e ${quoted("console.log('start');setInterval(()=>{},1000)")}`,
      },
      {
        owner: await readCacheOwner(process.pid),
        executionId: randomUUID(),
        signal: control.signal,
        onData: async () => {
          entered.resolve();
          await hold.promise;
        },
      },
    );
    try {
      await entered.promise;
      control.abort();
      await assert.rejects(run.outcome, /cancelled/);
      await run.exited;
      let cleaned = false;
      const stopping = run.stop().then(() => {
        cleaned = true;
      });
      await tick(20);
      try {
        assert.equal(cleaned, false);
      } finally {
        hold.resolve();
        await stopping;
      }
    } finally {
      hold.resolve();
      await run.stop();
    }
  },
);
