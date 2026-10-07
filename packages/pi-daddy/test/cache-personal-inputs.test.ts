import assert from "node:assert/strict";
import { chmod, mkdir, rename, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { snapshotPersonalInputs } from "../src/executors/cache-personal-inputs.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
const limits = { paths: 32, bytes: 1024 * 1024, entries: 64, ms: 3000 };
const barrier = async () => ({ clock: "c:1:1", epoch: 0, changed: [], fresh: true });
async function capture(path: string, kind: "file" | "directory" | "existence" = "file") {
  const value = await snapshotPersonalInputs({ inputs: [{ path, kind }], limits, barrier });
  assert.equal(value.kind, "observed", JSON.stringify(value));
  assert.equal(value.contract, "personal-best-effort-v1");
  return value.fingerprint;
}

test("personal fingerprints detect byte edits even after timestamp restoration", async () => {
  const dir = await tempDir("cache-personal"),
    path = join(dir, "input");
  await writeFile(path, "one");
  const first = await capture(path);
  await writeFile(path, "two");
  await utimes(path, new Date(0), new Date(0));
  assert.notEqual(await capture(path), first);
});
test("touch and unrelated edits preserve unchanged relevant observations", async () => {
  const dir = await tempDir("cache-personal"),
    path = join(dir, "input");
  await writeFile(path, "one");
  const first = await capture(path);
  await utimes(path, new Date(0), new Date(0));
  await writeFile(join(dir, "unrelated"), "other");
  assert.equal(await capture(path), first);
});
test("atomic replacement and permission changes invalidate byte-identical input", async () => {
  const dir = await tempDir("cache-personal"),
    path = join(dir, "input");
  await writeFile(path, "one");
  const first = await capture(path);
  await writeFile(join(dir, "new"), "one");
  await rename(join(dir, "new"), path);
  const replaced = await capture(path);
  assert.notEqual(replaced, first);
  await chmod(path, 0o400);
  assert.notEqual(await capture(path), replaced);
});
test("absence tracks intermediate bindings and later creation", async () => {
  const dir = await tempDir("cache-personal"),
    path = join(dir, "missing", "input");
  const first = await capture(path, "existence");
  await mkdir(join(dir, "missing"));
  const second = await capture(path, "existence");
  assert.notEqual(second, first);
  await writeFile(path, "one");
  assert.notEqual(await capture(path, "existence"), second);
});
test("directory observations include untracked and ignored names and entry types", async () => {
  const dir = await tempDir("cache-personal");
  const first = await capture(dir, "directory");
  await writeFile(join(dir, ".ignored"), "one");
  assert.notEqual(await capture(dir, "directory"), first);
});
test("symlink spelling, targets, target bytes and ancestor access participate", async () => {
  const dir = await tempDir("cache-personal"),
    a = join(dir, "a"),
    link = join(dir, "link");
  await writeFile(a, "one");
  await symlink("a", link);
  const first = await capture(link);
  await writeFile(a, "two");
  assert.notEqual(await capture(link), first);
  const second = await capture(link);
  await chmod(dir, 0o750);
  assert.notEqual(await capture(link), second);
});
test("watcher uncertainty and transport errors explicitly bypass", async () => {
  const dir = await tempDir("cache-personal"),
    path = join(dir, "input");
  await writeFile(path, "one");
  for (const unhealthy of [
    async () => ({ ...(await barrier()), fresh: false }),
    async () => {
      throw Error("lost socket");
    },
  ]) {
    const value = await snapshotPersonalInputs({ inputs: [{ path, kind: "file" }], limits, barrier: unhealthy });
    assert.equal(value.kind, "bypass");
    if (value.kind === "bypass") assert.match(value.reason, /Watchman|lost socket/);
  }
});
test("observed events during capture bypass even when bytes match", async () => {
  const dir = await tempDir("cache-personal"),
    path = join(dir, "input");
  await writeFile(path, "one");
  let epoch = 0;
  const value = await snapshotPersonalInputs({
    inputs: [{ path, kind: "file" }],
    limits,
    barrier: async () => ({ ...(await barrier()), epoch: epoch++ }),
  });
  assert.equal(value.kind, "bypass");
});
test("file, path and directory budgets bypass rather than report partial fingerprints", async () => {
  const dir = await tempDir("cache-personal"),
    path = join(dir, "input");
  await writeFile(path, "four");
  await writeFile(join(dir, "extra"), "x");
  for (const [inputs, bound] of [
    [[{ path, kind: "file" }], { ...limits, bytes: 3 }],
    [
      [
        { path, kind: "file" },
        { path, kind: "file" },
      ],
      { ...limits, paths: 1 },
    ],
    [[{ path: dir, kind: "directory" }], { ...limits, entries: 1 }],
  ] as const)
    assert.equal((await snapshotPersonalInputs({ inputs, limits: bound, barrier })).kind, "bypass");
});
test("cancellation and non-directory traversal never become valid absence", async () => {
  const dir = await tempDir("cache-personal"),
    path = join(dir, "input");
  await writeFile(path, "one");
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(
    (await snapshotPersonalInputs({ inputs: [{ path, kind: "file" }], limits, barrier, signal: stopped.signal })).kind,
    "bypass",
  );
  const value = await snapshotPersonalInputs({
    inputs: [{ path: join(path, "child"), kind: "existence" }],
    limits,
    barrier,
  });
  assert.equal(value.kind, "bypass");
});
