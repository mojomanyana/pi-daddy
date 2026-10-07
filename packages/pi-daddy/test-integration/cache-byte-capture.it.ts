/** Opted-in actual approved guards. PAST byte capture, never pathname/current-cut/cache qualification. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fsPromises, { open, readFile, rename, writeFile, type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { after, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  captureByteVector,
  ByteCaptureCleanupError,
  type CapturedByteVector,
} from "../src/executors/cache-byte-capture.ts";
import { startCacheLeaseBridge } from "../src/executors/cache-lease-bridge.ts";
import { readCacheOwner, cacheProcessTerminated, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { parseChecksumMembers } from "../src/kernel/cache-checksum-members.ts";
import { tempDir, cleanupTempDirs as removeTempDirs } from "../test/tmp.ts";
const enabled = process.env.PI_DADDY_IT_CACHE_PRIVILEGED === "1";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const limits = { maxFiles: 64, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, timeoutMs: 10_000 };
let binary: string,
  binarySha256: string,
  unresolved = 0;
const known: CacheOwnerIdentity[] = [];
const failedCaptures = new Set<ByteCaptureCleanupError>();
before(async () => {
  if (!enabled) return;
  binary = process.env.PI_DADDY_IT_CACHE_LEASE_BINARY || "";
  assert.ok(binary, "PI_DADDY_IT_CACHE_LEASE_BINARY required; this test never installs or changes privilege");
  const manifest = JSON.parse(
    await readFile(new URL("../dist/executors/native/cache-lease.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.available, true);
  assert.equal(manifest.protocol, 2);
  binarySha256 = manifest.sha256;
});
async function cleanupTempDirs() {
  assert.equal(unresolved, 0, "byte capture ownership unresolved; retain evidence");
  for (const failure of failedCaptures) {
    await failure.cleanup(); // A dead helper alone does not close an unresolved Node descriptor.
    failedCaptures.delete(failure);
  }
  for (const identity of known)
    assert.equal(await cacheProcessTerminated(identity), true, "retain unresolved capture evidence");
  await removeTempDirs();
}
after(cleanupTempDirs);
async function bridge() {
  unresolved++;
  const owner = await readCacheOwner(process.pid);
  const handle = await startCacheLeaseBridge({
    binary,
    binarySha256,
    owner,
    peer: owner,
    requirePrivilege: true,
    onLoss: () => {},
  });
  const identity = await readCacheOwner(handle.pid);
  known.push(identity);
  return {
    handle,
    identity,
    async stop() {
      await handle.stop();
      assert.equal(await cacheProcessTerminated(identity), true);
      const rows = (await readFile("/proc/locks", "utf8"))
        .split("\n")
        .filter((line) => line.trim().split(/\s+/)[4] === String(identity.pid));
      assert.deepEqual(rows, []);
      unresolved--;
    },
  };
}
async function spec(file: FileHandle) {
  const st = await file.stat({ bigint: true });
  return { fd: file.fd, dev: st.dev, ino: st.ino };
}
async function captured(files: FileHandle[], leaseSource: Awaited<ReturnType<typeof bridge>>) {
  try {
    const result = await captureByteVector({
      inputs: await Promise.all(files.map(spec)),
      leases: leaseSource.handle,
      limits,
    });
    if (result.kind !== "captured") assert.fail(result.reason);
    return result.capture;
  } catch (error) {
    if (error instanceof ByteCaptureCleanupError) failedCaptures.add(error);
    throw error;
  }
}
async function fixture() {
  const root = await tempDir("byte-capture-real-", repo),
    path = join(root, "source");
  await writeFile(path, "stable source bytes\n");
  return { root, path };
}
async function checkManifest(path: string, cwd: string) {
  // Test-only gate permits actual PID/start admission BEFORE execution. Same PID execs GNU.
  // Minimal synthetic env; no claim about arbitrary host shell settings or cache launch avoidance.
  unresolved++;
  const child = spawn(
    "/bin/bash",
    [
      "-c",
      'IFS= read -r gate <&3 || exit 85; [ "$gate" = GO ] || exit 86; exec 3<&-; exec /usr/bin/gnusha256sum --strict -c "$1"',
      "byte-capture-fixture",
      path,
    ],
    {
      cwd,
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "",
    failure: Error | undefined;
  child.stdout!.on("data", (b: Buffer) => {
    stdout += b.toString();
    if (Buffer.byteLength(stdout) > 64 * 1024) {
      failure = new Error("GNU fixture output exceeded bound");
      child.kill("SIGKILL");
    }
  });
  child.stderr!.on("data", (b: Buffer) => {
    stderr += b.toString();
    if (Buffer.byteLength(stderr) > 64 * 1024) {
      failure = new Error("GNU fixture diagnostic exceeded bound");
      child.kill("SIGKILL");
    }
  });
  child.on("error", (error) => {
    failure = error;
  });
  child.stdio[3]!.on("error", (error: Error) => {
    failure = error;
    child.kill("SIGKILL");
  });
  const closed = new Promise<number | null>((done) => child.once("close", (code) => done(code)));
  const timer = setTimeout(() => {
    failure = new Error("GNU fixture execution exceeded 3000ms");
    child.kill("SIGKILL");
  }, 3000);
  let owner: CacheOwnerIdentity | undefined;
  try {
    owner = await readCacheOwner(child.pid!);
    known.push(owner);
    (child.stdio[3] as import("node:stream").Duplex).end("GO\n");
    const code = await closed;
    assert.equal(await cacheProcessTerminated(owner), true);
    unresolved--;
    if (failure) throw failure;
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (!owner || !(await cacheProcessTerminated(owner))) {
      await killAndJoin(child, closed);
      assert.ok(owner, "GNU fixture identity unavailable; retain evidence");
      assert.equal(await cacheProcessTerminated(owner), true);
    }
  }
}
async function killAndJoin(child: ChildProcess, closed: Promise<unknown>) {
  child.kill("SIGKILL");
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("GNU fixture cleanup unresolved; retain evidence")), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "actual guarded manifest/member/runtime byte vector agrees with a fresh GNU integrity check",
  { skip: !enabled },
  async (t) => {
    const manifestPath = join(repo, ".principal/plans/cache-command-inputs.sha256");
    const preliminary = await readFile(manifestPath),
      declared = parseChecksumMembers(preliminary, { maxBytes: 1024 * 1024, maxMembers: 64 });
    if (declared.kind !== "members") assert.fail(declared.reason);
    const paths = [
      manifestPath,
      ...declared.members.map((m) => resolve(repo, m.path)),
      "/bin/bash",
      "/usr/bin/gnusha256sum",
      "/lib64/ld-linux-x86-64.so.2",
      "/usr/lib/x86_64-linux-gnu/libc.so.6",
      "/usr/lib/x86_64-linux-gnu/libcrypto.so.3",
      "/etc/ld.so.cache",
    ];
    const files: FileHandle[] = [];
    let owned: Awaited<ReturnType<typeof bridge>> | undefined, vector: CapturedByteVector | undefined;
    try {
      for (const path of paths) files.push(await open(path, "r"));
      owned = await bridge();
      vector = await captured(files, owned);
      assert.deepEqual(
        vector.copyCapturedBytes(0),
        preliminary,
        "preliminary names alone are not a guarded manifest parse",
      );
      for (let i = 0; i < declared.members.length; i++)
        assert.equal(vector.items[i + 1].sha256, declared.members[i].sha256);
      // Closing borrowed descriptors cannot destroy capture ownership or redirect later copies.
      for (const file of files) await file.close();
      const checked = await checkManifest(manifestPath, repo);
      assert.equal(checked.code, 0, checked.stderr);
      assert.equal(checked.stdout.split("\n").filter(Boolean).length, 14);
      assert.equal(await vector.guardsUnbroken(), true);
      t.diagnostic(
        JSON.stringify({
          objects: vector.items.length,
          capturedBytes: vector.items.reduce((sum, item) => sum + item.size, 0),
          actualUid: process.getuid!(),
          scope: "admitted byte set only; NOT complete runtime/namespace/current-source proof",
        }),
      );
    } finally {
      if (vector) await vector.release();
      if (owned) await owned.stop();
      for (const file of files) await file.close();
    }
  },
);

test(
  "preexisting writable descriptor prevents vector admission; a fresh capture can admit after it closes",
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      reader = await open(f.path, "r"),
      writer = await open(f.path, "r+");
    const owned = await bridge();
    let vector: CapturedByteVector | undefined;
    try {
      const refused = await captureByteVector({ inputs: [await spec(reader)], leases: owned.handle, limits });
      assert.equal(refused.kind, "bypass");
      if (refused.kind === "bypass") assert.match(refused.reason, /LEASE: 11/);
      await writer.close();
      vector = await captured([reader], owned);
      assert.equal(await vector.guardsUnbroken(), true);
    } finally {
      if (vector) await vector.release();
      await owned.stop();
      await reader.close();
      await writer.close();
    }
  },
);

test(
  "rename/replacement can change original GNU result while all captured byte guards remain unbroken",
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      file = await open(f.path, "r"),
      owned = await bridge();
    let vector: CapturedByteVector | undefined;
    try {
      vector = await captured([file], owned);
      await writeFile(join(f.root, "manifest"), `${vector.items[0].sha256}  source\n`);
      assert.equal((await checkManifest("manifest", f.root)).code, 0);
      await rename(f.path, join(f.root, "saved"));
      await writeFile(f.path, "replacement bytes\n");
      const replaced = await checkManifest("manifest", f.root);
      assert.equal(replaced.code, 1);
      assert.match(replaced.stdout, /FAILED/);
      assert.equal(await vector.guardsUnbroken(), true, "content capture is NOT name/current-source validation");
      assert.equal(vector.copyCapturedBytes(0).toString(), "stable source bytes\n");
    } finally {
      if (vector) await vector.release();
      await owned.stop();
      await file.close();
    }
  },
);

test(
  "failed acquisition cleanup keeps fixtures until the owned FD retry actually closes it",
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      reader = await open(f.path, "r"),
      writer = await open(f.path, "r+"),
      owned = await bridge();
    let privateFd = -1,
      refuseClose = true,
      stopped = false,
      error: ByteCaptureCleanupError | undefined;
    const originalOpen = fsPromises.open;
    const closers: { mock: { restore(): void } }[] = [];
    const spy = mock.method(fsPromises, "open", async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args),
        close = handle.close.bind(handle);
      closers.push(
        mock.method(handle, "close", () => {
          if (handle.fd === privateFd && refuseClose) throw new Error("controlled capture FD close refusal");
          return close();
        }),
      );
      return handle;
    });
    syncBuiltinESMExports();
    const observed = {
      ...owned,
      handle: {
        ...owned.handle,
        async acquire(fd: number, info: import("node:fs").BigIntStats) {
          privateFd = fd;
          return owned.handle.acquire(fd, info);
        },
      },
    };
    try {
      try {
        await captured([reader], observed);
      } catch (caught) {
        assert.ok(caught instanceof ByteCaptureCleanupError);
        error = caught;
      }
      assert.ok(error);
      await reader.close();
      await writer.close();
      await owned.stop();
      stopped = true;
      await assert.rejects(
        cleanupTempDirs(),
        /cleanup unresolved/,
        "failed owned FD cleanup must retain fixtures even after helper death",
      );
      assert.equal(await readFile(f.path, "utf8"), "stable source bytes\n");
    } finally {
      refuseClose = false;
      spy.mock.restore();
      syncBuiltinESMExports();
      for (const closer of closers) closer.mock.restore();
      if (error) await error.cleanup();
      if (!stopped) await owned.stop();
      await reader.close();
      await writer.close();
    }
  },
);

test(
  "actual writer break/restore and helper loss cannot resurrect a retired byte capture",
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      file = await open(f.path, "r"),
      owned = await bridge();
    let vector: CapturedByteVector | undefined;
    try {
      vector = await captured([file], owned);
      await writeFile(f.path, "changed\n");
      assert.equal(await vector.guardsUnbroken(), false);
      await writeFile(f.path, "stable source bytes\n");
      assert.equal(await vector.guardsUnbroken(), false);
      assert.throws(() => vector!.copyCapturedBytes(0), /retired/);
      await vector.release();
      vector = await captured([file], owned);
      process.kill(owned.identity.pid, "SIGKILL");
      await owned.handle.faulted;
      assert.equal(await vector.guardsUnbroken(), false);
      assert.throws(() => vector!.copyCapturedBytes(0), /retired/);
    } finally {
      if (vector) await vector.release();
      await owned.stop();
      await file.close();
    }
  },
);
