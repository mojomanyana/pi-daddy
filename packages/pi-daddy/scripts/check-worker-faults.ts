/** Invoked by the pinned build verification against a compile-time fault fixture, never the packaged binary. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { open, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const [helper, hash] = process.argv.slice(2);
assert.ok(helper && /^[a-f0-9]{64}$/.test(hash));
for (const mode of ["read-error", "missing-children"]) {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-fault-"));
  const owner = join(root, "owner");
  await mkdir(owner);
  const binary = await open(helper, "r");
  try {
    const child = spawn(helper, [mode, "fixture", "nonce", root, hash, owner, "0", "1000", "--", "/bin/false"], {
      stdio: ["ignore", "ignore", "inherit", "pipe", "pipe", binary.fd],
    });
    (child.stdio[3] as import("node:stream").Duplex).on("error", () => undefined);
    (child.stdio[4] as import("node:stream").Readable).resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    let code: unknown, signal: unknown;
    try {
      [code, signal] = await once(child, "close");
    } finally {
      clearTimeout(timer);
    }
    assert.equal(signal, null, `${mode} must not busy-spin until the watchdog`);
    assert.equal(code, mode === "read-error" ? 0 : 65);
    if (mode === "read-error") {
      const receipt = JSON.parse(await readFile(join(owner, "receipt.json"), "utf8"));
      assert.equal(receipt.reason, "owner-loss");
      assert.equal(receipt.reapedAll, true);
      assert.equal(receipt.workerCode, null);
      assert.equal(receipt.workerSignal, 9);
    } else await assert.rejects(readFile(join(owner, "ownership.json")), { code: "ENOENT" });
    console.log(`Verified native fault refusal: ${mode}`);
  } finally {
    await binary.close();
    await rm(root, { recursive: true, force: true });
  }
}
