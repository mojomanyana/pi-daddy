import assert from "node:assert/strict";
import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { readCacheOwner, cacheOwnerMatches, cacheProcessTerminated } from "../src/kernel/cache-owner.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { BoundedReadCleanupError, readBoundedFile } from "../src/kernel/bounded-read.ts";

after(cleanupTempDirs);
const boot = "493d7d19-34d2-4b29-a6e8-1bfa9233ccf1";
async function fixture(state = "S") {
  const root = await tempDir("cache-owner");
  await mkdir(join(root, "sys/kernel/random"), { recursive: true });
  await mkdir(join(root, "123"));
  await writeFile(join(root, "sys/kernel/random/boot_id"), `${boot}\n`);
  // stat fields 3..22: comm may contain spaces and closing parentheses.
  await writeFile(join(root, "123/stat"), `123 (a ) tricky process) ${state} ${Array(18).fill("0").join(" ")} 987\n`);
  return root;
}

test("cache owner includes boot identity and process start, not PID alone", async () => {
  const identity = await readCacheOwner(process.pid);
  assert.equal(identity.pid, process.pid);
  assert.match(identity.bootId, /^[0-9a-f-]{36}$/);
  assert.match(identity.startTicks, /^\d+$/);
  assert.equal(await cacheOwnerMatches(identity), true);
  assert.equal(await cacheOwnerMatches({ ...identity, startTicks: `${identity.startTicks}0` }), false);
  assert.equal(await cacheOwnerMatches({ ...identity, bootId: boot }), identity.bootId === boot);
});

test("owner stat parsing preserves process-name boundaries; wrong identity refuses", async () => {
  const root = await fixture();
  const owner = await readCacheOwner(123, root);
  assert.deepEqual(owner, { pid: 123, bootId: boot, startTicks: "987" });
  assert.equal(await cacheOwnerMatches({ ...owner, startTicks: "988" }, root), false);
  assert.equal(await cacheOwnerMatches({ ...owner, pid: 124 }, root), false);
});

test("dead owner, malformed proc state and unsafe PID cannot start a coordinator", async () => {
  const root = await fixture("Z");
  await assert.rejects(readCacheOwner(123, root), /owner.*not alive/);
  await writeFile(join(root, "123/stat"), "broken");
  await assert.rejects(readCacheOwner(123, root), /owner.*stat/);
  await assert.rejects(readCacheOwner(-1, root), /owner.*PID/);
  await writeFile(join(root, "123/stat"), `123 (x) S ${Array(18).fill("0").join(" ")} 987`);
  await writeFile(join(root, "sys/kernel/random/boot_id"), "not a boot id");
  await assert.rejects(readCacheOwner(123, root), /owner.*boot/);
});

test("termination evidence distinguishes death/replacement from failed observation", async () => {
  const root = await fixture(),
    owner = await readCacheOwner(123, root);
  assert.equal(await cacheProcessTerminated(owner, root), false);
  assert.equal(await cacheProcessTerminated({ ...owner, startTicks: "988" }, root), true);
  assert.equal(await cacheProcessTerminated({ ...owner, pid: 124 }, root), true);
  await writeFile(join(root, "123/stat"), "malformed live-process observation");
  await assert.rejects(cacheProcessTerminated(owner, root), /stat.*malformed/);
  await writeFile(join(root, "123/stat"), `123 (x) ? ${Array(18).fill("0").join(" ")} 987`);
  await assert.rejects(cacheProcessTerminated(owner, root), /unknown process state/);
  await writeFile(join(root, "123/stat"), `123 (x) Z ${Array(18).fill("0").join(" ")} 987`);
  assert.equal(await cacheProcessTerminated(owner, root), true);
});

test("observation failure for this known-live process is not successful termination", async () => {
  const owner = await readCacheOwner(process.pid),
    root = await tempDir("cache-live-observation");
  await mkdir(join(root, "sys/kernel/random"), { recursive: true });
  await writeFile(join(root, "sys/kernel/random/boot_id"), owner.bootId);
  await mkdir(join(root, String(process.pid), "stat"), { recursive: true });
  await assert.rejects(cacheProcessTerminated(owner, root), /not-a-regular-file/);
  assert.equal(await cacheProcessTerminated(owner), false);
});

test("owner checks propagate exact descriptor cleanup errors, not denial or process absence", async () => {
  const root = await fixture(),
    owner = await readCacheOwner(123, root);
  for (const check of [
    readCacheOwner.bind(null, owner.pid),
    cacheOwnerMatches.bind(null, owner),
    cacheProcessTerminated.bind(null, owner),
  ]) {
    let handle: FileHandle | undefined,
      failure: BoundedReadCleanupError | undefined,
      refusing = true;
    const closeCause = Object.assign(new Error("close reports ENOENT"), { code: "ENOENT" });
    const read: typeof readBoundedFile = async (path, limits) => {
      try {
        return await readBoundedFile(path, limits, {
          async open(name, flags) {
            handle = await open(name, flags);
            return handle;
          },
          read: (fd, buffer, offset, length, position) => fd.read(buffer, offset, length, position),
          async close(fd) {
            if (refusing && path.endsWith("/stat")) throw closeCause;
            await fd.close();
          },
        });
      } catch (error) {
        assert.ok(error instanceof BoundedReadCleanupError);
        failure = error;
        // Error identity/type is authoritative; wording must never turn failed cleanup into a denial.
        error.message = "cache owner cleanup failed";
        throw error;
      }
    };
    try {
      await assert.rejects(check(root, read), (error) => error === failure && error instanceof BoundedReadCleanupError);
      assert.ok(failure);
      assert.equal(failure.cause, closeCause);
      assert.ok(handle);
      assert.ok((await handle.stat()).isFile());
      refusing = false;
      await failure.cleanup();
      assert.equal(handle.fd, -1);
    } finally {
      refusing = false;
      if (failure) await failure.cleanup();
      else if (handle && handle.fd !== -1) await handle.close();
    }
  }
  assert.equal(await cacheOwnerMatches({ ...owner, pid: 124 }, root), false);
  assert.equal(
    await cacheProcessTerminated({ ...owner, pid: 124 }, root),
    true,
    "actual typed absence still certifies disappearance",
  );
  const unknown = { unrelated: "failure" };
  await assert.rejects(
    cacheOwnerMatches(owner, root, async () => {
      throw unknown;
    }),
    (error) => error === unknown,
  );
});

test("unreadable or over-bound proc observations cannot prove termination", async () => {
  const root = await fixture(),
    owner = await readCacheOwner(123, root);
  await mkdir(join(root, "125/stat"), { recursive: true });
  await assert.rejects(cacheProcessTerminated({ ...owner, pid: 125 }, root), /not-a-regular-file/);
  await writeFile(join(root, "123/stat"), "x".repeat(8193));
  await assert.rejects(cacheProcessTerminated(owner, root), /too-large/);
  await writeFile(join(root, "123/stat"), `123 (x) S ${Array(18).fill("0").join(" ")} 987`);
  await writeFile(join(root, "sys/kernel/random/boot_id"), "bad-boot");
  await assert.rejects(cacheProcessTerminated(owner, root), /boot.*malformed/);
});
