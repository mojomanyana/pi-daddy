/** Actual held symlink inode metadata observation, not current source/capture certification. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lutimes,
  mkdir,
  open,
  readFile,
  rename,
  statfs,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { startInodeObserver } from "../src/executors/cache-inode-observer.ts";
import { readCacheOwner, cacheProcessTerminated, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { tempDir, cleanupTempDirs as removeTempDirs } from "../test/tmp.ts";
const enabled = process.env.PI_DADDY_IT_CACHE === "1",
  O_PATH = 0x200000;
let binary: string,
  sha256: string,
  unresolved = 0;
const known: CacheOwnerIdentity[] = [];
before(async () => {
  if (!enabled) return;
  const root = await tempDir("symlink-inode-binary-");
  binary = join(root, "observer");
  await promisify(execFile)("cc", [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    new URL("../src/executors/native/cache-inode.c", import.meta.url).pathname,
    "-o",
    binary,
  ]);
  sha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
});
async function cleanupTempDirs() {
  assert.equal(unresolved, 0, "symlink observation ownership unresolved; retain fixtures");
  for (const identity of known)
    assert.equal(await cacheProcessTerminated(identity), true, "retain symlink observer evidence");
  await removeTempDirs();
}
after(cleanupTempDirs);
async function fixture(dangling = false, base?: string) {
  const root = await tempDir("symlink-inode-input-", base),
    tree = join(root, "tree"),
    outside = join(root, "outside");
  await mkdir(tree);
  await mkdir(outside);
  const path = join(tree, "link"),
    target = join(tree, "target"),
    alias = join(outside, "alias");
  if (!dangling) await writeFile(target, "target bytes");
  await symlink("target", path);
  await link(path, alias);
  const input = await open(path, O_PATH | constants.O_NOFOLLOW),
    parent = await open(tree, O_PATH);
  const info = await input.stat({ bigint: true });
  unresolved++;
  let observer: Awaited<ReturnType<typeof startInodeObserver>>;
  try {
    observer = await startInodeObserver({
      binary,
      sha256,
      owner: await readCacheOwner(process.pid),
      objects: [
        { fd: input.fd, info },
        { fd: input.fd, info },
        { fd: parent.fd, info: await parent.stat({ bigint: true }) },
      ],
    });
  } catch (error) {
    await input.close();
    await parent.close();
    throw error;
  }
  const identity = await readCacheOwner(observer.pid);
  known.push(identity);
  return {
    root,
    tree,
    path,
    target,
    alias,
    input,
    parent,
    observer,
    identity,
    async close() {
      await observer.stop();
      assert.equal(await cacheProcessTerminated(identity), true);
      await input.close();
      await parent.close();
      unresolved--;
    },
  };
}
for (const [label, base, magic] of [
  ["tmpfs", undefined, 0x01021994],
  ["ext4", fileURLToPath(new URL("../../../", import.meta.url)), 0xef53],
] as const)
  test(
    `${label}: dangling held symlink aliases receive outside metadata changes while covered parent stays unchanged`,
    { skip: !enabled },
    async () => {
      const f = await fixture(true, base);
      try {
        assert.equal((await statfs(f.root)).type, magic);
        const manifest = f.observer.manifest();
        assert.equal(manifest[0].kind, "symlink");
        assert.equal(manifest[0].wd, manifest[1].wd);
        const old = f.observer.ticket([0, 1]),
          parent = f.observer.ticket([2]);
        await lutimes(f.alias, new Date(1234000), new Date(5678000));
        await f.observer.drain();
        assert.equal(f.observer.observationsUnchanged(old), false);
        assert.equal(f.observer.observationsUnchanged(parent), true);
        await lutimes(f.alias, new Date(0), new Date(0));
        await f.observer.drain();
        assert.equal(f.observer.observationsUnchanged(old), false);
        assert.equal(f.observer.manifest()[0].ino, String((await f.input.stat({ bigint: true })).ino));
      } finally {
        await f.close();
      }
    },
  );
test("target writes/chmod do not retarget a held symlink inode watch", { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const old = f.observer.ticket([0, 1]);
    await writeFile(f.target, "changed target bytes");
    await chmod(f.target, 0o640);
    await f.observer.drain();
    assert.equal(
      f.observer.observationsUnchanged(old),
      true,
      "only processed symlink inode metadata, NOT its target closure",
    );
    await lutimes(f.alias, new Date(11_000), new Date(12_000));
    await f.observer.drain();
    assert.equal(f.observer.observationsUnchanged(old), false);
  } finally {
    await f.close();
  }
});
test(
  "borrowed symlink FD closure/reuse cannot redirect an armed watch; replacement needs new coverage",
  { skip: !enabled },
  async () => {
    const f = await fixture(true);
    let reused: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const old = f.observer.ticket([0]);
      const fd = f.input.fd;
      await f.input.close();
      const other = join(f.root, "other");
      await symlink("unrelated", other);
      reused = await open(other, O_PATH | constants.O_NOFOLLOW);
      assert.equal(reused.fd, fd, "control actually reuses the numeric borrowed descriptor");
      await lutimes(f.alias, new Date(13_000), new Date(14_000));
      await f.observer.drain();
      assert.equal(f.observer.observationsUnchanged(old), false);
      const original = f.observer.manifest()[0].ino,
        beforeReplacement = f.observer.ticket([0, 2]);
      await rename(f.path, join(f.tree, "saved"));
      await symlink("replacement", f.path);
      await f.observer.drain();
      assert.equal(f.observer.observationsUnchanged(beforeReplacement), false);
      assert.equal(f.observer.manifest()[0].ino, original);
      const fresh = f.observer.ticket([0]);
      await lutimes(f.path, new Date(15_000), new Date(16_000));
      await f.observer.drain();
      assert.equal(
        f.observer.observationsUnchanged(fresh),
        true,
        "old inode is fixed, not replacement target or name coverage",
      );
    } finally {
      if (reused) await reused.close();
      await f.close();
    }
  },
);
test(
  "standalone symlink inode scope detects MOVE_SELF without relying on its parent ticket",
  { skip: !enabled },
  async () => {
    const f = await fixture(true);
    try {
      const old = f.observer.ticket([0]);
      await rename(f.path, join(f.tree, "renamed"));
      await f.observer.drain();
      assert.equal(f.observer.observationsUnchanged(old), false, "the standalone symlink epoch must change");
      assert.equal(f.observer.manifest()[0].kind, "symlink");
      const fresh = f.observer.ticket([0]);
      await f.observer.drain();
      assert.equal(f.observer.observationsUnchanged(fresh), true, "compatible self event is not watch loss or rearm");
    } finally {
      await f.close();
    }
  },
);

test(
  "stopped symlink observer leaves processed ticket true until real event drain; helper death loses it",
  { skip: !enabled },
  async () => {
    const f = await fixture(true);
    try {
      const old = f.observer.ticket([0]);
      process.kill(f.observer.pid, "SIGSTOP");
      const deadline = performance.now() + 1000;
      while (!/\) T /.test(await readFile(`/proc/${f.observer.pid}/stat`, "utf8")) && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.match(await readFile(`/proc/${f.observer.pid}/stat`, "utf8"), /\) T /);
      await lutimes(f.alias, new Date(17_000), new Date(18_000));
      assert.equal(f.observer.observationsUnchanged(old), true, "not source freshness");
      const draining = f.observer.drain();
      process.kill(f.observer.pid, "SIGCONT");
      await draining;
      assert.equal(f.observer.observationsUnchanged(old), false);
      const latest = f.observer.ticket([0]);
      process.kill(f.observer.pid, "SIGKILL");
      await f.observer.faulted;
      assert.equal(f.observer.observationsUnchanged(latest), false);
      assert.equal(await cacheProcessTerminated(f.identity), true);
    } finally {
      if (!(await cacheProcessTerminated(f.identity))) process.kill(f.observer.pid, "SIGCONT");
      await f.close();
    }
  },
);
