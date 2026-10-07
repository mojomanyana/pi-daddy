/** Explicit root SDK composition through the real supervised CP1 leaf/Watchman/GNU runtime.
 * Supplied source/options and callbacks are controlled, NOT default CLI/GrantsSession qualification.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CacheNativeRoot } from "../extensions/cache-native-root.ts";
import { startCacheNativeBroker, type CacheNativeBrokerHandle } from "../src/executors/cache-native-broker.ts";
import { retainedCacheSupervisorCleanups } from "../src/executors/cache-supervisor-cleanup.ts";
import { PersonalCacheRuntime } from "../src/products/cache-personal-runtime.ts";
import { CacheShellBackend } from "../src/products/cache-shell-backend.ts";
import { WatchmanTracker } from "../src/executors/cache-watchman.ts";
import { startPersonalBash } from "../src/executors/cache-personal-bash.ts";
import { readCacheOwner, cacheProcessTerminated } from "../src/kernel/cache-owner.ts";
import { cleanupTempDirs as removeFixtureDirs, tempDir } from "../test/tmp.ts";
let unresolved = 0;
async function cleanupTempDirs() {
  assert.equal(unresolved, 0, "retain unresolved root fixture");
  await removeFixtureDirs();
}
after(cleanupTempDirs);
test(
  "owned root SDK automatically starts one broker, reuses GNU execution and joins teardown",
  { skip: process.env.PI_DADDY_IT_CACHE !== "1", timeout: 30000 },
  async () => {
    const dir = await tempDir("cache-root-sdk"),
      cwd = join(dir, "work"),
      frontend = join(dir, "frontend"),
      broker = join(dir, "broker");
    await chmod(dir, 0o700);
    await mkdir(cwd);
    await writeFile(join(cwd, ".watchmanconfig"), "{}");
    for (const [target, source] of [
      [frontend, "cache-shell.c"],
      [broker, "cache-broker.c"],
    ]) {
      await promisify(execFile)("cc", [
        "-static",
        "-Wall",
        "-Wextra",
        "-Werror",
        fileURLToPath(new URL(`../src/executors/native/${source}`, import.meta.url)),
        "-o",
        target,
      ]);
    }
    const input = join(cwd, "input"),
      manifest = join(cwd, "checksums");
    await writeFile(input, "one\n");
    const checksum = async () =>
      createHash("sha256")
        .update(await readFile(input))
        .digest("hex") + "  input\n";
    await writeFile(manifest, await checksum());
    const watcher = spawn(
      process.env.PI_DADDY_CACHE_WATCHMAN ?? "watchman",
      [
        "--foreground",
        "--no-save-state",
        "--sockname",
        join(dir, "watch"),
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
      watcher.once("close", () => resolve());
      watcher.once("error", reject);
    });
    void stopped.catch(() => {});
    unresolved++;
    const owner = await readCacheOwner(process.pid),
      watchOwner = await readCacheOwner(watcher.pid!);
    let tracker: WatchmanTracker | undefined,
      runtime: PersonalCacheRuntime | undefined,
      root: CacheNativeRoot | undefined;
    let launches = 0,
      permitted = true,
      perCallPermitted = true,
      force = false,
      brokerStarts = 0,
      ordinaryStarts = 0,
      expectedShutdownFailure = false;
    let brokerHandle: CacheNativeBrokerHandle | undefined, expectedShutdownError: unknown;
    const decisions: Awaited<ReturnType<CacheShellBackend["run"]>>[] = [],
      errors: unknown[] = [];
    const invocation = {
      cwd,
      shell: "/bin/bash",
      command: "LC_ALL=C exec /usr/bin/gnusha256sum --strict -c checksums",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeoutMs: 3000,
    };
    try {
      tracker = await WatchmanTracker.connect({
        socketPath: join(dir, "watch"),
        root: cwd,
        onChange: (names) => runtime?.changed(names.map((name) => join(cwd, name))),
        onUncertain: (reason) => runtime?.uncertain(reason),
      });
      const output = { bytes: 65536, itemBytes: 16384, payloads: 32, deliveries: 16 };
      runtime = new PersonalCacheRuntime({
        workspace: cwd,
        profiles: [
          {
            ...invocation,
            id: "controlled-gnu-root",
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
        graph: { workspaces: 1, observations: 8, entries: 8, runs: 8, edges: 32, keyBytes: 256, output },
        scheduler: {
          running: 2,
          pending: 8,
          requests: 16,
          requesters: 8,
          work: 8,
          validationMs: 3000,
          completionMs: 3000,
          calls: 16,
          streamBytes: 8192,
          streamChunks: 32,
          replies: output,
        },
        inputs: { paths: 16, bytes: 16 * 1024 * 1024, entries: 128, ms: 2000 },
        captures: 2,
        barrier: () => tracker!.barrier(),
        closeInputs: async () => tracker?.close(),
        start: async (request, options) => {
          launches++;
          return startPersonalBash(request, { ...options, owner, outputBytes: 1024 });
        },
      });
      const backend = new CacheShellBackend(runtime),
        image = await readFile(frontend);
      const sdkPath = join(
        dirname(dirname(process.execPath)),
        "lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
      );
      const sdk = (await import(pathToFileURL(sdkPath).href)) as typeof import("@earendil-works/pi-coding-agent");
      root = new CacheNativeRoot({
        parent: owner,
        cwd,
        native: {
          ...sdk,
          createLocalBashOperations: (options) => {
            const operations = sdk.createLocalBashOperations(options);
            return {
              ...operations,
              exec: (...args) => {
                if (options?.shellPath === invocation.shell) ordinaryStarts++;
                return operations.exec(...args);
              },
            };
          },
        },
        options: {
          shellPath: invocation.shell,
          exposeSessionEnvironment: false,
          spawnHook: (context) => ({ ...context, env: invocation.env }),
        },
        authorize: () => permitted,
        authorizeCall: () => permitted && perCallPermitted,
        images: {
          directory: dir,
          image,
          sha256: createHash("sha256").update(image).digest("hex"),
          socket: join(dir, "cache"),
          admissionMs: 3000,
          maxLeases: 2,
          maxImageBytes: image.length,
          maxStorageBytes: 2 * (image.length + 8192),
        },
        context: { checks: 2, maxReadBytes: 1200000, maxTotalBytes: 3000000, timeoutMs: 3000 },
        maxCalls: 2,
        maxPending: 8,
        handshakeMs: 3000,
        readinessMs: 3000,
        brokerPath: broker,
        startBroker: async (options) => {
          brokerStarts++;
          brokerHandle = await startCacheNativeBroker(options);
          return brokerHandle;
        },
        eligible: (current) => current.command === invocation.command,
        run: async (current, options) => {
          const result = await backend.run(current, { ...options, force });
          decisions.push(result);
          return result;
        },
        closeBackend: () => runtime!.shutdown(),
        onError: (error) => errors.push(error),
      });
      const call = (id: string) =>
        root!.definition.execute(id, { command: invocation.command, timeout: 3 }, undefined, undefined, {
          cwd,
        } as Parameters<CacheNativeRoot["definition"]["execute"]>[4]);
      // No externally managed broker or readiness gate: execute waits the root's automatic owned startup.
      const first = await call("first");
      assert.equal(first.content.find((item) => item.type === "text")?.text, "input: OK\n");
      assert.equal(decisions[0]?.resolution.kind, "execute");
      assert.equal(decisions[0]?.resolution.published, true);
      const original = decisions[0]?.resolution.executionId;
      await call("repeat");
      assert.equal(decisions.at(-1)?.resolution.kind, "reuse");
      assert.equal(decisions.at(-1)?.resolution.executionId, original);
      await Promise.all([call("parallel-one"), call("parallel-two")]);
      assert.ok(
        decisions
          .slice(-2)
          .every((result) => result?.resolution.kind === "reuse" && result.resolution.executionId === original),
      );
      assert.equal(launches, 1, "qualified command runners only: frontend/broker/watchman launches are NOT savings");
      await writeFile(input, "two\n");
      await writeFile(manifest, await checksum());
      await call("changed");
      assert.equal(decisions.at(-1)?.resolution.kind, "execute");
      assert.equal(launches, 2);
      force = true;
      await call("forced");
      assert.equal(decisions.at(-1)?.resolution.kind, "execute");
      assert.equal(launches, 3);
      force = false;
      assert.deepEqual(errors, []);
      assert.equal(brokerStarts, 1);
      assert.equal(ordinaryStarts, 0);
      await brokerHandle!.stop(); // Isolated cache-helper loss, not SDK session teardown.
      const deadline = Date.now() + 1000;
      while (!root.stats().faulted && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(root.stats().faulted, true);
      const beforeOrdinary = decisions.length;
      assert.equal(
        (await call("ordinary-after-loss")).content.find((item) => item.type === "text")?.text,
        "input: OK\n",
      );
      assert.equal(ordinaryStarts, 1);
      assert.equal(root.stats().unavailableBypasses, 1);
      assert.equal(decisions.length, beforeOrdinary, "ordinary execution is NOT a cache result");
      assert.equal(launches, 3, "qualified cache counter excludes the separately counted ordinary launch");
      perCallPermitted = false;
      await assert.rejects(
        root.definition.execute("ordinary-no-timeout-denied", { command: invocation.command }, undefined, undefined, {
          cwd,
        } as Parameters<CacheNativeRoot["definition"]["execute"]>[4]),
        /per-call authority/,
      ); // Native operation exceptions throw; nonzero command exits fulfill isError.
      assert.equal(ordinaryStarts, 1, "per-call denial must not start the original shell despite missing timeout");
      permitted = false;
      await assert.rejects(call("revoked"));
      assert.equal(ordinaryStarts, 1);
      const closing = root.shutdown();
      assert.equal(closing, root.shutdown());
      await assert.rejects(closing, (error) => {
        expectedShutdownError = error;
        expectedShutdownFailure = error instanceof AggregateError && /root cleanup unresolved/.test(error.message);
        return expectedShutdownFailure;
      });
      assert.equal(root.stats().factory.owned, 0);
      assert.equal(root.stats().issuer.owned, 0);
      assert.equal(root.stats().images.rootOwned, false);
      assert.equal(root.stats().context.owned, 0);
      assert.equal(runtime.stats().graph.entries, 0);
      assert.equal(errors.length, 1, "cache loss is diagnosed once, not relabeled as an ordinary command outcome");
    } finally {
      const results = await Promise.allSettled([root?.shutdown(), runtime?.shutdown(), tracker?.close()]);
      watcher.kill("SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          stopped,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              watcher.kill("SIGKILL");
              reject(Error("root Watchman fixture cleanup unresolved"));
            }, 1500);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assert.equal(await cacheProcessTerminated(watchOwner), true);
      const empty =
        root &&
        root.stats().factory.owned === 0 &&
        root.stats().issuer.owned === 0 &&
        !root.stats().images.rootOwned &&
        root.stats().context.owned === 0 &&
        retainedCacheSupervisorCleanups().length === 0;
      const faults = results.flatMap((result, index) =>
        result.status === "rejected" &&
        !(index === 0 && expectedShutdownFailure && result.reason === expectedShutdownError && empty)
          ? [result.reason]
          : [],
      );
      if (faults.length) throw new AggregateError(faults, "root fixture cleanup unresolved; retain");
      unresolved--;
    }
  },
);
