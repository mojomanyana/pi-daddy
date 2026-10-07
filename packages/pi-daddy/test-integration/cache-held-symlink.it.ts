/** Actual unprivileged symlink pins. No pathname coherence/current validation certificate. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, rename, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { readHeldSymlink } from "../src/executors/cache-held-symlink.ts";
import { startLeaseProcess } from "../src/executors/cache-lease-process.ts";
import { readCacheOwner, cacheProcessTerminated, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { tempDir, cleanupTempDirs as removeTempDirs } from "../test/tmp.ts";
import { acquireOwnedPaths, PathAcquisitionCleanupError } from "../src/executors/cache-path-acquisition.ts";
import {
  captureByteVector,
  ByteCaptureCleanupError,
  type CapturedByteVector,
} from "../src/executors/cache-byte-capture.ts";
import { startCacheLeaseBridge } from "../src/executors/cache-lease-bridge.ts";
import { parseChecksumMembers } from "../src/kernel/cache-checksum-members.ts";
import { fileURLToPath } from "node:url";
const enabled = process.env.PI_DADDY_IT_CACHE === "1",
  O_PATH = 0x200000;
let binary: string,
  sha256: string,
  unresolved = 0;
const known: CacheOwnerIdentity[] = [];
const failedOwners = new Set<PathAcquisitionCleanupError | ByteCaptureCleanupError>();
before(async () => {
  if (!enabled) return;
  assert.equal(process.getuid!() > 0, true, "actual symlink qualification caller must be nonroot");
  const root = await tempDir("held-link-native-");
  binary = join(root, "leaf");
  await promisify(execFile)("cc", [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    new URL("../src/executors/native/cache-held-symlink.c", import.meta.url).pathname,
    "-o",
    binary,
  ]);
  sha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
});
async function cleanupTempDirs() {
  assert.equal(unresolved, 0, "held symlink startup/cleanup unresolved; retain fixtures");
  for (const error of failedOwners) {
    await error.cleanup();
    failedOwners.delete(error);
  }
  for (const identity of known)
    assert.equal(await cacheProcessTerminated(identity), true, "retain unresolved held symlink evidence");
  await removeTempDirs();
}
after(cleanupTempDirs);
async function fixture(target: string | Buffer = "original") {
  const root = await tempDir("held-link-real-"),
    path = join(root, "link");
  await symlink(target, path);
  const file = await open(path, O_PATH | constants.O_NOFOLLOW);
  const info = await file.stat({ bigint: true });
  return { root, path, file, input: { fd: file.fd, dev: info.dev, ino: info.ino } };
}
async function raw(input: { fd: number; dev: bigint; ino: bigint }, max = 4096) {
  unresolved++;
  const handle = await startLeaseProcess(
    binary,
    sha256,
    [String(process.pid), String(input.fd), String(input.dev), String(input.ino), String(max)],
    false,
  );
  let text = "",
    diagnostics = "",
    position = 0;
  const closed = new Promise<void>((resolve) => handle.child.once("close", () => resolve()));
  handle.child.stdout!.on("data", (b: Buffer) => {
    text += b.toString();
  });
  handle.child.stderr!.on("data", (b: Buffer) => {
    diagnostics += b.toString();
  });
  async function line() {
    const until = performance.now() + 1500;
    for (;;) {
      const end = text.indexOf("\n", position);
      if (end >= 0) {
        const result = text.slice(position, end);
        position = end + 1;
        return result;
      }
      assert.ok(performance.now() < until, `held link frame unresolved ${diagnostics}`);
      assert.ok(text.length < 10_000, "held link raw output exceeds bound");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  assert.equal(await line(), "S1 READY");
  const owner = await readCacheOwner(handle.child.pid!);
  known.push(owner);
  return {
    handle,
    owner,
    line,
    send(command: "P" | "R") {
      handle.child.stdin!.write(`${command}\n`);
    },
    async stop() {
      await handle.stop();
      await closed;
      assert.equal(await cacheProcessTerminated(owner), true);
      unresolved--;
    },
  };
}
test(
  "held symlink target remains original through pathname replacement/restoration and borrowed FD closure",
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      leaf = await raw(f.input);
    try {
      leaf.send("P");
      assert.equal(await leaf.line(), "S1 PINNED");
      const status = await readFile(`/proc/${leaf.owner.pid}/status`, "utf8");
      for (const field of ["CapEff", "CapPrm", "CapInh", "CapAmb"])
        assert.match(status, new RegExp(`^${field}:\\s+0+$`, "m"));
      assert.match(status, /^NoNewPrivs:\s+1$/m);
      assert.match(status, /^Seccomp:\s+2$/m);
      await f.file.close();
      await rename(f.path, join(f.root, "saved"));
      await symlink("replacement", f.path);
      leaf.send("R");
      assert.equal(
        await leaf.line(),
        `S1 LINK ${f.input.dev} ${f.input.ino} ${Buffer.from("original").toString("hex")}`,
      );
      await unlink(f.path);
      await rename(join(f.root, "saved"), f.path);
    } finally {
      await leaf.stop();
      await f.file.close();
    }
  },
);
test("real numeric borrowed FD reuse refuses the changed inode, not its target", { skip: !enabled }, async () => {
  const f = await fixture(),
    g = await fixture("other"),
    leaf = await raw(f.input);
  let replacement: FileHandle | undefined;
  try {
    await g.file.close();
    await f.file.close();
    replacement = await open(g.path, O_PATH | constants.O_NOFOLLOW);
    assert.equal(replacement.fd, f.input.fd, "control actually reuses numeric FD");
    leaf.send("P");
    assert.match(await leaf.line(), /^S1 F IDENTITY 0$/);
  } finally {
    await leaf.stop();
    await f.file.close();
    await g.file.close();
    if (replacement) await replacement.close();
  }
});
test(
  "actual wrapper preserves non-UTF8 target bytes and detects byte limit truncation",
  { skip: !enabled },
  async () => {
    const target = Buffer.from([46, 47, 255, 254]),
      f = await fixture(target);
    try {
      assert.deepEqual(await readHeldSymlink({ binary, sha256, input: f.input, maxTargetBytes: 4 }), target);
      await assert.rejects(
        readHeldSymlink({ binary, sha256, input: f.input, maxTargetBytes: 3 }),
        /native refusal: TARGET_LIMIT/,
      );
    } finally {
      await f.file.close();
    }
  },
);
test(
  "ordinary regular files refuse instead of becoming symlink targets; explicit runtime symlinks admit",
  { skip: !enabled },
  async () => {
    const root = await tempDir("held-link-regular-"),
      path = join(root, "regular");
    await writeFile(path, "data");
    const file = await open(path, O_PATH);
    try {
      const st = await file.stat({ bigint: true });
      await assert.rejects(
        readHeldSymlink({ binary, sha256, input: { fd: file.fd, dev: st.dev, ino: st.ino }, maxTargetBytes: 32 }),
        /native refusal: IDENTITY/,
      );
    } finally {
      await file.close();
    }
    const magic = await open("/proc/self/exe", O_PATH | constants.O_NOFOLLOW);
    try {
      const st = await magic.stat({ bigint: true });
      await assert.rejects(
        readHeldSymlink({ binary, sha256, input: { fd: magic.fd, dev: st.dev, ino: st.ino }, maxTargetBytes: 4096 }),
        /native refusal: FILESYSTEM/,
      );
    } finally {
      await magic.close();
    }
    for (const path of ["/bin", "/usr/bin/cc"]) {
      const link = await open(path, O_PATH | constants.O_NOFOLLOW);
      try {
        const st = await link.stat({ bigint: true });
        assert.equal(st.isSymbolicLink(), true);
        assert.ok(
          (
            await readHeldSymlink({
              binary,
              sha256,
              input: { fd: link.fd, dev: st.dev, ino: st.ino },
              maxTargetBytes: 4096,
            })
          ).length > 0,
        );
      } finally {
        await link.close();
      }
    }
  },
);
test("helper SIGKILL after pin is actual known death before fixtures are removed", { skip: !enabled }, async () => {
  const f = await fixture(),
    leaf = await raw(f.input);
  try {
    leaf.send("P");
    assert.equal(await leaf.line(), "S1 PINNED");
    process.kill(leaf.owner.pid, "SIGKILL");
    await leaf.handle.stopped;
    assert.equal(await cacheProcessTerminated(leaf.owner), true);
  } finally {
    await leaf.stop();
    await f.file.close();
  }
});

test(
  "owned relative/absolute/parent symlink expansion preserves endpoints; loop budget refuses",
  { skip: !enabled },
  async () => {
    const root = await tempDir("owned-link-resolution-");
    await writeFile(join(root, "file"), "data");
    await symlink("file", join(root, "relative"));
    await symlink(join(root, "file"), join(root, "absolute"));
    await symlink("../" + root.split("/").pop() + "/file", join(root, "parent"));
    await symlink("loop", join(root, "loop"));
    const readLink = (input: { fd: number; dev: bigint; ino: bigint }) =>
      readHeldSymlink({ binary, sha256, input, maxTargetBytes: 4096 });
    const limits = { maxPaths: 64, maxObjects: 128, maxComponents: 512, maxSymlinks: 40, timeoutMs: 3000 };
    const result = await acquireOwnedPaths({ cwd: root, paths: ["relative", "absolute", "parent"], limits, readLink });
    if (result.kind !== "observed") assert.fail(result.reason);
    try {
      assert.equal(
        new Set(
          result.owner.endpoints.map((e) => {
            const object = result.owner.objects[e.object];
            return `${object.dev}:${object.ino}`;
          }),
        ).size,
        1,
      );
      assert.equal(new Set(result.owner.endpoints.map((e) => result.owner.objects[e.object].fd)).size, 3);
      assert.equal(result.owner.objects.filter((o) => o.kind === "symlink").length, 3);
    } finally {
      await result.owner.release();
    }
    const refused = await acquireOwnedPaths({ cwd: root, paths: ["loop"], limits, readLink });
    assert.equal(refused.kind, "bypass");
    if (refused.kind === "bypass") assert.match(refused.reason, /maxSymlinks/);
  },
);

test(
  "actual useful manifest/runtime resolution including /bin and compiler aliases feeds guarded byte capture",
  { skip: !enabled || process.env.PI_DADDY_IT_CACHE_PRIVILEGED !== "1" },
  async (t) => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, ""),
      manifestPath = ".principal/plans/cache-command-inputs.sha256";
    const preliminary = await readFile(join(repo, manifestPath)),
      declared = parseChecksumMembers(preliminary, { maxBytes: 1024 * 1024, maxMembers: 64 });
    if (declared.kind !== "members") assert.fail(declared.reason);
    const paths = [
      manifestPath,
      ...declared.members.map((m) => m.path),
      "/bin/bash",
      "/usr/bin/gnusha256sum",
      "/lib64/ld-linux-x86-64.so.2",
      "/usr/lib/x86_64-linux-gnu/libc.so.6",
      "/usr/lib/x86_64-linux-gnu/libcrypto.so.3",
      "/etc/ld.so.cache",
    ];
    let acquisitions: Awaited<ReturnType<typeof acquireOwnedPaths>> | undefined,
      bytes: CapturedByteVector | undefined,
      lease: Awaited<ReturnType<typeof startCacheLeaseBridge>> | undefined,
      owner: CacheOwnerIdentity | undefined;
    try {
      acquisitions = await acquireOwnedPaths({
        cwd: repo,
        paths,
        limits: { maxPaths: 64, maxObjects: 128, maxComponents: 512, maxSymlinks: 40, timeoutMs: 3000 },
        readLink: (input) => readHeldSymlink({ binary, sha256, input, maxTargetBytes: 4096 }),
      });
      if (acquisitions.kind !== "observed") assert.fail(acquisitions.reason);
      const metadata = JSON.parse(
        await readFile(new URL("../dist/executors/native/cache-lease.json", import.meta.url), "utf8"),
      );
      unresolved++;
      const parent = await readCacheOwner(process.pid);
      lease = await startCacheLeaseBridge({
        binary: process.env.PI_DADDY_IT_CACHE_LEASE_BINARY!,
        binarySha256: metadata.sha256,
        owner: parent,
        peer: parent,
        requirePrivilege: true,
        onLoss: () => {},
      });
      owner = await readCacheOwner(lease.pid);
      known.push(owner);
      const captured = await captureByteVector({
        inputs: acquisitions.owner.endpoints.map((e) =>
          acquisitions!.kind === "observed" ? acquisitions!.owner.objects[e.object] : assert.fail("lost path owner"),
        ),
        leases: lease,
        limits: { maxFiles: 64, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
      });
      if (captured.kind !== "captured") assert.fail(captured.reason);
      bytes = captured.capture;
      assert.deepEqual(bytes.copyCapturedBytes(0), preliminary);
      for (let i = 0; i < declared.members.length; i++)
        assert.equal(bytes.items[i + 1].sha256, declared.members[i].sha256);
      assert.ok(acquisitions.owner.objects.some((o) => o.kind === "symlink"));
      t.diagnostic(
        JSON.stringify({
          endpoints: bytes.items.length,
          resolutionObjects: acquisitions.owner.objects.length,
          resolutionEdges: acquisitions.owner.edges.length,
          symlinks: acquisitions.owner.objects.filter((o) => o.kind === "symlink").length,
          capturedBytes: bytes.items.reduce((n, item) => n + item.size, 0),
          scope: "owned resolution observations plus past bytes; NOT coherent/current name/access/ACL/namespace proof",
        }),
      );
    } catch (error) {
      if (error instanceof PathAcquisitionCleanupError || error instanceof ByteCaptureCleanupError)
        failedOwners.add(error);
      throw error;
    } finally {
      if (bytes) await bytes.release();
      if (lease) {
        await lease.stop();
        assert.ok(owner);
        assert.equal(await cacheProcessTerminated(owner), true);
        unresolved--;
      }
      if (acquisitions?.kind === "observed") {
        try {
          await acquisitions.owner.release();
        } catch (error) {
          if (error instanceof PathAcquisitionCleanupError) failedOwners.add(error);
          throw error;
        }
      }
    }
  },
);

test(
  "actual spawning-owner SIGKILL terminates admitted native leaf before fixture deletion",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    unresolved++;
    const child = spawn(
      process.execPath,
      [new URL("cache-held-symlink-owner.mjs", import.meta.url).pathname, binary, sha256, f.path],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let parent: CacheOwnerIdentity | undefined, peer: CacheOwnerIdentity | undefined, timer: NodeJS.Timeout | undefined;
    try {
      parent = await readCacheOwner(child.pid!);
      known.push(parent);
      const packet = await new Promise<{ owner: CacheOwnerIdentity; leaf: CacheOwnerIdentity }>((resolve, reject) => {
        let text = "";
        timer = setTimeout(() => reject(new Error("held symlink owner startup unresolved; retain evidence")), 3000);
        child.stdout!.on("data", (b: Buffer) => {
          text += b.toString();
          if (text.length > 2048) {
            reject(new Error("owner fixture output bound"));
            return;
          }
          if (text.endsWith("\n")) {
            try {
              resolve(JSON.parse(text));
            } catch (error) {
              reject(error);
            }
          }
        });
        child.stderr!.on("data", (b: Buffer) => reject(new Error(`owner fixture diagnostic: ${b.toString()}`)));
        child.on("error", reject);
      });
      clearTimeout(timer);
      assert.deepEqual(packet.owner, parent);
      peer = await readCacheOwner(packet.leaf.pid);
      assert.deepEqual(peer, packet.leaf);
      known.push(peer);
      child.kill("SIGKILL");
      await closed;
      const deadline = performance.now() + 1500;
      while (!(await cacheProcessTerminated(peer)) && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(await cacheProcessTerminated(parent), true);
      assert.equal(await cacheProcessTerminated(peer), true);
      unresolved--;
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      let closeTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            closeTimer = setTimeout(() => reject(new Error("owner fixture cleanup unresolved; retain evidence")), 1500);
          }),
        ]);
      } finally {
        clearTimeout(closeTimer);
      }
      await f.file.close();
    }
  },
);
