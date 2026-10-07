/** Real fixed-inode observations, not capture/freshness/cache eligibility. Installs/grants nothing. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, open, readFile, rename, statfs, unlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { startInodeObserver } from "../src/executors/cache-inode-observer.ts";
import { readCacheOwner, cacheProcessTerminated, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { tempDir, cleanupTempDirs as removeTempDirs } from "../test/tmp.ts";
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
let binary: string, sha256: string;
const known: CacheOwnerIdentity[] = [];
before(async () => {
  if (!enabled) return;
  const root = await tempDir("cache-inode-binary-");
  binary = join(root, "observer");
  await promisify(execFile)("cc", [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    fileURLToPath(new URL("../src/executors/native/cache-inode.c", import.meta.url)),
    "-o",
    binary,
  ]);
  sha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
});
async function cleanupTempDirs() {
  for (const identity of known)
    assert.equal(
      await cacheProcessTerminated(identity),
      true,
      `unresolved inode observer: ${JSON.stringify(identity)}`,
    );
  await removeTempDirs();
}
after(cleanupTempDirs);
async function fixture(duplicate = false, base?: string) {
  const root = await tempDir("cache-inode-input-", base),
    dir = join(root, "tree"),
    outside = join(root, "alias");
  await mkdir(dir);
  const path = join(dir, "input");
  await writeFile(path, "stable bytes");
  await link(path, outside);
  const input = await open(path, "r"),
    parent = await open(dir, "r");
  const entries = [{ fd: input.fd, info: await input.stat({ bigint: true }) }];
  if (duplicate) entries.push({ fd: input.fd, info: await input.stat({ bigint: true }) });
  entries.push({ fd: parent.fd, info: await parent.stat({ bigint: true }) });
  const observer = await startInodeObserver({
    binary,
    sha256,
    owner: await readCacheOwner(process.pid),
    objects: entries,
  });
  const identity = await readCacheOwner(observer.pid);
  known.push(identity);
  return {
    root,
    dir,
    path,
    outside,
    input,
    parent,
    observer,
    identity,
    async close() {
      await observer.stop();
      assert.equal(await cacheProcessTerminated(identity), true);
      await input.close();
      await parent.close();
    },
  };
}

test(
  "outside hardlink chmod000 invalidates all logical inode aliases without changing protected bytes",
  { skip: !enabled },
  async () => {
    const f = await fixture(true, fileURLToPath(new URL("../../..", import.meta.url)));
    try {
      assert.equal(
        (await statfs(f.root)).type,
        0xef53,
        "this source-inode case explicitly requires checkout ext4, not tmpfs",
      );
      const old = f.observer.ticket([0, 1]),
        parent = f.observer.ticket([2]);
      const manifest = f.observer.manifest();
      assert.equal(manifest[0].wd, manifest[1].wd);
      assert.equal(manifest[2].kind, "directory");
      await chmod(f.outside, 0);
      await f.observer.drain();
      assert.equal(f.observer.observationsUnchanged(old), false);
      assert.equal(
        f.observer.observationsUnchanged(parent),
        true,
        "outside alias isn't a directory entry in the covered parent",
      );
      assert.equal(await f.input.readFile("utf8"), "stable bytes");
      await assert.rejects(readFile(f.path), { code: "EACCES" });
      await chmod(f.outside, 0o600);
      await f.observer.drain();
      assert.equal(f.observer.observationsUnchanged(old), false);
    } finally {
      await chmod(f.path, 0o600);
      await f.close();
    }
  },
);

test(
  "parent membership add/delete/rename/replacement invalidates fixed scopes, never follows new inode",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      let old = f.observer.ticket([1]);
      const added = join(f.dir, "added");
      await writeFile(added, "new");
      await f.observer.drain();
      assert.equal(f.observer.observationsUnchanged(old), false);
      old = f.observer.ticket([1]);
      await rename(added, join(f.dir, "renamed"));
      await f.observer.drain();
      assert.equal(f.observer.observationsUnchanged(old), false);
      old = f.observer.ticket([1]);
      await unlink(join(f.dir, "renamed"));
      await f.observer.drain();
      assert.equal(f.observer.observationsUnchanged(old), false);
      const original = f.observer.manifest()[0].ino;
      old = f.observer.ticket([0, 1]);
      await rename(f.path, join(f.dir, "old"));
      await writeFile(f.path, "replacement");
      await f.observer.drain();
      assert.equal(f.observer.observationsUnchanged(old), false);
      assert.equal(f.observer.manifest()[0].ino, original);
      assert.equal(await f.input.readFile("utf8"), "stable bytes");
      const replacement = await open(f.path, "r");
      try {
        assert.notEqual(String((await replacement.stat({ bigint: true })).ino), original);
      } finally {
        await replacement.close();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "reads/open/close do not falsely claim atime coverage; metadata changes do invalidate",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const old = f.observer.ticket([0, 1]);
      await readFile(f.path);
      await f.observer.drain();
      assert.equal(
        f.observer.observationsUnchanged(old),
        true,
        "only processed requested event classes, NOT all metadata",
      );
      await utimes(f.path, new Date(1234000), new Date(5678000));
      await f.observer.drain();
      assert.equal(f.observer.observationsUnchanged(old), false);
    } finally {
      await f.close();
    }
  },
);

test("directory self metadata and MOVE_SELF use audited ISDIR compatibility", { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    let old = f.observer.ticket([1]);
    await chmod(f.dir, 0o750);
    await f.observer.drain();
    assert.equal(f.observer.observationsUnchanged(old), false);
    old = f.observer.ticket([1]);
    await rename(f.dir, join(f.root, "relocated"));
    await f.observer.drain();
    assert.equal(f.observer.observationsUnchanged(old), false);
    assert.equal(f.observer.manifest()[1].kind, "directory");
    const fresh = f.observer.ticket([1]);
    await f.observer.drain();
    assert.equal(
      f.observer.observationsUnchanged(fresh),
      true,
      "MOVE_SELF is a change, not watch rearm or invented ISDIR loss",
    );
  } finally {
    await f.close();
  }
});

test(
  "maximum-length non-UTF8 entry names remain byte observations, not decoded authority",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const old = f.observer.ticket([1]);
      const path = Buffer.concat([Buffer.from(f.dir + "/"), Buffer.alloc(255, 255)]);
      await writeFile(path, "bytes");
      await f.observer.drain();
      assert.equal(f.observer.observationsUnchanged(old), false);
      await unlink(path);
      await f.observer.drain();
    } finally {
      await f.close();
    }
  },
);

test(
  "parent descriptor reuse cannot retarget an already armed inherited/pinned object",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const old = f.observer.ticket([0]);
      await f.input.close();
      const other = join(f.root, "other");
      await writeFile(other, "other");
      const reused = await open(other, "r");
      try {
        await chmod(f.outside, 0o640);
        await f.observer.drain();
        assert.equal(f.observer.observationsUnchanged(old), false);
        assert.notEqual(f.observer.manifest()[0].ino, String((await reused.stat({ bigint: true })).ino));
      } finally {
        await reused.close();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "paused observer delivers events before drain ACK; until processed, ticket is not a freshness promise",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const old = f.observer.ticket([0]);
      process.kill(f.observer.pid, "SIGSTOP");
      let stopped = false;
      const deadline = performance.now() + 1000;
      while (performance.now() < deadline) {
        stopped = /\) T /.test(await readFile(`/proc/${f.observer.pid}/stat`, "utf8"));
        if (stopped) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(stopped, true);
      await chmod(f.outside, 0o640);
      const pending = f.observer.drain();
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(settled, false);
      assert.equal(f.observer.observationsUnchanged(old), true, "processed-only state can lag actual visible mutation");
      process.kill(f.observer.pid, "SIGCONT");
      await pending;
      assert.equal(
        f.observer.observationsUnchanged(old),
        false,
        "events preceding ACK must be applied before its resolve",
      );
    } finally {
      if (!(await cacheProcessTerminated(f.identity))) process.kill(f.observer.pid, "SIGCONT");
      await f.close();
    }
  },
);

test(
  "observer timeout owns death and permanently loses tickets before caller finally cleanup",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const old = f.observer.ticket([0]);
      process.kill(f.observer.pid, "SIGSTOP");
      await assert.rejects(f.observer.drain(), /exceeded/);
      await f.observer.faulted;
      assert.equal(await cacheProcessTerminated(f.identity), true);
      assert.equal(f.observer.observationsUnchanged(old), false);
      assert.throws(() => f.observer.ticket([0]), /lost/);
    } finally {
      await f.close();
    }
  },
);

test("unexpected native death latches permanent observation loss", { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const old = f.observer.ticket([0]);
    process.kill(f.observer.pid, "SIGKILL");
    await f.observer.faulted;
    assert.equal(f.observer.observationsUnchanged(old), false);
    assert.equal(await cacheProcessTerminated(f.identity), true);
  } finally {
    await f.close();
  }
});

test("non-readable watch admission and nonregular objects explicitly refuse", { skip: !enabled }, async () => {
  const root = await tempDir("cache-inode-admission-"),
    path = join(root, "input");
  await writeFile(path, "input");
  const input = await open(path, "r");
  try {
    await chmod(path, 0);
    await assert.rejects(
      startInodeObserver({
        binary,
        sha256,
        owner: await readCacheOwner(process.pid),
        objects: [{ fd: input.fd, info: await input.stat({ bigint: true }) }],
      }),
      /inode observation native refusal/,
    );
  } finally {
    await chmod(path, 0o600);
    await input.close();
  }
  const device = await open("/dev/null", "r");
  try {
    await assert.rejects(
      startInodeObserver({
        binary,
        sha256,
        owner: await readCacheOwner(process.pid),
        objects: [{ fd: device.fd, info: await device.stat({ bigint: true }) }],
      }),
      /regular file or directory/,
    );
  } finally {
    await device.close();
  }
});
