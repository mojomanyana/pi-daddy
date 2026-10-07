/** Native streams remain complete when cache retention overflows; worker buffers respect backpressure. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { startSupervisedCache } from "../src/executors/cache-supervisor.ts";
import { startPersonalBash } from "../src/executors/cache-personal-bash.ts";
import { readCacheOwner, cacheProcessTerminated, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { cleanupTempDirs, tempDir } from "../test/tmp.ts";
after(cleanupTempDirs);
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quoted = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
async function owners(marker: string) {
  const rows: Array<{ owner: CacheOwnerIdentity; pid1: boolean }> = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!(await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").includes(marker)) continue;
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      if (/^State:\s+[ZX]/m.test(status)) continue;
      rows.push({ owner: await readCacheOwner(Number(pid)), pid1: /^NSpid:\s+.+\s+1$/m.test(status) });
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return rows;
}
async function rss(pid: number) {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const kb = status.match(/^VmRSS:\s+(\d+) kB$/m);
  assert.ok(kb);
  return Number(kb[1]) * 1024;
}
test(
  "retention overflow preserves fresh command streams and status but never certifies cache output",
  { skip: !enabled, timeout: 15000 },
  async () => {
    const marker = `personal-stream-${randomUUID()}`,
      chunks = { stdout: 0, stderr: 0 };
    const source =
      "process.stdout.write(Buffer.alloc(2*1024*1024,97));process.stderr.write(Buffer.alloc(1024*1024,98));process.exitCode=7";
    const run = await startPersonalBash(
      {
        shell: "/bin/bash",
        cwd: process.cwd(),
        command: `exec ${quoted(process.execPath)} -e ${quoted(source)} -- ${marker}`,
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: 5000,
      },
      {
        owner: await readCacheOwner(process.pid),
        executionId: marker,
        signal: new AbortController().signal,
        outputBytes: 1024,
        onData: (data) => {
          const value = JSON.parse(data.toString("utf8")) as { channel: keyof typeof chunks; bytes: string };
          chunks[value.channel] += Buffer.from(value.bytes, "base64").length;
        },
      },
    );
    try {
      const result = await run.outcome;
      await run.exited;
      assert.equal(result.exitCode, 7);
      assert.equal(result.complete, false);
      assert.deepEqual(chunks, { stdout: 2 * 1024 * 1024, stderr: 1024 * 1024 });
    } finally {
      await run.stop();
    }
  },
);
for (const nested of [false, true])
  test(
    `cancellation resolves exited only after detached ${nested ? "nested-namespace" : "same-namespace"} descendant death`,
    { skip: !enabled, timeout: 15000 },
    async () => {
      const marker = `personal-cancel-${randomUUID()}`,
        control = new AbortController();
      let admit!: (owner: CacheOwnerIdentity) => void;
      const admitted = new Promise<CacheOwnerIdentity>((resolve) => {
        admit = resolve;
      });
      let output = "";
      const child = `const fs=require('node:fs');(async()=>{const{readCacheOwner}=await import(${JSON.stringify(new URL("../src/kernel/cache-owner.ts", import.meta.url).href)});const p='/run/pi-daddy-cache-host-proc';const owner=await readCacheOwner(Number(fs.readlinkSync(p+'/self')),p);console.log(JSON.stringify(owner));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)})()`;
      const executable = nested ? "/usr/bin/bwrap" : process.execPath;
      const args = [
        ...(nested
          ? [
              "--unshare-user",
              "--unshare-pid",
              "--as-pid-1",
              "--bind",
              "/",
              "/",
              "--proc",
              "/proc",
              "--dev",
              "/dev",
              "--",
              process.execPath,
            ]
          : []),
        "-e",
        child,
        "--",
        marker,
      ];
      const main = `const{spawn}=require('node:child_process');const child=spawn(${JSON.stringify(executable)},${JSON.stringify(args)},{detached:true,stdio:['ignore','pipe','inherit']});child.stdout.on('data',bytes=>process.stdout.write(bytes));setInterval(()=>{},1000)`;
      const run = await startPersonalBash(
        {
          shell: "/bin/bash",
          cwd: process.cwd(),
          command: `exec ${quoted(process.execPath)} -e ${quoted(main)} -- ${marker}`,
          env: { PATH: "/usr/bin:/bin" },
          timeoutMs: 5000,
        },
        {
          owner: await readCacheOwner(process.pid),
          executionId: marker,
          signal: control.signal,
          onData: (data) => {
            const row = JSON.parse(data.toString("utf8"));
            if (row.channel === "stdout") {
              output += Buffer.from(row.bytes, "base64").toString("utf8");
              if (output.includes("\n")) admit(JSON.parse(output.trim()) as CacheOwnerIdentity);
            }
          },
        },
      );
      try {
        const owner = await admitted;
        assert.equal(await cacheProcessTerminated(owner), false);
        control.abort();
        await assert.rejects(run.outcome, /cancelled/);
        await run.exited;
        assert.equal(await cacheProcessTerminated(owner), true, "exited cannot be an outer-proxy receipt");
      } finally {
        await run.stop();
      }
    },
  );

test(
  "native multithreaded cleanup cannot mistake a zombie leader for task-group death",
  { skip: !enabled, timeout: 15000 },
  async () => {
    const dir = await tempDir("cache-zombie-thread"),
      binary = join(dir, "thread"),
      go = join(dir, "go"),
      control = new AbortController();
    await promisify(execFile)("cc", [
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pthread",
      fileURLToPath(new URL("./cache-personal-threads.c", import.meta.url)),
      "-o",
      binary,
    ]);
    let ready!: (pid: number) => void,
      bytes = "",
      heartbeats = 0;
    const admitted = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const run = await startPersonalBash(
      {
        cwd: dir,
        shell: "/bin/bash",
        command: `exec ${quoted(binary)} ${quoted(go)}`,
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: 5000,
      },
      {
        owner: await readCacheOwner(process.pid),
        executionId: randomUUID(),
        signal: control.signal,
        onData: (data) => {
          const row = JSON.parse(data.toString("utf8"));
          if (row.channel !== "stdout") return;
          bytes += Buffer.from(row.bytes, "base64").toString("utf8");
          for (;;) {
            const end = bytes.indexOf("\n");
            if (end < 0) break;
            const line = bytes.slice(0, end);
            bytes = bytes.slice(end + 1);
            if (line.startsWith("READY ")) ready(Number(line.slice(6)));
            if (line === "thread_alive") heartbeats++;
          }
        },
      },
    );
    try {
      const pid = await admitted,
        owner = await readCacheOwner(pid);
      await writeFile(go, "G");
      const deadline = Date.now() + 2000;
      while ((!(await cacheProcessTerminated(owner)) || !heartbeats) && Date.now() < deadline) await pause(5);
      assert.equal(await cacheProcessTerminated(owner), true, "force a real zombie leader before cancellation");
      assert.ok(heartbeats > 0);
      const tids = await readdir(`/proc/${pid}/task`);
      assert.ok(tids.length >= 2, "leader is zombie while another thread remains");
      control.abort();
      await assert.rejects(run.outcome, /cancelled/);
      await run.exited;
      const before = heartbeats;
      await pause(30);
      assert.equal(heartbeats, before, "no living thread may emit after exited");
      assert.equal(await cacheProcessTerminated(owner), true);
    } finally {
      await run.stop();
    }
  },
);

test(
  "stalled parent does not make the owned worker buffer an unbounded producer stream",
  { skip: !enabled, timeout: 15000 },
  async () => {
    const marker = `personal-pressure-${randomUUID()}`,
      entry = new URL("../src/executors/cache-personal-bash-worker.ts", import.meta.url);
    const handle = await startSupervisedCache({ owner: await readCacheOwner(process.pid), entry, args: [marker] });
    const observed: CacheOwnerIdentity[] = [];
    try {
      const rows = await owners(marker);
      observed.push(...rows.map((row) => row.owner));
      const worker = rows.find((row) => row.pid1);
      assert.ok(worker, "admit actual namespacePID1 before command");
      const baseline = await rss(worker.owner.pid);
      handle.process.stdout.pause();
      const source = "const b=Buffer.alloc(65536,97);for(let i=0;i<2048;i++)process.stdout.write(b)";
      handle.process.stdin.end(
        JSON.stringify({
          shell: "/bin/bash",
          cwd: process.cwd(),
          command: `exec ${quoted(process.execPath)} -e ${quoted(source)} -- ${marker}`,
          env: { PATH: "/usr/bin:/bin" },
          timeoutMs: 5000,
        }) + "\n",
      );
      await pause(750);
      observed.push(...(await owners(marker)).map((row) => row.owner));
      const growth = (await rss(worker.owner.pid)) - baseline;
      assert.ok(
        growth < 16 * 1024 * 1024,
        `stalled worker auxiliaryRSS grew ${growth} bytes; not an aggregate profile bound`,
      );
    } finally {
      await handle.stop();
      const deadline = Date.now() + 1500;
      for (const owner of observed) {
        while (!(await cacheProcessTerminated(owner)) && Date.now() < deadline) await pause(5);
        assert.equal(await cacheProcessTerminated(owner), true);
      }
    }
  },
);
