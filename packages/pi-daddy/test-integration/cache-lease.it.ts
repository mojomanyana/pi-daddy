/** Real Linux FD guard qualification. Capability installation is NEVER performed by these tests. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { open, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
import { startCacheLeaseBridge } from "../src/executors/cache-lease-bridge.ts";
import { tempDir, cleanupTempDirs } from "../test/tmp.ts";

const enabled = process.env.PI_DADDY_IT_CACHE === "1";
let binary: string, binarySha256: string;
before(async () => {
  if (!enabled) return;
  const dir = await tempDir("cache-lease-binary");
  binary = join(dir, "cache-lease");
  await promisify(execFile)("cc", [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    fileURLToPath(new URL("../src/executors/native/cache-lease.c", import.meta.url)),
    "-o",
    binary,
  ]);
  binarySha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
});
after(cleanupTempDirs);

test(
  "real readonly descriptor acquisition, validity and release; no Root capability assumed",
  { skip: !enabled },
  async () => {
    const root = await tempDir("cache-lease-input"),
      path = join(root, "input");
    await writeFile(path, "stable source");
    const input = await open(path, "r"),
      owner = await readCacheOwner(process.pid);
    const losses: string[] = [];
    const bridge = await startCacheLeaseBridge({
      binary,
      binarySha256,
      owner,
      peer: owner,
      onLoss: (_, reason) => losses.push(reason),
    });
    try {
      assert.equal(bridge.privileged, false);
      const result = await bridge.acquire(input.fd, await input.stat({ bigint: true }));
      if (!result.ok) assert.fail(result.reason);
      assert.equal(result.ok, true);
      assert.equal(await result.lease.check(), true);
      assert.equal(await input.readFile("utf8"), "stable source");
      await result.lease.release();
      assert.equal(await result.lease.check(), false);
      assert.deepEqual(losses, []);
    } finally {
      await bridge.stop();
      await input.close();
    }
  },
);

test(
  "already writable input and privileged runtime dependency explicitly refuse, not weak proof",
  { skip: !enabled },
  async () => {
    const root = await tempDir("cache-lease-refusal"),
      path = join(root, "input");
    await writeFile(path, "source");
    const writable = await open(path, "r+"),
      input = await open(path, "r"),
      owner = await readCacheOwner(process.pid);
    const bridge = await startCacheLeaseBridge({ binary, binarySha256, owner, peer: owner, onLoss: () => {} });
    try {
      const blocked = await bridge.acquire(input.fd, await input.stat({ bigint: true }));
      assert.equal(blocked.ok, false);
      if (blocked.ok) throw new Error("unexpected weak lease");
      assert.match(blocked.reason, /LEASE.*11/);
      const library = await open("/etc/passwd", "r");
      try {
        const info = await library.stat({ bigint: true });
        assert.equal(info.uid, 0n, "portable readable fixture must actually be root-owned");
        assert.ok(info.isFile());
        const unprivileged = await bridge.acquire(library.fd, info);
        assert.equal(unprivileged.ok, false);
        if (!unprivileged.ok) assert.match(unprivileged.reason, /CAPABILITY/);
      } finally {
        await library.close();
      }
    } finally {
      await bridge.stop();
      await input.close();
      await writable.close();
    }
  },
);

test(
  "writer break invalidates the incarnation before release and cannot regain validity",
  { skip: !enabled },
  async () => {
    const root = await tempDir("cache-lease-break"),
      path = join(root, "input");
    await writeFile(path, "initial");
    const input = await open(path, "r"),
      owner = await readCacheOwner(process.pid),
      losses: string[] = [];
    const bridge = await startCacheLeaseBridge({
      binary,
      binarySha256,
      owner,
      peer: owner,
      onLoss: (id) => {
        if (id) losses.push(id);
      },
    });
    try {
      const acquired = await bridge.acquire(input.fd, await input.stat({ bigint: true }));
      if (!acquired.ok) assert.fail(acquired.reason);
      const writer = promisify(execFile)(
        process.execPath,
        ["-e", `require('node:fs').writeFileSync(${JSON.stringify(path)},'changed')`],
        { timeout: 3000 },
      );
      const deadline = performance.now() + 2000;
      while (!losses.length && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.deepEqual(losses, [acquired.lease.id]);
      assert.equal(await acquired.lease.check(), false);
      await acquired.lease.release();
      await writer;
      assert.equal(await readFile(path, "utf8"), "changed");
      assert.equal(await acquired.lease.check(), false);
    } finally {
      await bridge.stop();
      await input.close();
    }
  },
);

test("automatic break loss permits writer completion without explicit release", { skip: !enabled }, async () => {
  const dir = await tempDir("cache-lease-auto-break"),
    path = join(dir, "input");
  await writeFile(path, "before");
  const input = await open(path, "r"),
    owner = await readCacheOwner(process.pid);
  const reasons: string[] = [];
  const bridge = await startCacheLeaseBridge({
    binary,
    binarySha256,
    owner,
    peer: owner,
    onLoss: (_, why) => reasons.push(why),
  });
  try {
    const result = await bridge.acquire(input.fd, await input.stat({ bigint: true }));
    if (!result.ok) assert.fail(result.reason);
    await promisify(execFile)(
      process.execPath,
      ["-e", `require('node:fs').writeFileSync(${JSON.stringify(path)},'after')`],
      { timeout: 3000 },
    );
    assert.ok(reasons.includes("content lease breaking"));
    assert.ok(reasons.includes("TIMEOUT: 0"));
    assert.equal(await result.lease.check(), false);
    await result.lease.release();
  } finally {
    await bridge.stop();
    await input.close();
  }
});

test(
  "peer coordinator death closes the external helper while the actual root remains alive",
  { skip: !enabled },
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const owner = await readCacheOwner(process.pid),
      peer = await readCacheOwner(child.pid!);
    const bridge = await startCacheLeaseBridge({ binary, binarySha256, owner, peer, onLoss: () => {} });
    try {
      child.kill("SIGKILL");
      await exited;
      const result = await Promise.race([
        bridge.stopped,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("peer death did not stop native helper")), 2000);
          timer.unref();
        }),
      ]);
      assert.equal(result.code, 78);
      assert.equal((await readCacheOwner(process.pid)).startTicks, owner.startTicks);
    } finally {
      child.kill("SIGKILL");
      await exited;
      await bridge.stop();
    }
  },
);

test(
  "binary identity is mandatory and unprivileged paths cannot masquerade as privileged installation",
  { skip: !enabled },
  async () => {
    const owner = await readCacheOwner(process.pid);
    await assert.rejects(
      startCacheLeaseBridge({ binary, binarySha256: "0".repeat(64), owner, peer: owner, onLoss: () => {} }),
      /identity.*mismatched/,
    );
    await assert.rejects(
      startCacheLeaseBridge({ binary, binarySha256, owner, peer: owner, requirePrivilege: true, onLoss: () => {} }),
      /privileged.*protected/,
    );
  },
);

test("foreign owner and inconsistent peer identity cannot establish a bridge", { skip: !enabled }, async () => {
  const owner = await readCacheOwner(process.pid);
  await assert.rejects(
    startCacheLeaseBridge({
      binary,
      binarySha256,
      owner: { ...owner, pid: process.ppid },
      peer: owner,
      onLoss: () => {},
    }),
    /actual calling/,
  );
  await assert.rejects(
    startCacheLeaseBridge({
      binary,
      binarySha256,
      owner,
      peer: { ...owner, startTicks: `${owner.startTicks}0` },
      onLoss: () => {},
    }),
    /peer.*identity/i,
  );
});
