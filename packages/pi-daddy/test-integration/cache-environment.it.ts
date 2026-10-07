/** Native environment vector parity for the trusted worker, not production Pi/native Bash qualification. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startPersonalBash } from "../src/executors/cache-personal-bash.ts";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
import { cleanupTempDirs, tempDir } from "../test/tmp.ts";
after(cleanupTempDirs);
test(
  "supervised command receives the same unsorted environment vector as ordinary Node execution",
  {
    skip: process.env.PI_DADDY_IT_CACHE !== "1",
    timeout: 15000,
  },
  async () => {
    const cwd = await tempDir("cache-env"),
      image = join(cwd, "environment");
    await promisify(execFile)("cc", [
      "-static",
      "-Wall",
      "-Wextra",
      "-Werror",
      fileURLToPath(new URL("./cache-environment.c", import.meta.url)),
      "-o",
      image,
    ]);
    const env = { "10": "ten", "2": "two", Z: "last", A: "first", "01": "leading", M: "Unicode λ" };
    const ordinary = await promisify(execFile)(image, ["-c", "literal"], { cwd, env });
    const stdout: Buffer[] = [];
    const run = await startPersonalBash(
      { cwd, shell: image, command: "literal", env, timeoutMs: 3000 },
      {
        owner: await readCacheOwner(process.pid),
        executionId: "environment-parity",
        signal: new AbortController().signal,
        onData: (bytes) => {
          const row = JSON.parse(bytes.toString("utf8"));
          if (row.channel === "stdout") stdout.push(Buffer.from(row.bytes, "base64"));
        },
      },
    );
    try {
      const result = await run.outcome;
      await run.exited;
      assert.equal(result.exitCode, 0);
      assert.equal(result.complete, true);
      assert.equal(Buffer.concat(stdout).toString("utf8"), ordinary.stdout);
      assert.equal(
        ordinary.stdout,
        Object.entries(env)
          .map(([name, value]) => `${name}=${value}\n`)
          .join(""),
      );
    } finally {
      await run.stop();
    }
  },
);
