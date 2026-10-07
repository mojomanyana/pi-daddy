/** Cancellation during actual namespace initialization; only fresh owned fixture processes. */
import assert from "node:assert/strict";
import { readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { cacheSupervisorBirthPorts } from "../src/executors/cache-supervisor-birth.ts";
import { cacheNamespaceTerminated, type observeCacheNamespace } from "../src/executors/cache-namespace-death.ts";
import {
  CacheSupervisorTerminationError,
  retainedCacheSupervisorCleanups,
} from "../src/executors/cache-supervisor-cleanup.ts";
import { pathToFileURL } from "node:url";
import { startSupervisedCache } from "../src/executors/cache-supervisor.ts";
import { readCacheOwner, cacheProcessTerminated, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { cleanupTempDirs as removeTempDirs, tempDir } from "../test/tmp.ts";
const retainedNamespaces = new Set<Awaited<ReturnType<typeof observeCacheNamespace>>>();
async function cleanupTempDirs() {
  assert.deepEqual(retainedCacheSupervisorCleanups(), [], "unresolved supervisor owners; retain fixtures");
  for (const namespace of retainedNamespaces) assert.equal(namespace.closed, true, "unresolved owner; retain fixture");
  await removeTempDirs();
}
after(cleanupTempDirs);
async function closeWitness(namespace: Awaited<ReturnType<typeof observeCacheNamespace>> | undefined) {
  if (!namespace || namespace.closed) return;
  assert.equal(await cacheNamespaceTerminated(namespace), true, "all namespace tasks must be dead immediately");
  await namespace.handle.close();
  namespace.closed = true;
}

test(
  "cancelled namespace admission joins and closes its late proc descriptor",
  { skip: process.env.PI_DADDY_IT_CACHE !== "1", timeout: 10000 },
  async () => {
    const owner = await readCacheOwner(process.pid),
      control = new AbortController();
    let nsfd = -1,
      release!: () => void,
      entered!: () => void,
      entryLoaded = false;
    let witness: Awaited<ReturnType<typeof observeCacheNamespace>> | undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      admission = new Promise<void>((resolve) => {
        entered = resolve;
      });
    // Pause the actual owned acquisition port, not global FileHandle/proc readers.
    const starting = startSupervisedCache(
      {
        owner,
        signal: control.signal,
        entry: new URL("./cache-supervision-fixture.ts", import.meta.url),
        args: ["late-admission", "log-entry"],
        onData: (_stream, bytes) => {
          if (bytes.includes("entry-loaded")) entryLoaded = true;
        },
      },
      {
        ...cacheSupervisorBirthPorts,
        observe: async (identity) => {
          const namespace = await cacheSupervisorBirthPorts.observe(identity);
          retainedNamespaces.add(namespace);
          nsfd = namespace.handle.fd;
          witness = await cacheSupervisorBirthPorts.observe(identity);
          retainedNamespaces.add(witness);
          entered();
          await gate;
          return namespace;
        },
      },
    );
    const settled = starting.then(
      (run) => ({ run }),
      (error: unknown) => ({ error }),
    );
    try {
      await admission;
      control.abort();
      let completed = false;
      void settled.then(() => {
        completed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(completed, false, "cancel cannot discharge the pending descriptor owner");
      release();
      const value = await settled;
      assert.ok("error" in value, "cancelled admission must not launch its entry");
      assert.match(String(value.error), /cancelled/);
      assert.equal(entryLoaded, false, "GO must not be issued after cancellation");
      assert.ok(nsfd >= 0);
      await assert.rejects(readlink(`/proc/self/fd/${nsfd}`), { code: "ENOENT" });
      assert.ok(witness);
      assert.equal(await cacheProcessTerminated(witness.owner), true);
      await closeWitness(witness);
    } finally {
      release();
      const value = await settled;
      if ("run" in value) await value.run.stop();
      else if (value.error instanceof CacheSupervisorTerminationError) await value.error.cleanup();
      await closeWitness(witness);
    }
  },
);

test(
  "startup cancellation interrupts readiness and joins actual namespace death",
  { skip: process.env.PI_DADDY_IT_CACHE !== "1", timeout: 10000 },
  async () => {
    const dir = await tempDir("cache-personal-startup"),
      entry = join(dir, "entry.mjs"),
      controller = new AbortController();
    await writeFile(
      entry,
      `import{readFileSync}from'node:fs';import{readCacheOwner}from${JSON.stringify(new URL("../src/kernel/cache-owner.ts", import.meta.url).href)};export async function startCacheProcess(){const p='/run/pi-daddy-cache-host-proc';const pid=Number(readFileSync(p+'/self/status','utf8').match(/^NSpid:\\s+(\\d+)/m)[1]);const owner=await readCacheOwner(pid,p);process.stdout.write('PENDING '+JSON.stringify(owner)+'\\n');setInterval(()=>{},1000);await new Promise(()=>{});}`,
    );
    let owner: CacheOwnerIdentity | undefined,
      data = "",
      cancelledAt = 0;
    const root = await readCacheOwner(process.pid);
    let witness: Awaited<ReturnType<typeof observeCacheNamespace>> | undefined;
    try {
      await assert.rejects(
        startSupervisedCache(
          {
            owner: root,
            entry: pathToFileURL(entry),
            initializationMs: 3000,
            signal: controller.signal,
            onData: (stream, bytes) => {
              if (stream !== "stdout") return;
              data += bytes;
              const line = data.match(/PENDING (.+)\n/);
              if (line && !owner) {
                owner = JSON.parse(line[1]) as CacheOwnerIdentity;
                cancelledAt = Date.now();
                controller.abort();
              }
            },
          },
          {
            ...cacheSupervisorBirthPorts,
            observe: async (identity) => {
              const namespace = await cacheSupervisorBirthPorts.observe(identity);
              retainedNamespaces.add(namespace);
              witness = await cacheSupervisorBirthPorts.observe(identity);
              retainedNamespaces.add(witness);
              return namespace;
            },
          },
        ),
        /cancelled/,
      );
      assert.ok(owner, "real initializer must enter before abort");
      assert.ok(Date.now() - cancelledAt < 1000, "cancellation must not wait for3000ms readiness timeout");
      assert.equal(await cacheProcessTerminated(owner), true);
      assert.deepEqual(await readCacheOwner(root.pid), root, "cancellation must not signal the calling root");
      assert.ok(witness);
      assert.deepEqual(witness.owner, owner, "independent held proc witness must match the actual initializer");
      await closeWitness(witness);
    } finally {
      await closeWitness(witness);
    }
  },
);
