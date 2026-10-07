/** Actual first-missing binding coverage. Fixed watches detect creations through aliases;
 * tickets and drain remain processed observations, not a current coherent cut or eligibility.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, statfs, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import {
  acquireOwnedPaths,
  PathAcquisitionCleanupError,
  type OwnedPathObservations,
} from "../src/executors/cache-path-acquisition.ts";
import { readHeldSymlink } from "../src/executors/cache-held-symlink.ts";
import { startInodeObserver } from "../src/executors/cache-inode-observer.ts";
import { cacheProcessTerminated, readCacheOwner, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { tempDir, cleanupTempDirs as removeTempDirs } from "../test/tmp.ts";
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
let unresolved = 0;
const known: CacheOwnerIdentity[] = [],
  failedOwners = new Set<PathAcquisitionCleanupError>();
async function cleanupTempDirs() {
  assert.equal(unresolved, 0, "absence observation ownership unresolved; retain fixtures");
  for (const owner of failedOwners) {
    await owner.cleanup();
    failedOwners.delete(owner);
  }
  for (const owner of known)
    assert.equal(await cacheProcessTerminated(owner), true, "retain absence coverage evidence");
  await removeTempDirs();
}
after(cleanupTempDirs);
async function leaf(name: string) {
  const root = await tempDir("absence-leaf-"),
    binary = join(root, "leaf");
  await promisify(execFile)("cc", [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    new URL(`../src/executors/native/${name}.c`, import.meta.url).pathname,
    "-o",
    binary,
  ]);
  return {
    binary,
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
  };
}
async function release(owner: OwnedPathObservations) {
  try {
    await owner.release();
  } catch (error) {
    if (error instanceof PathAcquisitionCleanupError) failedOwners.add(error);
    throw error;
  }
}
for (const filesystem of ["tmpfs", "ext4"])
  test(
    `fixed missing-binding parents observe alias creation/undo on actual ${filesystem}`,
    { skip: !enabled },
    async (t) => {
      const root = await tempDir(
          "absence-real-",
          filesystem === "ext4" ? new URL("../../../", import.meta.url).pathname : undefined,
        ),
        alias = join(root, "alias"),
        actual = join(root, "actual");
      assert.equal(
        (await statfs(root)).type,
        filesystem === "ext4" ? 0xef53 : 0x01021994,
        "fixture filesystem must match its claim",
      );
      await mkdir(actual);
      await symlink("actual", alias);
      await symlink("target.conf", join(actual, "dangling"));
      const reader = await leaf("cache-held-symlink"),
        watcher = await leaf("cache-inode");
      const request = {
        cwd: root,
        paths: ["alias/configuration", "alias/missing-parent/child", "alias/dangling"],
        observeMissing: true,
        limits: { maxPaths: 64, maxObjects: 128, maxComponents: 512, maxSymlinks: 40, timeoutMs: 3000 },
        readLink: (input: { fd: number; dev: bigint; ino: bigint }) =>
          readHeldSymlink({ ...reader, input, maxTargetBytes: 4096 }),
      };
      let candidate: OwnedPathObservations | undefined,
        recaptured: OwnedPathObservations | undefined,
        observer: Awaited<ReturnType<typeof startInodeObserver>> | undefined,
        identity: CacheOwnerIdentity | undefined;
      try {
        const discovered = await acquireOwnedPaths(request);
        if (discovered.kind !== "observed") assert.fail(discovered.reason);
        candidate = discovered.owner;
        assert.equal(candidate.absences.length, 3);
        assert.equal(candidate.endpoints.length, 0);
        const owner = await readCacheOwner(process.pid),
          objects = await Promise.all(
            candidate.objects.map(async (o) => ({
              fd: o.fd,
              info: await stat(`/proc/self/fd/${o.fd}`, { bigint: true }),
            })),
          );
        unresolved++;
        observer = await startInodeObserver({ ...watcher, owner, objects });
        identity = await readCacheOwner(observer.pid);
        known.push(identity);
        const ticket = observer.ticket(candidate.absences.map((a) => a.parent));
        const again = await acquireOwnedPaths(request);
        if (again.kind !== "observed") assert.fail(again.reason);
        recaptured = again.owner;
        assert.deepEqual(recaptured.absences, candidate.absences);
        assert.deepEqual(recaptured.edges, candidate.edges);
        await observer.drain();
        assert.equal(observer.observationsUnchanged(ticket), true);
        await writeFile(join(actual, "configuration"), "created through non-invocation alias");
        await observer.drain();
        assert.equal(observer.observationsUnchanged(ticket), false);
        await unlink(join(actual, "configuration"));
        await observer.drain();
        assert.equal(observer.observationsUnchanged(ticket), false, "restoring absence never revives a ticket");
        const intermediate = observer.ticket([candidate.absences[1].parent]);
        await mkdir(join(actual, "missing-parent"));
        await observer.drain();
        assert.equal(
          observer.observationsUnchanged(intermediate),
          false,
          "first missing ancestor needs new resolution/coverage",
        );
        const dangling = observer.ticket([candidate.absences[2].parent]);
        await writeFile(join(actual, "target.conf"), "formerly dangling");
        await observer.drain();
        assert.equal(observer.observationsUnchanged(dangling), false);
        t.diagnostic(
          JSON.stringify({
            filesystem,
            absences: candidate.absences.length,
            objects: candidate.objects.length,
            scope: "first ENOENT bindings plus fixed parent events; not coherent/current access or eligible execution",
          }),
        );
      } catch (error) {
        if (error instanceof PathAcquisitionCleanupError) failedOwners.add(error);
        throw error;
      } finally {
        if (observer) {
          await observer.stop();
          assert.ok(identity);
          assert.equal(await cacheProcessTerminated(identity), true);
          unresolved--;
        }
        if (recaptured) await release(recaptured);
        if (candidate) await release(candidate);
      }
    },
  );
