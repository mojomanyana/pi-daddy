/** Actual owned Bash namespace cancellation through backend. Synthetic input barrier: NO freshness qualification. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { PersonalCacheRuntime } from "../src/products/cache-personal-runtime.ts";
import { CacheShellBackend } from "../src/products/cache-shell-backend.ts";
import { startPersonalBash } from "../src/executors/cache-personal-bash.ts";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
import { cleanupTempDirs, tempDir } from "../test/tmp.ts";
after(cleanupTempDirs);
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
test(
  "backend cancellation joins actual namespace death AND retained late output sink",
  { skip: !enabled, timeout: 15000 },
  async () => {
    const cwd = await tempDir("backend-cancel"),
      input = join(cwd, "input");
    await writeFile(input, "one");
    const invocation = {
      cwd,
      shell: "/bin/bash",
      command: "printf 'ready\\n'; sleep 100",
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 10000,
    };
    const output = { bytes: 8192, itemBytes: 4096, payloads: 8, deliveries: 8 },
      owner = await readCacheOwner(process.pid);
    let run: Awaited<ReturnType<typeof startPersonalBash>> | undefined, release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      ready = new Promise<void>((r) => {
        entered = r;
      });
    const runtime = new PersonalCacheRuntime({
      workspace: cwd,
      profiles: [
        {
          ...invocation,
          id: "cancel",
          revision: "1",
          contract: "personal-best-effort-v1",
          effects: "none",
          external: "none",
          deterministic: true,
          inputs: [{ path: input, kind: "file" }],
        },
      ],
      graph: { workspaces: 1, observations: 4, entries: 4, runs: 4, edges: 16, keyBytes: 128, output },
      scheduler: {
        running: 1,
        pending: 1,
        requests: 4,
        requesters: 2,
        work: 4,
        validationMs: 1000,
        completionMs: 1000,
        calls: 4,
        streamBytes: 1024,
        streamChunks: 8,
        replies: output,
      },
      inputs: { paths: 4, bytes: 1024, entries: 8, ms: 1000 },
      captures: 1,
      barrier: async () => ({ clock: "fixture:1", epoch: 0, changed: [], fresh: true }),
      closeInputs: async () => {},
      start: async (actual, options) => {
        run = await startPersonalBash(actual, { ...options, owner });
        return run;
      },
    });
    const backend = new CacheShellBackend(runtime),
      control = new AbortController();
    let done = false;
    const result = backend
      .run(invocation, {
        signal: control.signal,
        authorize: () => true,
        emit: async (channel, bytes) => {
          assert.equal(channel, "stdout");
          assert.equal(bytes.toString(), "ready\n");
          entered();
          await gate;
        },
      })
      .then((value) => {
        done = true;
        return value;
      });
    try {
      await ready;
      control.abort();
      await run!.exited;
      assert.equal(done, false, "tree death is not reader cleanup");
      assert.equal(runtime.stats().pendingReaders, 1);
      release();
      assert.equal(await result, undefined);
      assert.equal(runtime.stats().pendingReaders, 0);
    } finally {
      control.abort();
      release();
      await result;
      await runtime.shutdown();
    }
  },
);
