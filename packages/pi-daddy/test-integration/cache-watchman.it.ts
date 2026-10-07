/** Real Watchman only. PI_DADDY_IT_CACHE=1 requires the binary; missing prerequisites are failures, not passes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { WatchmanTracker } from "../src/executors/cache-watchman.ts";
import { WatchmanConnection } from "../src/executors/cache-watchman-protocol.ts";
import { cleanupTempDirs, tempDir } from "../test/tmp.ts";

after(cleanupTempDirs);
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
const watchman = process.env.PI_DADDY_CACHE_WATCHMAN ?? "watchman";

test(
  "Watchman barrier catches relevant additions, replacements, ignored and untracked input names",
  { skip: !enabled },
  async () => {
    const dir = await tempDir("cache-watchman-real");
    const root = join(dir, "workspace");
    await mkdir(root);
    await writeFile(join(root, ".watchmanconfig"), "{}");
    await writeFile(join(root, ".gitignore"), "ignored-input\n");
    const socket = join(dir, "sock");
    const server = spawn(
      watchman,
      [
        "--foreground",
        "--no-save-state",
        "--sockname",
        socket,
        "--logfile",
        join(dir, "log"),
        "--statefile",
        join(dir, "state"),
        "--pidfile",
        join(dir, "pid"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let errors = "";
    const stopped = new Promise<void>((resolve) => {
      server.once("exit", () => resolve());
      server.on("error", (error) => {
        errors += error.message;
        if (server.pid === undefined) resolve();
      });
    });
    server.stderr.on("data", (data) => (errors += data));
    const loss: string[] = [];
    let tracker: WatchmanTracker | undefined;
    try {
      tracker = await WatchmanTracker.connect({
        socketPath: socket,
        root,
        startupMs: 3000,
        onUncertain: (reason) => loss.push(reason),
      });
      const initial = await tracker.barrier();
      assert.equal(initial.fresh, true);
      for (const name of ["input.txt", "ignored-input", "untracked-input"])
        await writeFile(join(root, name), "initial");
      const added = await tracker.barrier();
      assert.equal(added.fresh, true);
      assert.ok(added.changed.includes("input.txt"));
      assert.ok(added.changed.includes("ignored-input"));
      assert.ok(added.changed.includes("untracked-input"));
      await writeFile(join(root, "replacement"), "changed");
      await rename(join(root, "replacement"), join(root, "input.txt"));
      assert.ok((await tracker.barrier()).changed.includes("input.txt"));
      const faults: string[] = [];
      const fault = await WatchmanConnection.connect(
        socket,
        () => {
          throw new Error("unexpected frame on test-only fault connection");
        },
        (reason) => faults.push(reason),
      );
      try {
        assert.equal((await fault.command(["debug-recrawl", root])).recrawl, true);
        assert.deepEqual(faults, []);
      } finally {
        fault.close();
      }
      const afterRecrawl = await tracker.barrier();
      assert.equal(afterRecrawl.fresh, false, "recrawl cannot validate an old cached result");
      assert.ok(loss.length > 0);
      // Watchman 4.9 keeps its recrawl warning in later replies. Do not optimistically clear it.
      const later = await tracker.barrier();
      if (!later.fresh)
        assert.ok(
          loss.some((reason) => reason.includes("warning")),
          loss.join("\n"),
        );
      tracker.close();
      tracker = undefined;
      assert.equal(server.exitCode, null, "closing a shared connection must not stop Watchman");
    } finally {
      tracker?.close();
      server.kill("SIGTERM");
      await stopped;
    }
    assert.equal(errors, "");
  },
);

test("Watchman ignores configured observation scopes only with a loud refusal", { skip: !enabled }, async () => {
  const dir = await tempDir("cache-watchman-ignore");
  const root = join(dir, "workspace");
  await mkdir(root);
  await writeFile(join(root, ".watchmanconfig"), JSON.stringify({ ignore_dirs: ["src"] }));
  const socket = join(dir, "sock");
  const server = spawn(
    watchman,
    [
      "--foreground",
      "--no-save-state",
      "--sockname",
      socket,
      "--logfile",
      join(dir, "log"),
      "--statefile",
      join(dir, "state"),
      "--pidfile",
      join(dir, "pid"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let errors = "";
  const stopped = new Promise<void>((resolve) => {
    server.once("exit", () => resolve());
    server.on("error", (error) => {
      errors += error.message;
      if (server.pid === undefined) resolve();
    });
  });
  try {
    await assert.rejects(
      WatchmanTracker.connect({ socketPath: socket, root, startupMs: 3000, onUncertain: () => {} }),
      /Watchman.*ignore_dirs.*incomplete/,
    );
  } finally {
    server.kill("SIGTERM");
    await stopped;
    assert.equal(errors, "", `Watchman fixture failed to spawn: ${errors}`);
  }
});
