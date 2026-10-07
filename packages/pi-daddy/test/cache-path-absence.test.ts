/** Enduring absence-resolution requirements: only ENOENT from component open may
 * describe a sampled missing binding; other failures and cwd loss never become absence.
 * These observations are not an access check or coherent/current-source certificate.
 */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { chmod, mkdir, open, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { acquireOwnedPaths } from "../src/executors/cache-path-acquisition.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
const limits = { maxPaths: 64, maxObjects: 128, maxComponents: 256, maxSymlinks: 40, timeoutMs: 3000 };
const noLinks = async () => {
  throw new Error("held-target reader required");
};
test("explicit missing observations retain first missing binding, unwalked suffix and positive endpoints", async () => {
  const cwd = await tempDir("owned-absence-");
  await writeFile(join(cwd, "file"), "data");
  const result = await acquireOwnedPaths({
    cwd,
    paths: ["missing", "not-there/child", "file"],
    limits,
    readLink: noLinks,
    observeMissing: true,
  });
  if (result.kind !== "observed") assert.fail(result.reason);
  try {
    assert.equal(result.owner.endpoints.length, 1);
    assert.equal(result.owner.endpoints[0].path, "file");
    assert.deepEqual(
      result.owner.absences.map(({ path, name, remaining }) => ({ path, name, remaining })),
      [
        { path: "missing", name: "missing", remaining: [] },
        { path: "not-there/child", name: "not-there", remaining: ["child"] },
      ],
    );
    for (const absence of result.owner.absences) {
      assert.equal(result.owner.objects[absence.parent].kind, "directory");
      assert.ok(Object.isFrozen(absence) && Object.isFrozen(absence.remaining));
    }
    assert.ok(Object.isFrozen(result.owner.absences));
    await writeFile(join(cwd, "missing"), "new input");
    assert.equal(result.owner.absences.length, 2, "sampled absence does not update itself or certify current state");
  } finally {
    await result.owner.release();
  }
  await assert.rejects(open(`/proc/self/fd/${result.owner.objects[0].fd}`, constants.O_RDONLY), /ENOENT/);
});
test("dangling held symlink records target absence without discarding link or invocation spelling", async () => {
  const cwd = await tempDir("owned-absence-link-");
  await symlink("missing/child", join(cwd, "link"));
  const result = await acquireOwnedPaths({
    cwd,
    paths: ["link"],
    limits,
    readLink: async () => Buffer.from("missing/child"),
    observeMissing: true,
  });
  if (result.kind !== "observed") assert.fail(result.reason);
  try {
    assert.equal(result.owner.endpoints.length, 0);
    assert.deepEqual(
      result.owner.absences.map(({ path, name, remaining }) => ({ path, name, remaining })),
      [{ path: "link", name: "missing", remaining: ["child"] }],
    );
    assert.equal(result.owner.objects[result.owner.edges.find((e) => e.name === "link")!.child].kind, "symlink");
  } finally {
    await result.owner.release();
  }
});
test("missing observation is opt-in; missing cwd and nondirectory ancestors are not absences", async () => {
  const cwd = await tempDir("owned-absence-refusal-");
  await writeFile(join(cwd, "file"), "data");
  await assert.rejects(acquireOwnedPaths({ cwd, paths: ["missing"], limits, readLink: noLinks }), /operation failed/);
  await assert.rejects(
    acquireOwnedPaths({ cwd: join(cwd, "missing"), paths: ["file"], limits, readLink: noLinks, observeMissing: true }),
    /operation failed/,
  );
  const result = await acquireOwnedPaths({
    cwd,
    paths: ["file/child"],
    limits,
    readLink: noLinks,
    observeMissing: true,
  });
  assert.equal(result.kind, "bypass");
  if (result.kind === "bypass") assert.match(result.reason, /nondirectory/);
});
test("search permission refusal never becomes a missing observation", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("requires nonroot search checks");
    return;
  }
  const cwd = await tempDir("owned-absence-access-"),
    locked = join(cwd, "locked");
  await mkdir(locked);
  await chmod(locked, 0);
  try {
    await assert.rejects(
      acquireOwnedPaths({ cwd, paths: ["locked/missing"], limits, readLink: noLinks, observeMissing: true }),
      (error: unknown) => {
        assert.ok(error instanceof Error && error.cause instanceof Error);
        assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
        return true;
      },
    );
  } finally {
    await chmod(locked, 0o700);
  }
});
test("invalid missing-observation option refuses before filesystem I/O", async () => {
  const result = await acquireOwnedPaths({
    cwd: "/does-not-exist",
    paths: ["file"],
    limits,
    readLink: noLinks,
    observeMissing: "yes" as unknown as boolean,
  });
  assert.equal(result.kind, "bypass");
  if (result.kind === "bypass") assert.match(result.reason, /invalid observeMissing/);
});
test("ENOENT from fstat is an operation failure, not sampled absence", async () => {
  const cwd = await tempDir("owned-absence-stat-"),
    fd = await open(cwd, constants.O_RDONLY);
  await writeFile(join(cwd, "file"), "data");
  const prototype = Object.getPrototypeOf(fd),
    original = prototype.stat;
  const interception = mock.method(prototype, "stat", async function (this: unknown, ...args: unknown[]) {
    const info = await original.apply(this, args);
    if (this !== fd && info.isFile()) throw Object.assign(new Error("injected fstat failure"), { code: "ENOENT" });
    return info;
  });
  try {
    await assert.rejects(
      acquireOwnedPaths({ cwd, paths: ["file"], limits, readLink: noLinks, observeMissing: true }),
      /operation failed/,
    );
  } finally {
    interception.mock.restore();
    await fd.close();
  }
});
test("missing suffix cannot evade component or object budgets", async () => {
  const cwd = await tempDir("owned-absence-bounds-");
  for (const restricted of [
    { ...limits, maxComponents: 1 },
    { ...limits, maxObjects: 1 },
  ]) {
    const result = await acquireOwnedPaths({
      cwd,
      paths: ["missing/child"],
      limits: restricted,
      readLink: noLinks,
      observeMissing: true,
    });
    assert.equal(result.kind, "bypass");
    if (result.kind === "bypass") assert.match(result.reason, /maxComponents|maxObjects/);
  }
});
