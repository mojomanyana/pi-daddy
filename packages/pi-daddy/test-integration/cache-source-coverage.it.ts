/** Owned path discovery -> fixed observation -> recapture -> guarded bytes.
 * This is an actual bounded COVERAGE pipeline, not coherent/current source or eligibility.
 * Name/stat equality + drained observations do NOT establish a common cut/in-flight ordering.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { promisify } from "node:util";
import {
  acquireOwnedPaths,
  PathAcquisitionCleanupError,
  type OwnedPathObservations,
} from "../src/executors/cache-path-acquisition.ts";
import { readHeldSymlink } from "../src/executors/cache-held-symlink.ts";
import { startInodeObserver } from "../src/executors/cache-inode-observer.ts";
import {
  captureByteVector,
  ByteCaptureCleanupError,
  type CapturedByteVector,
} from "../src/executors/cache-byte-capture.ts";
import { startCacheLeaseBridge } from "../src/executors/cache-lease-bridge.ts";
import { parseChecksumMembers } from "../src/kernel/cache-checksum-members.ts";
import { readCacheOwner, cacheProcessTerminated, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { tempDir, cleanupTempDirs as removeTempDirs } from "../test/tmp.ts";
const enabled = process.env.PI_DADDY_IT_CACHE === "1" && process.env.PI_DADDY_IT_CACHE_PRIVILEGED === "1";
let unresolved = 0;
const known: CacheOwnerIdentity[] = [],
  failedOwners = new Set<PathAcquisitionCleanupError | ByteCaptureCleanupError>();
async function cleanupTempDirs() {
  assert.equal(unresolved, 0, "source coverage ownership unresolved; retain fixtures");
  for (const failure of failedOwners) {
    await failure.cleanup();
    failedOwners.delete(failure);
  }
  for (const identity of known)
    assert.equal(await cacheProcessTerminated(identity), true, "retain source coverage evidence");
  await removeTempDirs();
}
after(cleanupTempDirs);
async function leaf(name: string) {
  const root = await tempDir("source-coverage-leaf-"),
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
async function release(paths: OwnedPathObservations) {
  try {
    await paths.release();
  } catch (error) {
    if (error instanceof PathAcquisitionCleanupError) failedOwners.add(error);
    throw error;
  }
}
test(
  "all meaningful owned resolution objects including symlinks arm BEFORE recapture and guarded byte acquisition",
  { skip: !enabled },
  async (t) => {
    const heldReader = await leaf("cache-held-symlink"),
      watcher = await leaf("cache-inode"),
      repo = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
    const manifestPath = ".principal/plans/cache-command-inputs.sha256",
      preliminary = await readFile(join(repo, manifestPath));
    const declared = parseChecksumMembers(preliminary, { maxBytes: 1024 * 1024, maxMembers: 64 });
    if (declared.kind !== "members") assert.fail(declared.reason);
    const paths = [
      manifestPath,
      ...declared.members.map((m) => m.path),
      "/bin/bash",
      "/usr/bin/gnusha256sum",
      "/lib64/ld-linux-x86-64.so.2",
      "/usr/lib/x86_64-linux-gnu/libc.so.6",
      "/usr/lib/x86_64-linux-gnu/libcrypto.so.3",
      "/usr/lib/x86_64-linux-gnu/libtinfo.so.6",
      "/usr/lib/x86_64-linux-gnu/libz.so.1",
      "/usr/lib/x86_64-linux-gnu/libzstd.so.1",
      "/etc/ld.so.cache",
      "/etc/ld.so.preload",
    ];
    const request = {
      cwd: repo,
      paths,
      observeMissing: true,
      limits: { maxPaths: 64, maxObjects: 128, maxComponents: 512, maxSymlinks: 40, timeoutMs: 3000 },
      readLink: (input: { fd: number; dev: bigint; ino: bigint }) =>
        readHeldSymlink({ ...heldReader, input, maxTargetBytes: 4096 }),
    };
    let candidate: OwnedPathObservations | undefined,
      recaptured: OwnedPathObservations | undefined,
      bytes: CapturedByteVector | undefined;
    let observer: Awaited<ReturnType<typeof startInodeObserver>> | undefined,
      bridge: Awaited<ReturnType<typeof startCacheLeaseBridge>> | undefined;
    let observationOwner: CacheOwnerIdentity | undefined, byteOwner: CacheOwnerIdentity | undefined;
    try {
      const discovered = await acquireOwnedPaths(request);
      if (discovered.kind !== "observed") assert.fail(discovered.reason);
      candidate = discovered.owner;
      assert.equal(candidate.absences.length, 1, "fixture requires the observed absent loader configuration");
      assert.equal(candidate.absences[0].path, "/etc/ld.so.preload");
      assert.equal(candidate.absences[0].name, "ld.so.preload");
      assert.deepEqual(candidate.absences[0].remaining, []);
      for (const library of ["libtinfo.so.6", "libz.so.1", "libzstd.so.1"])
        assert.ok(candidate.endpoints.some((endpoint) => endpoint.path.endsWith(`/${library}`)));
      const objects = await Promise.all(
        candidate.objects.map(async (object) => ({
          fd: object.fd,
          info: await stat(`/proc/self/fd/${object.fd}`, { bigint: true }),
        })),
      );
      const parent = await readCacheOwner(process.pid);
      unresolved++;
      observer = await startInodeObserver({ ...watcher, owner: parent, objects });
      observationOwner = await readCacheOwner(observer.pid);
      known.push(observationOwner);
      const manifest = observer.manifest();
      assert.equal(manifest.length, candidate.objects.length);
      for (let index = 0; index < manifest.length; index++) {
        assert.equal(manifest[index].kind, candidate.objects[index].kind);
        assert.equal(
          `${manifest[index].dev}:${manifest[index].ino}`,
          `${candidate.objects[index].dev}:${candidate.objects[index].ino}`,
        );
      }
      const ticket = observer.ticket(manifest.map((entry) => entry.index));
      // Initial pre-arm discovery is not silently trusted as the captured name/metadata baseline.
      const again = await acquireOwnedPaths(request);
      if (again.kind !== "observed") assert.fail(again.reason);
      recaptured = again.owner;
      const sampled = (owned: OwnedPathObservations) => owned.objects.map(({ fd: _, ...fields }) => fields);
      assert.deepEqual(sampled(recaptured), sampled(candidate));
      assert.deepEqual(recaptured.edges, candidate.edges);
      assert.deepEqual(recaptured.endpoints, candidate.endpoints);
      assert.deepEqual(recaptured.absences, candidate.absences);
      const leaseManifest = JSON.parse(
        await readFile(new URL("../dist/executors/native/cache-lease.json", import.meta.url), "utf8"),
      );
      unresolved++;
      bridge = await startCacheLeaseBridge({
        binary: process.env.PI_DADDY_IT_CACHE_LEASE_BINARY!,
        binarySha256: leaseManifest.sha256,
        owner: parent,
        peer: parent,
        requirePrivilege: true,
        onLoss: () => {},
      });
      byteOwner = await readCacheOwner(bridge.pid);
      known.push(byteOwner);
      const acquired = await captureByteVector({
        inputs: recaptured.endpoints.map((e) => recaptured!.objects[e.object]),
        leases: bridge,
        limits: { maxFiles: 64, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
      });
      if (acquired.kind !== "captured") assert.fail(acquired.reason);
      bytes = acquired.capture;
      assert.deepEqual(bytes.copyCapturedBytes(0), preliminary);
      for (let index = 0; index < declared.members.length; index++)
        assert.equal(bytes.items[index + 1].sha256, declared.members[index].sha256);
      await observer.drain();
      t.diagnostic(
        JSON.stringify({
          objects: manifest.length,
          symlinkObjects: manifest.filter((entry) => entry.kind === "symlink").length,
          physicalWatches: new Set(manifest.map((entry) => entry.wd)).size,
          byteEndpoints: bytes.items.length,
          absentBindings: candidate.absences.length,
          capturedBytes: bytes.items.reduce((n, item) => n + item.size, 0),
          processedObservationsUnchanged: observer.observationsUnchanged(ticket),
          scope:
            "armed positive paths and first-missing loader-config binding before recapture/guarded bytes; NOT current common cut, access/ACL or complete runtime/config closure or execution correspondence",
        }),
      );
    } catch (error) {
      if (error instanceof PathAcquisitionCleanupError || error instanceof ByteCaptureCleanupError)
        failedOwners.add(error);
      throw error;
    } finally {
      if (bytes) await bytes.release();
      if (bridge) {
        await bridge.stop();
        assert.ok(byteOwner);
        assert.equal(await cacheProcessTerminated(byteOwner), true);
        unresolved--;
      }
      if (observer) {
        await observer.stop();
        assert.ok(observationOwner);
        assert.equal(await cacheProcessTerminated(observationOwner), true);
        unresolved--;
      }
      if (recaptured) await release(recaptured);
      if (candidate) await release(candidate);
    }
  },
);
