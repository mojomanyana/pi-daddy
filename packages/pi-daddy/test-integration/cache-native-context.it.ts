/** Actual Linux proc-context reads, distinct from static ABI/source or automatic Pi/grant qualification. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { test } from "node:test";
import { CacheNativeContext } from "../src/executors/cache-native-context.ts";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
for (const input of ["dev-null", "pipe", "path"] as const)
  test(
    `actual native process context ${input === "dev-null" ? "checks birth, parent, image, argv and ordered environment" : `rejects ${input} input`}`,
    { skip: !enabled, timeout: 10000 },
    async () => {
      const shell = await realpath("/bin/bash"),
        command = "while :; do :; done",
        env = { Z: "last", A: "first" };
      const image = await stat(shell, { bigint: true }),
        parent = await readCacheOwner(process.pid);
      const pathHandle = input === "path" ? await open("/dev/null", 0x200000) : undefined;
      const child = spawn(shell, ["-c", command], {
        cwd: "/",
        env,
        stdio: [pathHandle ? pathHandle.fd : input === "pipe" ? "pipe" : "ignore", "ignore", "ignore"],
      });
      const stopped = once(child, "close");
      const context = new CacheNativeContext({
        checks: 1,
        maxReadBytes: 1200000,
        maxTotalBytes: 3000000,
        timeoutMs: 3000,
      });
      try {
        // Await actual exec independently, not event/order-based cache issuance. Bounded fixture wait only.
        for (let attempt = 0; attempt < 200; attempt++) {
          if ((await readFile(`/proc/${child.pid}/cmdline`)).equals(Buffer.from([shell, "-c", command, ""].join("\0"))))
            break;
          if (attempt === 199) throw Error("fixture native exec unavailable");
          await new Promise((r) => setTimeout(r, 5));
        }
        const connector = await readCacheOwner(child.pid!);
        const expected = {
          parent,
          image: { path: shell, dev: String(image.dev), ino: String(image.ino) },
          invocation: { shell, cwd: "/", command, env, timeoutMs: 3000 },
        };
        const result = await context.validate(connector, expected);
        assert.equal(result.kind, input === "dev-null" ? "qualified" : "reject", JSON.stringify(result));
        if (input === "dev-null") {
          assert.equal((await context.validate({ ...connector, startTicks: "0" }, expected)).kind, "reject");
          assert.equal(
            (await context.validate(connector, { ...expected, parent: { ...parent, startTicks: "0" } })).kind,
            "reject",
          );
          assert.equal(
            (
              await context.validate(connector, {
                ...expected,
                invocation: { ...expected.invocation, env: { A: "first", Z: "last" } },
              })
            ).kind,
            "reject",
          );
          assert.equal(
            (await context.validate(connector, { ...expected, image: { ...expected.image, ino: "0" } })).kind,
            "reject",
          );
          assert.equal(
            (
              await context.validate(connector, {
                ...expected,
                invocation: { ...expected.invocation, command: "other" },
              })
            ).kind,
            "reject",
          );
        }
      } finally {
        child.kill("SIGKILL");
        await stopped;
        await Promise.all([context.close(), pathHandle?.close()]);
      }
      assert.deepEqual(context.stats(), { owned: 0, handles: 0, faulted: false, closed: true });
    },
  );
