/** Actual Watchman + native Bash/GNU + personal runtime. Not whole Pi/feature acceptance. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { PersonalCacheRuntime } from "../src/products/cache-personal-runtime.ts";
import { startPersonalBash } from "../src/executors/cache-personal-bash.ts";
import { WatchmanTracker } from "../src/executors/cache-watchman.ts";
import { readCacheOwner, cacheProcessTerminated } from "../src/kernel/cache-owner.ts";
import { cleanupTempDirs as removeFixtureDirs, tempDir } from "../test/tmp.ts";
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
let unresolved = 0;
async function cleanupTempDirs() {
  assert.equal(unresolved, 0, "retain unresolved runtime fixture");
  await removeFixtureDirs();
}
after(cleanupTempDirs);
test(
  "actual personal command executes once, unchanged repeats avoid Bash, edit/force run again",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const dir = await tempDir("cache-personal-real"),
      cwd = join(dir, "work");
    await mkdir(cwd);
    await writeFile(join(cwd, ".watchmanconfig"), "{}");
    const input = join(cwd, "input"),
      manifest = join(cwd, "checksums");
    await writeFile(input, "one\n");
    const line = async () =>
      createHash("sha256")
        .update(await readFile(input))
        .digest("hex") + "  input\n";
    await writeFile(manifest, await line());
    const server = spawn(
      process.env.PI_DADDY_CACHE_WATCHMAN ?? "watchman",
      [
        "--foreground",
        "--no-save-state",
        "--sockname",
        join(dir, "sock"),
        "--logfile",
        join(dir, "log"),
        "--statefile",
        join(dir, "state"),
        "--pidfile",
        join(dir, "pid"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stopped = new Promise<void>((resolve, reject) => {
      server.once("close", () => resolve());
      server.once("error", reject);
    });
    stopped.catch(() => {});
    unresolved++;
    let tracker: WatchmanTracker | undefined,
      runtime: PersonalCacheRuntime | undefined,
      launches = 0;
    const owner = await readCacheOwner(process.pid),
      serverOwner = await readCacheOwner(server.pid!);
    const invocation = {
      cwd,
      shell: "/bin/bash",
      command: "LC_ALL=C exec /usr/bin/gnusha256sum --strict -c checksums",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeoutMs: 3000,
    };
    const payloads = { bytes: 65536, itemBytes: 16384, payloads: 32, deliveries: 16 };
    try {
      tracker = await WatchmanTracker.connect({
        socketPath: join(dir, "sock"),
        root: cwd,
        onChange: (names) => runtime?.changed(names.map((name) => join(cwd, name))),
        onUncertain: (reason) => runtime?.uncertain(reason),
      });
      runtime = new PersonalCacheRuntime({
        workspace: cwd,
        profiles: [
          {
            ...invocation,
            id: "explicit-gnu-check",
            revision: "1",
            contract: "personal-best-effort-v1",
            effects: "none",
            external: "none",
            deterministic: true,
            inputs: [
              input,
              manifest,
              "/usr/bin/gnusha256sum",
              "/bin/bash",
              "/etc/ld.so.cache",
              "/usr/lib/x86_64-linux-gnu/libc.so.6",
              "/usr/lib/x86_64-linux-gnu/libcrypto.so.3",
            ].map((path) => ({ path, kind: "file" as const })),
          },
        ],
        graph: { workspaces: 1, observations: 8, entries: 8, runs: 8, edges: 32, keyBytes: 256, output: payloads },
        scheduler: {
          running: 2,
          pending: 8,
          requests: 16,
          requesters: 4,
          work: 8,
          validationMs: 3000,
          completionMs: 3000,
          calls: 16,
          streamBytes: 8192,
          streamChunks: 32,
          replies: payloads,
        },
        inputs: { paths: 16, bytes: 16 * 1024 * 1024, entries: 128, ms: 2000 },
        captures: 2,
        barrier: () => tracker!.barrier(),
        closeInputs: async () => tracker?.close(),
        start: async (request, options) => {
          launches++;
          return startPersonalBash(request, { ...options, owner });
        },
      });
      const actor = runtime.attach(() => true),
        first = await runtime.request(actor, invocation);
      assert.equal(first.kind, "execute", JSON.stringify(first));
      assert.equal(first.outcome?.exitCode, 0);
      assert.equal(first.published, true);
      const hit = await runtime.request(actor, invocation);
      assert.equal(hit.kind, "reuse");
      assert.deepEqual(hit.outcome, first.outcome);
      assert.equal(hit.executionId, first.executionId);
      assert.equal(launches, 1, "warm lookup must not launch the command or namespace runner");
      await writeFile(join(cwd, "unrelated"), "other");
      assert.equal((await runtime.request(actor, invocation)).kind, "reuse");
      assert.equal(launches, 1);
      await writeFile(input, "two\n");
      const failed = await runtime.request(actor, invocation);
      assert.equal(failed.kind, "execute");
      assert.notEqual(failed.outcome?.exitCode, 0);
      assert.equal(failed.published, false);
      await writeFile(manifest, await line());
      const rerun = await runtime.request(actor, invocation);
      assert.equal(rerun.kind, "execute");
      assert.equal(rerun.published, true);
      const forced = await runtime.request(actor, invocation, { force: true });
      assert.equal(forced.kind, "execute");
      assert.notEqual(forced.executionId, rerun.executionId);
      assert.equal(launches, 4);
      runtime.clear();
      assert.equal((await runtime.request(actor, invocation)).kind, "execute");
      assert.equal(launches, 5);
    } finally {
      let runtimeError: unknown;
      try {
        await runtime?.shutdown();
      } catch (error) {
        runtimeError = error;
      }
      tracker?.close();
      server.kill("SIGTERM");
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          stopped,
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              server.kill("SIGKILL");
              reject(Error("owned Watchman close unresolved"));
            }, 1500);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      assert.equal(await cacheProcessTerminated(serverOwner), true);
      unresolved--;
      if (runtimeError) throw runtimeError;
    }
  },
);
