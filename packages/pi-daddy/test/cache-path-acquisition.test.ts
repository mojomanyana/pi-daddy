import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { acquireOwnedPaths } from "../src/executors/cache-path-acquisition.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
const limits = { maxPaths: 64, maxObjects: 128, maxComponents: 256, maxSymlinks: 40, timeoutMs: 3000 };
const noLinks = async () => {
  throw new Error("symlink needs qualified held-target reader");
};
test("ordinary paths produce owned endpoints/resolution metadata, not current-source validation", async () => {
  const cwd = await tempDir("owned-path-"),
    path = join(cwd, "file");
  await writeFile(path, "original");
  const result = await acquireOwnedPaths({ cwd, paths: ["file", path], limits, readLink: noLinks });
  if (result.kind !== "observed") assert.fail(result.reason);
  try {
    assert.equal(result.owner.endpoints.length, 2);
    const first = result.owner.objects[result.owner.endpoints[0].object],
      second = result.owner.objects[result.owner.endpoints[1].object];
    assert.equal(`${first.dev}:${first.ino}`, `${second.dev}:${second.ino}`);
    assert.notEqual(first.fd, second.fd, "equal physical objects still retain distinct path/mount pins");
    assert.ok(result.owner.edges.some((edge) => edge.name === "file"));
    assert.ok(Object.isFrozen(result.owner.objects));
    await rename(path, join(cwd, "saved"));
    await writeFile(path, "replacement");
    const old = result.owner.objects[result.owner.endpoints[0].object];
    assert.equal((await readFile(`/proc/self/fd/${old.fd}`)).toString(), "original");
    assert.equal(await readFile(path, "utf8"), "replacement");
  } finally {
    await result.owner.release();
  }
  await assert.rejects(open(`/proc/self/fd/${result.owner.objects[0].fd}`, constants.O_RDONLY), /ENOENT/);
});
test("invalid budgets/unsupported paths refuse before path I/O; bound expansion retains no owner", async () => {
  for (const bad of [0, NaN, -1])
    assert.equal(
      (
        await acquireOwnedPaths({
          cwd: "/missing",
          paths: ["file"],
          limits: { ...limits, maxPaths: bad },
          readLink: noLinks,
        })
      ).kind,
      "bypass",
    );
  for (const path of ["", "../x", "a//b", "a/./b", "x\0", "x y"])
    assert.equal(
      (await acquireOwnedPaths({ cwd: "/missing", paths: [path], limits, readLink: noLinks })).kind,
      "bypass",
    );
  const cwd = await tempDir("owned-path-bound-");
  await writeFile(join(cwd, "file"), "data");
  const result = await acquireOwnedPaths({
    cwd,
    paths: ["file"],
    limits: { ...limits, maxObjects: 1 },
    readLink: noLinks,
  });
  assert.equal(result.kind, "bypass");
  if (result.kind === "bypass") assert.match(result.reason, /maxObjects/);
});
test("equal physical directories on different existing mounts preserve dotdot traversal context (REV-001)", async (t) => {
  let a, b;
  try {
    a = await stat("/run/shm", { bigint: true });
    b = await stat("/dev/shm", { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip("existing mount-context fixture unavailable");
      return;
    }
    throw error;
  }
  if (a.dev !== b.dev || a.ino !== b.ino) {
    t.skip("existing mount-context identities differ; no live measurement");
    return;
  }
  const cwd = await tempDir("owned-path-mount-", "/dev/shm"),
    name = cwd.split("/").pop()!;
  await writeFile(join(cwd, "file"), "data");
  const target = `../../shm/${name}/file`;
  await symlink(target, join(cwd, "link"));
  const result = await acquireOwnedPaths({
    cwd: "/",
    paths: [`/run/shm/${name}/file`, `/dev/shm/${name}/link`],
    limits,
    readLink: async () => Buffer.from(target),
  });
  if (result.kind !== "observed") assert.fail(result.reason);
  try {
    const dotdots = result.owner.edges.filter((edge) => edge.name === "..");
    assert.equal(dotdots.length, 2);
    const parent = result.owner.objects[dotdots[1].child],
      expected = await stat("/dev", { bigint: true });
    assert.equal(
      `${parent.dev}:${parent.ino}`,
      `${expected.dev}:${expected.ino}`,
      "directory FD must retain the /dev mount-relative parent",
    );
  } finally {
    await result.owner.release();
  }
});

test("symlinks never fall back to by-name readlink or silently normalize the invocation", async () => {
  const cwd = await tempDir("owned-path-link-");
  await writeFile(join(cwd, "file"), "data");
  await symlink("file", join(cwd, "link"));
  await assert.rejects(acquireOwnedPaths({ cwd, paths: ["link"], limits, readLink: noLinks }), /operation failed/);
});
