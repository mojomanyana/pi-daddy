/** Real scheduler cancellation → qualified namespace supervision. NOT a command/source qualification.
 * Validation is deliberately synthetic and no successful result is published. Real detached fixture
 * descendants are identified while alive, then checked with strict PID/boot/start identity proofs.
 * Removing last-interest stop, late-owned-handle stop or shutdown teardown breaks these tests.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { CacheGraph } from "../src/products/cache-graph.ts";
import { CacheScheduler, type CacheRunOutcome } from "../src/products/cache-scheduler.ts";
import { startSupervisedCache, type CacheSupervisorHandle } from "../src/executors/cache-supervisor.ts";
import { cacheProcessTerminated, readCacheOwner, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
const optedIn = process.env.PI_DADDY_IT_CACHE === "1";
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await pause();
  }
  throw Error("scheduler namespace fixture did not settle in 3000ms");
}
async function descendants(marker: string): Promise<CacheOwnerIdentity[]> {
  const found: CacheOwnerIdentity[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = await readFile(`/proc/${entry}/cmdline`, "utf8");
      if (!command.split("\0").includes(marker)) continue;
      const identity = await readCacheOwner(Number(entry));
      if (identity) found.push(identity);
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return found;
}
for (const mode of ["last-interest", "root-shutdown", "late-handle"] as const) {
  test(
    `real scheduler ${mode} stops its namespace and detached grandchildren`,
    { skip: !optedIn, timeout: 15000 },
    async () => {
      assert.equal(process.platform, "linux");
      const graph = new CacheGraph({
        workspaces: 1,
        observations: 1,
        entries: 2,
        runs: 2,
        edges: 4,
        keyBytes: 128,
        output: { bytes: 4096, itemBytes: 1024, payloads: 4, deliveries: 4 },
      });
      const scheduler = new CacheScheduler(graph, {
        running: 1,
        pending: 2,
        requests: 4,
        requesters: 2,
        work: 2,
        validationMs: 500,
        completionMs: 500,
        calls: 4,
        streamBytes: 1024,
        streamChunks: 32,
        replies: { bytes: 4096, itemBytes: 1024, payloads: 4, deliveries: 4 },
      });
      const scope = graph.workspace("/synthetic-qualified-state"),
        input = graph.observe(scope, "synthetic-input", "synthetic-fingerprint");
      const marker = `cache-scheduler-native-${randomUUID()}`,
        owner = await readCacheOwner(process.pid),
        admitted = deferred<void>(),
        gate = deferred<void>();
      let handle: CacheSupervisorHandle | undefined,
        launches = 0;
      let identities: CacheOwnerIdentity[] = [];
      const treeTerminated = () =>
        until(
          async () => Promise.all(identities.map((identity) => cacheProcessTerminated(identity))),
          (values) => values.length >= 4 && values.every(Boolean),
        );
      const work = scheduler.prepare({
        workspace: scope,
        key: "fixture-only",
        inputs: [input],
        parents: [],
        shareable: true,
        validate: async () => true,
        start: async () => {
          launches++;
          handle = await startSupervisedCache({
            owner,
            entry: new URL("./cache-supervision-fixture.ts", import.meta.url),
            args: [marker],
          });
          identities = await until(
            () => descendants(marker),
            (values) => values.length >= 4,
          );
          admitted.resolve();
          if (mode === "late-handle") await gate.promise;
          return {
            outcome: new Promise<CacheRunOutcome>(() => {}),
            exited: handle.stopped.then(async () => {
              await treeTerminated();
            }),
            stop: () => handle!.stop(),
          };
        },
      });
      const actor = scheduler.attach(() => true),
        first = scheduler.createRequest(actor, work),
        a = scheduler.submit(first);
      try {
        await admitted.promise;
        assert.ok(identities.length >= 4);
        const second = scheduler.createRequest(actor, work),
          b = scheduler.submit(second);
        await until(
          async () => scheduler.stats(),
          (stats) => stats.calls === 0,
        );
        assert.equal(launches, 1);
        if (mode === "root-shutdown") {
          const shutdown = scheduler.shutdown();
          assert.equal((await a).kind, "cancelled");
          assert.equal((await b).kind, "cancelled");
          await shutdown;
        } else {
          scheduler.cancel(first);
          assert.equal((await a).kind, "cancelled");
          for (const identity of identities) assert.equal(await cacheProcessTerminated(identity), false);
          scheduler.cancel(second);
          assert.equal((await b).kind, "cancelled");
          gate.resolve();
          // Shutdown must not be the action that repairs a missing last-interest stop.
          await until(
            async () => Promise.all(identities.map((identity) => cacheProcessTerminated(identity))),
            (values) => values.every(Boolean),
          );
          await until(
            async () => scheduler.stats(),
            (stats) => stats.running === 0,
          );
          await scheduler.shutdown();
        }
        await until(
          async () => Promise.all(identities.map((identity) => cacheProcessTerminated(identity))),
          (values) => values.every(Boolean),
        );
        assert.equal(scheduler.stats().running, 0);
        assert.equal(graph.stats().runs, 0);
        assert.equal(graph.stats().entries, 0);
        assert.equal(
          (await readCacheOwner(process.pid)).startTicks,
          owner.startTicks,
          "fixture cannot stop its live owner",
        );
      } finally {
        gate.resolve();
        if (handle) await handle.stop();
        await scheduler.shutdown();
        if (identities.length) await treeTerminated();
        for (const identity of identities) assert.equal(await cacheProcessTerminated(identity), true);
      }
    },
  );
}
