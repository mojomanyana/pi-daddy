import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { cacheNamespaceTerminated } from "../src/executors/cache-namespace-death.ts";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
async function fixture() {
  const procRoot = await tempDir("cache-namespace-tasks"),
    child = spawn(process.execPath, ["-e", "process.stdout.write('ready');process.stdin.resume()"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  const stopped = new Promise((resolve) => child.once("close", resolve));
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
  });
  const owner = await readCacheOwner(child.pid!);
  child.stdin.end();
  await stopped;
  await mkdir(join(procRoot, "2", "task", "2"), { recursive: true });
  await mkdir(join(procRoot, "2", "task", "3"));
  await writeFile(join(procRoot, "2", "status"), "State:\tZ (zombie)\n");
  await writeFile(join(procRoot, "2", "task", "2", "status"), "State:\tZ (zombie)\n");
  await writeFile(join(procRoot, "2", "task", "3", "status"), "State:\tS (sleeping)\n");
  return { owner, procRoot };
}
test("zombie leader does not certify death while any namespace-visible thread lives", async () => {
  const namespace = await fixture();
  assert.equal(await cacheNamespaceTerminated(namespace), false);
  await writeFile(join(namespace.procRoot, "2", "task", "3", "status"), "State:\tZ (zombie)\n");
  assert.equal(await cacheNamespaceTerminated(namespace), true);
});
test("unreadable thread state is unresolved rather than certified dead", async () => {
  const namespace = await fixture();
  await writeFile(join(namespace.procRoot, "2", "task", "3", "status"), "not a process status");
  await assert.rejects(cacheNamespaceTerminated(namespace), /status malformed/);
});
