/** Real frontend→CP1→Node service→personal runtime/Watchman/GNU. Explicit owned issuer, NOT automatic Pi/grants integration.
 * Real reusable backend awaits bytes/cleanup and bounded no-start uncertainty execution; Pi issuance remains gated.
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, readFile, writeFile, stat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CacheNativeBashFactory } from "../extensions/cache-native-bash.ts";
import { CacheNativeIssuer } from "../extensions/cache-native-issuer.ts";
import { CacheNativeImages } from "../src/executors/cache-native-images.ts";
import { CacheNativeContext } from "../src/executors/cache-native-context.ts";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { CacheShellRoles } from "../src/governance/cache-shell-roles.ts";
import { CacheShellService } from "../src/products/cache-shell-service.ts";
import { CacheShellBackend } from "../src/products/cache-shell-backend.ts";
import { CacheBrokerChannel } from "../src/executors/cache-broker-channel.ts";
import { PersonalCacheRuntime } from "../src/products/cache-personal-runtime.ts";
import { WatchmanTracker } from "../src/executors/cache-watchman.ts";
import { startPersonalBash } from "../src/executors/cache-personal-bash.ts";
import { startSupervisedCache, type CacheSupervisorHandle } from "../src/executors/cache-supervisor.ts";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
import { cleanupTempDirs as removeFixtureDirs, tempDir } from "../test/tmp.ts";
let unresolved = 0;
async function cleanupTempDirs() {
  assert.equal(unresolved, 0, "retain unresolved service fixture");
  await removeFixtureDirs();
}
after(cleanupTempDirs);
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
test(
  "actual native service executes GNU once, reuses original execution, invalidates and refuses revoked actor",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const dir = await tempDir("cache-svc"),
      cwd = join(dir, "work"),
      socket = join(dir, "broker-sock"),
      frontend = join(dir, "shell"),
      broker = join(dir, "broker"),
      launcher = join(dir, "launch"),
      producer = join(dir, "producer");
    await chmod(dir, 0o700);
    await mkdir(cwd);
    await writeFile(join(cwd, ".watchmanconfig"), "{}");
    for (const [target, source] of [
      [frontend, "../src/executors/native/cache-shell.c"],
      [broker, "../src/executors/native/cache-broker.c"],
      [launcher, "./cache-shell-launch.c"],
      [producer, "./cache-output-producer.c"],
    ])
      await promisify(execFile)("cc", [
        "-static",
        "-Wall",
        "-Wextra",
        "-Werror",
        fileURLToPath(new URL(source, import.meta.url)),
        "-o",
        target,
      ]);
    await writeFile(frontend + ".config", `CF1\n/bin/bash\n${socket}\n3000\n`, { mode: 0o600 });
    const input = join(cwd, "input"),
      manifest = join(cwd, "checksums");
    await writeFile(input, "one\n");
    const line = async () =>
      createHash("sha256")
        .update(await readFile(input))
        .digest("hex") + "  input\n";
    await writeFile(manifest, await line());
    const watcher = spawn(
      process.env.PI_DADDY_CACHE_WATCHMAN ?? "watchman",
      [
        "--foreground",
        "--no-save-state",
        "--sockname",
        join(dir, "watch-sock"),
        "--logfile",
        join(dir, "log"),
        "--statefile",
        join(dir, "state"),
        "--pidfile",
        join(dir, "pid"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const watcherStopped = once(watcher, "close");
    void watcherStopped.catch(() => {});
    unresolved++;
    const owner = await readCacheOwner(process.pid),
      image = await stat(frontend, { bigint: true }),
      roles = new CacheShellRoles(8),
      nativeContext = new CacheNativeContext({
        checks: 8,
        maxReadBytes: 1200000,
        maxTotalBytes: 3000000,
        timeoutMs: 3000,
      }),
      env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
    const invocation = {
      cwd,
      shell: "/bin/bash",
      command: "LC_ALL=C exec /usr/bin/gnusha256sum --strict -c checksums",
      env,
      timeoutMs: 3000,
    };
    const largeCommand = `exec '${producer.replaceAll("'", "'\\''")}'`;
    let tracker: WatchmanTracker | undefined,
      runtime: PersonalCacheRuntime | undefined,
      channel: CacheBrokerChannel | undefined,
      service: CacheShellService | undefined,
      handle: CacheSupervisorHandle | undefined,
      launches = 0,
      permitted = true,
      forced = false;
    let nativeFactory: CacheNativeBashFactory | undefined,
      imageStore: CacheNativeImages | undefined,
      nativeIssuer: CacheNativeIssuer | undefined;
    let eligibilityAction: (() => void) | undefined;
    const children: ChildProcess[] = [],
      resolutions: Awaited<ReturnType<PersonalCacheRuntime["request"]>>[] = [],
      errors: unknown[] = [];
    try {
      tracker = await WatchmanTracker.connect({
        socketPath: join(dir, "watch-sock"),
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
            id: "controlled-gnu",
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
            ].map((path) => ({ path, kind: "file" })),
          },
          {
            ...invocation,
            command: largeCommand,
            id: "controlled-stream",
            revision: "1",
            contract: "personal-best-effort-v1",
            effects: "none",
            external: "none",
            deterministic: true,
            inputs: [producer, "/bin/bash", "/etc/ld.so.cache", "/usr/lib/x86_64-linux-gnu/libc.so.6"].map((path) => ({
              path,
              kind: "file",
            })),
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
      const backend = new CacheShellBackend(runtime);
      let admission: Promise<CacheSupervisorHandle>;
      channel = new CacheBrokerChannel({
        deadlineMs: 3000,
        identify: async (pid) => {
          const identity = await readCacheOwner(pid);
          await nativeIssuer?.claim(identity);
          return identity;
        },
        write: (frame) => {
          assert.ok(handle);
          handle.process.stdin.write(frame);
        },
        stop: async () => {
          await (await admission).stop();
        },
        authorize: (actual) => service?.canAttach(actual) === true,
        onPeer: (peer) => service!.open(peer),
        onData: (peer, bytes) => service!.data(peer, bytes),
        onClosed: (peer) => service!.closed(peer),
      });
      service = new CacheShellService({
        roles,
        workspace: cwd,
        clients: 8,
        handshakeMs: 3000,
        eligible: (actual) => {
          if (eligibilityAction) {
            eligibilityAction();
            eligibilityAction = undefined;
            return false;
          }
          return [invocation.command, largeCommand].includes(actual.command);
        },
        onError: (error) => {
          errors.push(error);
        },
        validate: async (peer, actualInvocation, _request, signal) => {
          const issued = await nativeIssuer?.validate(peer.identity, actualInvocation, signal);
          if (issued) return issued.kind;
          // Separately controlled launch-gate fixtures are not native issuer calls.
          const result = await nativeContext.validate(
            peer.identity,
            {
              parent: owner,
              image: { path: frontend, dev: String(image.dev), ino: String(image.ino) },
              invocation: actualInvocation,
            },
            signal,
          );
          return result.kind;
        },
        run: async (actual, options) => {
          const result = await backend.run(actual, { ...options, force: forced });
          if (result) resolutions.push(result.resolution);
          return result;
        },
        closeBackend: () => runtime!.shutdown(),
        stopTransport: () => channel!.shutdown(),
      });
      admission = startSupervisedCache({
        owner,
        entry: new URL("./cache-broker-entry.mjs", import.meta.url),
        args: [broker, socket],
        onData: (stream, bytes) => {
          if (stream === "stdout") channel!.feed(bytes);
          else errors.push(Error("owned broker diagnostics: " + bytes.toString()));
        },
      });
      handle = await admission;
      await channel.ready;
      handle.process.stdin.on("error", (error) => channel!.end(error));
      handle.process.stdout.on("end", () => channel!.end());
      async function run(releaseDuringEligibility = false, large = false) {
        const call = large ? { ...invocation, command: largeCommand, timeoutMs: 8000 } : invocation;
        const priorResults = resolutions.length;
        let liveBeforeCompletion = false;
        const child = spawn(launcher, [frontend, "-c", call.command], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe", "pipe"],
        });
        children.push(child);
        const stopped = once(child, "close"),
          stdout: Buffer[] = [],
          stderr: Buffer[] = [];
        child.stdout!.on("data", (b) => {
          stdout.push(b);
          if (large && resolutions.length === priorResults) liveBeforeCompletion = true;
        });
        child.stderr!.on("data", (b) => stderr.push(b));
        const role = roles.issue(await readCacheOwner(child.pid!), cwd, call, () => permitted);
        if (releaseDuringEligibility) eligibilityAction = () => roles.release(role);
        (child.stdio[3] as import("node:stream").Writable).end("G");
        const timeout = setTimeout(() => child.kill("SIGKILL"), 6000);
        try {
          const [code, signal] = await stopped;
          return { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), liveBeforeCompletion };
        } finally {
          clearTimeout(timeout);
          roles.release(role);
        }
      }
      const first = await run();
      assert.equal(first.code, 0, first.stderr.toString());
      assert.equal(first.stdout.toString(), "input: OK\n");
      const id = resolutions[0].executionId;
      assert.equal(resolutions[0].kind, "execute");
      const hit = await run();
      assert.deepEqual(hit, first);
      assert.equal(resolutions[1].kind, "reuse");
      assert.equal(resolutions[1].executionId, id);
      assert.equal(launches, 1);
      // Explicitly owned stock factory, not event/command-order correlation or a gated launcher.
      const cli = await realpath((await promisify(execFile)("which", ["pi"])).stdout.trim());
      const sdk = await import(pathToFileURL(join(dirname(cli), "index.js")).href);
      const frontendBytes = await readFile(frontend);
      imageStore = new CacheNativeImages({
        directory: dir,
        image: frontendBytes,
        sha256: createHash("sha256").update(frontendBytes).digest("hex"),
        socket,
        admissionMs: 3000,
        maxLeases: 2,
        maxImageBytes: frontendBytes.length,
        maxStorageBytes: 2 * (frontendBytes.length + 8192),
      });
      nativeIssuer = new CacheNativeIssuer({
        parent: owner,
        workspace: cwd,
        maxCalls: 2,
        maxPending: 8,
        roles,
        images: imageStore,
        context: nativeContext,
        authorize: () => permitted,
      });
      nativeFactory = new CacheNativeBashFactory({
        cwd,
        native: sdk,
        maxCalls: 2,
        authorize: () => permitted,
        options: {
          shellPath: "/bin/bash",
          exposeSessionEnvironment: false,
          spawnHook: (context) => ({ ...context, env }),
        },
        allocate: (actual, context) => nativeIssuer!.allocate(actual, context),
      });
      const context = { cwd } as Parameters<typeof nativeFactory.definition.execute>[4];
      for (const toolCallId of ["native-one", "native-repeat"]) {
        const result: Awaited<ReturnType<CacheNativeBashFactory["definition"]["execute"]>> =
          await nativeFactory.definition.execute(
            toolCallId,
            { command: invocation.command, timeout: 3 },
            undefined,
            undefined,
            context,
          );
        assert.equal(result.content.find((item) => item.type === "text")?.text, "input: OK\n");
        assert.equal(resolutions.at(-1)!.kind, "reuse");
        assert.equal(resolutions.at(-1)!.executionId, id);
        assert.equal(nativeFactory.stats().owned, 0);
        assert.equal(nativeIssuer.stats().owned, 0);
        assert.equal(nativeIssuer.stats().pending, 0);
        assert.equal(launches, 1, "real native factory hits must not start the qualified runner again");
      }
      const beforeParallel = resolutions.length;
      const parallel = await Promise.all(
        ["native-parallel-a", "native-parallel-b"].map((toolCallId) =>
          nativeFactory!.definition.execute(
            toolCallId,
            { command: invocation.command, timeout: 3 },
            undefined,
            undefined,
            context,
          ),
        ),
      );
      for (const result of parallel)
        assert.equal(result.content.find((item) => item.type === "text")?.text, "input: OK\n");
      assert.equal(resolutions.length, beforeParallel + 2);
      for (const result of resolutions.slice(beforeParallel)) {
        assert.equal(result.kind, "reuse");
        assert.equal(result.executionId, id);
      }
      assert.equal(nativeIssuer.stats().owned, 0);
      assert.equal(nativeIssuer.stats().pending, 0);
      assert.equal(roles.size(), 0);
      assert.equal(launches, 1);
      await nativeFactory.shutdown();
      await imageStore.close();
      assert.deepEqual(imageStore.stats(), { owned: 0, reservedBytes: 0, rootOwned: false, faulted: false });
      await writeFile(input, "two\n");
      const changed = await run();
      assert.notEqual(changed.code, 0);
      assert.equal(launches, 2);
      await writeFile(manifest, await line());
      assert.equal((await run()).code, 0);
      assert.equal(launches, 3);
      forced = true;
      assert.equal((await run()).code, 0);
      forced = false;
      assert.equal(launches, 4);
      runtime.clear();
      assert.equal((await run()).code, 0);
      assert.equal(launches, 5);
      permitted = false;
      const denied = await run();
      assert.equal(denied.code, 126);
      assert.match(denied.stderr.toString(), /coordinator rejected/);
      assert.equal(launches, 5);
      permitted = true;
      const released = await run(true);
      assert.equal(released.code, 126, released.stderr.toString());
      assert.match(released.stderr.toString(), /coordinator rejected/);
      assert.equal(launches, 5);
      const live = await run(false, true);
      assert.equal(live.code, 7, live.stderr.toString());
      assert.equal(live.liveBeforeCompletion, true, "frontend must receive fresh bytes before runtime outcome");
      assert.deepEqual(live.stdout, Buffer.concat([Buffer.from("start\n"), Buffer.alloc(2 * 1024 * 1024, 97)]));
      assert.deepEqual(live.stderr, Buffer.alloc(1024 * 1024, 98));
      assert.equal(resolutions.at(-1)!.outcome!.complete, false);
      assert.equal(resolutions.at(-1)!.published, false);
      assert.equal(launches, 6);
      await tracker.close();
      runtime.uncertain("controlled Watchman disconnect");
      const ordinary = await run();
      assert.equal(ordinary.code, 0, ordinary.stderr.toString());
      assert.equal(ordinary.stdout.toString(), "input: OK\n");
      assert.equal(resolutions.at(-1)!.kind, "execute");
      assert.equal(resolutions.at(-1)!.published, false);
      assert.equal(launches, 7, "known pre-launch loss executes once after G, never native fallback/retry");
      assert.equal((await run()).code, 0);
      assert.equal(launches, 8, "normal uncertainty output is not a reusable cache entry");
      assert.equal(roles.size(), 0);
      assert.deepEqual(errors, []);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      const results = await Promise.allSettled([
        service?.shutdown() ?? channel?.shutdown() ?? handle?.stop(),
        runtime?.shutdown(),
        nativeFactory?.shutdown(),
        nativeIssuer?.close(),
        imageStore?.close(),
        nativeContext.close(),
      ]);
      watcher.kill("SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          watcherStopped,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              watcher.kill("SIGKILL");
              reject(Error("fixture Watchman cleanup unresolved"));
            }, 1500);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const failures = results.flatMap((row) => (row.status === "rejected" ? [row.reason] : []));
      if (failures.length) throw new AggregateError(failures, "retain unresolved native service fixture");
      unresolved--;
    }
  },
);
