/**
 * LC-002/003/005/006/012/014, AT-027/028/029/030: real Linux PID namespaces, not spawn mocks.
 * The gated pre-namespace test forces the bootstrap owner check; the immediate spawn kill is a race probe.
 * Removing --as-pid-1 breaks detached-tree containment.
 * These fixtures own all targeted processes, identify them by random argv marker + /proc start ticks,
 * and never signal stale PID-file identities. Runnable survivors fail; zombies are reported separately.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDirs as removeTempDirs, tempDir } from "../test/tmp.ts";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
import { startSupervisedCache } from "../src/executors/cache-supervisor.ts";
import { retainedCacheSupervisorCleanups } from "../src/executors/cache-supervisor-cleanup.ts";

async function cleanupTempDirs() {
  assert.deepEqual(retainedCacheSupervisorCleanups(), [], "unresolved supervisor owners; retain fixtures");
  await removeTempDirs();
}
after(cleanupTempDirs);
const optedIn = process.env.PI_DADDY_IT_CACHE === "1";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
interface ProcessIdentity {
  pid: number;
  start: string;
  namespacePid: number;
  nested: boolean;
  zombie: boolean;
}
async function marked(marker: string): Promise<ProcessIdentity[]> {
  const result: ProcessIdentity[] = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (!command.split("\0").includes(marker)) continue;
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const ids =
        status
          .match(/^NSpid:\s+(.+)$/m)?.[1]
          .trim()
          .split(/\s+/) ?? [];
      result.push({
        pid: Number(pid),
        start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
        namespacePid: Number(ids.at(-1)),
        nested: ids.length > 1,
        zombie: /^State:\s+[ZX]/m.test(status),
      });
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return result;
}
async function killIdentity(process: ProcessIdentity): Promise<void> {
  const actual = await readCacheOwner(process.pid).catch(() => undefined);
  if (actual?.startTicks === process.start) {
    try {
      globalThis.process.kill(process.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
async function until<T>(read: () => Promise<T>, accepted: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 3000;
  let value: T;
  do {
    value = await read();
    if (accepted(value)) return value;
    await pause(10);
  } while (performance.now() < deadline);
  assert.fail(`cache fixture failed to settle: ${JSON.stringify(value!)}`);
}

test("cache qualification prerequisite is real Bubblewrap on Linux", { skip: !optedIn }, () => {
  assert.equal(process.platform, "linux", "execution cache qualification requires Linux");
  execFileSync("bwrap", [
    "--unshare-user",
    "--unshare-pid",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--",
    "/usr/bin/true",
  ]);
});

for (const mode of ["normal", "owner", "coordinator", "startup"] as const) {
  test(
    `cache supervised ${mode} termination leaves no runnable detached descendants`,
    { skip: !optedIn, timeout: 30000 },
    async () => {
      for (let repetition = 0; repetition < 5; repetition++) {
        const marker = `pi-daddy-cache-test-${randomUUID()}`;
        const fixture = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("./cache-supervision-owner.mjs", import.meta.url)),
            marker,
            mode === "startup" ? "startup" : "ready",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "",
          stderr = "";
        fixture.stdout.on("data", (bytes) => (stdout += bytes));
        fixture.stderr.on("data", (bytes) => (stderr += bytes));
        try {
          if (mode === "startup") {
            await until(
              async () => ({ exit: fixture.signalCode, stdout, stderr }),
              (v) => v.exit === "SIGKILL",
            );
          } else {
            await until(
              async () => ({ stdout, stderr, code: fixture.exitCode }),
              (v) => {
                if (v.code !== null) assert.fail(`owner fixture exited early: ${JSON.stringify(v)}`);
                return v.stdout.includes('"phase":"ready"');
              },
            );
            const tree = await until(
              () => marked(marker),
              (ps) => ps.filter((p) => p.nested && !p.zombie).length >= 3,
            );
            if (mode === "coordinator") await killIdentity(tree.find((p) => p.nested && p.namespacePid === 1)!);
            else fixture.kill(mode === "normal" ? "SIGTERM" : "SIGKILL");
          }
          // Coordinator failure must kill its owned tree, not the still-live isolated root owner.
          const owned = async () => (await marked(marker)).filter((p) => p.pid !== fixture.pid);
          await until(owned, (ps) => ps.every((p) => p.zombie));
          await pause(100); // Detect late namespace startup after an initially empty /proc scan.
          assert.deepEqual(
            (await owned()).filter((p) => !p.zombie),
            [],
            stderr,
          );
          if (mode === "coordinator") assert.equal((await readCacheOwner(fixture.pid!)).pid, fixture.pid);
        } finally {
          fixture.kill("SIGKILL");
          for (const identity of await marked(marker)) await killIdentity(identity);
          await until(
            () => marked(marker),
            (ps) => ps.every((p) => p.zombie),
          );
        }
      }
    },
  );
}

test(
  "owner death before namespace initialization rejects before importing work-starting entry",
  { skip: !optedIn },
  async () => {
    const root = await tempDir("cache-gated-startup");
    const launcher = join(root, "launcher.mjs");
    await writeFile(
      launcher,
      `#!${process.execPath}\n${await readFile(new URL("./cache-supervision-launcher.mjs", import.meta.url), "utf8")}`,
      { mode: 0o700 },
    );
    const marker = `pi-daddy-cache-gated-startup-${randomUUID()}`;
    const fixture = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./cache-supervision-owner.mjs", import.meta.url)),
        marker,
        "delayed-startup",
        launcher,
        "log-entry",
      ],
      { stdio: "ignore", env: { ...process.env, PI_DADDY_IT_CACHE_LAUNCHER_DIR: root } },
    );
    try {
      await until(async () => existsSync(join(root, "waiting")), Boolean);
      fixture.kill("SIGKILL");
      await until(
        async () => fixture.signalCode,
        (signal) => signal === "SIGKILL",
      );
      await writeFile(join(root, "release"), "owner has exited");
      await until(async () => existsSync(join(root, "finished")), Boolean);
      const stdout = existsSync(join(root, "stdout")) ? await readFile(join(root, "stdout"), "utf8") : "";
      assert.equal(stdout.includes("entry-loaded"), false, "must check owner before importing/starting entry");
      assert.match(await readFile(join(root, "stderr"), "utf8"), /cache bootstrap owner is absent or changed/);
      await until(
        () => marked(marker),
        (ps) => ps.every((p) => p.zombie),
      );
    } finally {
      fixture.kill("SIGKILL");
      await writeFile(join(root, "release"), "cleanup");
      for (const identity of await marked(marker)) await killIdentity(identity);
      await until(
        () => marked(marker),
        (ps) => ps.every((p) => p.zombie),
      );
    }
  },
);

for (const kind of ["return-false", "later-error"])
  test(
    `failed signaling ${kind} produces bounded unresolved-termination refusal, never false cleanup`,
    { skip: !optedIn },
    async () => {
      const marker = `pi-daddy-cache-stop-fault-${randomUUID()}`;
      const handle = await startSupervisedCache({
        owner: await readCacheOwner(process.pid),
        entry: new URL("./cache-supervision-fixture.ts", import.meta.url),
        args: [marker],
      });
      const kill = handle.process.kill.bind(handle.process);
      handle.process.kill = () => {
        if (kind === "later-error") handle.process.emit("error", new Error("simulated signaling EPERM"));
        return false;
      };
      let limit: NodeJS.Timeout | undefined;
      const started = performance.now();
      try {
        await assert.rejects(
          Promise.race([
            handle.stop(),
            new Promise<never>((_, reject) => {
              limit = setTimeout(() => reject(new Error("test deadline exceeded")), 2200);
            }),
          ]),
          /cache.*termination.*unresolved/,
        );
        assert.ok(performance.now() - started < 2100);
        assert.equal(handle.process.exitCode, null, "refusal must not claim that the process exited");
      } finally {
        clearTimeout(limit);
        handle.process.kill = kill;
        kill("SIGKILL");
        await handle.stopped;
        await handle.retryCleanup();
        await assert.rejects(handle.stop(), /termination.*unresolved/, "retry cannot rewrite the original failure");
        await until(
          () => marked(marker),
          (ps) => ps.every((p) => p.zombie),
        );
      }
    },
  );

test(
  "post-readiness output is forwarded byte-exact without accumulating startup frames",
  { skip: !optedIn },
  async () => {
    const marker = `pi-daddy-cache-output-${randomUUID()}`;
    let received = 0;
    const handle = await startSupervisedCache({
      owner: await readCacheOwner(process.pid),
      entry: new URL("./cache-supervision-fixture.ts", import.meta.url),
      args: [marker, "output-after-ready"],
      onData: (stream, bytes) => {
        if (stream === "stdout") {
          assert.ok(bytes.every((byte) => byte === 0xff));
          received += bytes.length;
        }
      },
    });
    try {
      await until(
        async () => received,
        (count) => count === 700000,
      );
    } finally {
      await handle.stop();
    }
    await until(
      () => marked(marker),
      (ps) => ps.every((p) => p.zombie),
    );
  },
);

test("private birth/GO do not leak and application stdin/stdout remain byte-exact", { skip: !optedIn }, async () => {
  const input = Buffer.concat([
      Buffer.from('{"piDaddyCacheSupervisor":1,"go":true}\n{"piDaddyCacheSupervisor":1,"birth":{}}\n'),
      Buffer.from('{"piDaddyCacheSupervisor":1,"ready":true}\n'),
      Buffer.from([0, 255, 10, 13, 128]),
    ]),
    received: Buffer[] = [];
  const handle = await startSupervisedCache({
    owner: await readCacheOwner(process.pid),
    entry: new URL("./cache-supervision-fixture.ts", import.meta.url),
    args: [randomUUID(), "stdin-parity"],
    onData: (stream, bytes) => {
      assert.equal(stream, "stdout");
      received.push(bytes);
    },
  });
  try {
    assert.deepEqual(Buffer.concat(received), Buffer.alloc(0), "private controls must never reach the caller");
    handle.process.stdin.end(input);
    await until(
      async () => Buffer.concat(received).length,
      (length) => length >= input.length,
    );
    assert.deepEqual(Buffer.concat(received), input, "GO cannot consume, prefix or filter application bytes");
  } finally {
    await handle.stop();
  }
});

test(
  "oversized pre-readiness output refuses startup and terminates owned descendants",
  { skip: !optedIn },
  async () => {
    const marker = `pi-daddy-cache-startup-output-${randomUUID()}`;
    await assert.rejects(
      startSupervisedCache({
        owner: await readCacheOwner(process.pid),
        entry: new URL("./cache-supervision-fixture.ts", import.meta.url),
        args: [marker, "oversized-startup"],
      }),
      /cache.*startup output exceeded/,
    );
    await until(
      () => marked(marker),
      (ps) => ps.every((p) => p.zombie),
    );
  },
);

for (const mode of ["stderr-startup", "mixed-startup"]) {
  test(`${mode} contributes to the shared startup output quota`, { skip: !optedIn }, async () => {
    const marker = `pi-daddy-cache-startup-quota-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof startSupervisedCache>> | undefined;
    try {
      await assert.rejects(async () => {
        handle = await startSupervisedCache({
          owner: await readCacheOwner(process.pid),
          entry: new URL("./cache-supervision-fixture.ts", import.meta.url),
          args: [marker, mode],
        });
      }, /cache.*startup output exceeded/);
    } finally {
      await handle?.stop();
    }
    await until(
      () => marked(marker),
      (ps) => ps.every((p) => p.zombie),
    );
  });
}

test("a valid foreign PID cannot substitute for the actual calling root owner", { skip: !optedIn }, async () => {
  const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    foreign.once("spawn", resolve);
    foreign.once("error", reject);
  });
  let handle: Awaited<ReturnType<typeof startSupervisedCache>> | undefined;
  try {
    const owner = await readCacheOwner(foreign.pid!);
    await assert.rejects(async () => {
      handle = await startSupervisedCache({
        owner,
        entry: new URL("./cache-supervision-fixture.ts", import.meta.url),
        args: [randomUUID()],
      });
    }, /cache.*owner.*calling/);
  } finally {
    await handle?.stop();
    foreign.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (foreign.exitCode !== null || foreign.signalCode !== null) resolve();
      else foreign.once("exit", () => resolve());
    });
  }
});

test("wrong expected owner refuses before entry code can run", { skip: !optedIn }, async () => {
  const owner = await readCacheOwner(process.pid);
  await assert.rejects(
    startSupervisedCache({
      owner: { ...owner, startTicks: `${owner.startTicks}0` },
      entry: new URL("./cache-supervision-fixture.ts", import.meta.url),
      args: [randomUUID()],
    }),
    /cache.*owner/,
  );
});
