/**
 * The one cross-process lock, and the invariant it lost.
 *
 * An independent pass reproduced **two holders inside `work()` at once**, across real OS processes, with no
 * clock manipulation. Both breaks had the same root cause: `rm(lockPath)` deletes whatever is at the path
 * *now*, not the lock this process created.
 *
 *  - The stale-break `stat` and `rm` are two separate awaits, so a process descheduled between them can
 *    delete a **live** lock another waiter created in the gap, then succeed at its own create.
 *  - Worse, and far wider: the `finally` deleted the lock unconditionally. A holder whose lock had been
 *    broken out from under it still freed the **new** owner's lock on the way out — and the next arrival,
 *    which raced nothing and observed nothing wrong, walked straight in beside it. One lost race became a
 *    chain that did not self-correct.
 *
 * **The production change that breaks these tests** (rule 7): restoring either unconditional `rm`. That is
 * exactly the code that shipped, so they can fail, and only for that.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { withFileLock } from "../src/file-lock.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("R-67: a holder whose lock was taken over does NOT delete the new owner's lock", async () => {
  // The cascade's root. Simulated exactly as it happens in the wild: while we are inside `work()`, the file
  // at our lock path is replaced by somebody else's. Our `finally` must leave it alone.
  const path = join(await tempDir("grants-lock-"), "target");
  const lockPath = `${path}.lock`;

  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));

  const held = withFileLock(path, "test", async () => {
    entered();
    await sleep(150);
  });

  await inside;
  const ours = await readFile(lockPath, "utf8");
  await writeFile(lockPath, "another-process:not-our-token\n", "utf8");
  await held;

  assert.ok(existsSync(lockPath), "a lock this process no longer owns must survive its finally");
  assert.equal(
    (await readFile(lockPath, "utf8")).trim(),
    "another-process:not-our-token",
    "and must be left exactly as its real owner wrote it",
  );
  assert.notEqual(ours.trim(), "another-process:not-our-token", "precondition: the token really did change");
});

test("R-67: the lock this process DID create is still removed on the way out", async () => {
  // The other half, and the one that keeps the fix from being a leak: proving ownership must not turn into
  // never cleaning up. A lock left behind blocks every writer for a full STALE_LOCK_MS.
  const path = join(await tempDir("grants-lock-"), "target");
  await withFileLock(path, "test", async () => {
    assert.ok(existsSync(`${path}.lock`), "the lock exists while work runs");
  });
  assert.equal(existsSync(`${path}.lock`), false, "and is gone once it does not");
});

test("R-67: a failed write leaves no orphan lock behind", async () => {
  // `open` succeeds, `writeFile` throws (ENOSPC, EDQUOT, EFBIG) — the old code jumped straight to the
  // rethrow, so the already-created lock file stayed on disk and its descriptor leaked to GC. An orphan
  // blocks every writer for STALE_LOCK_MS and, with the ledger's `strict: true`, fails delegations closed
  // for ten seconds at a time while being re-created on each retry.
  const dir = await tempDir("grants-lock-");
  const path = join(dir, "target");
  // A directory at the lock path makes `open(..., "wx")` fail with EISDIR rather than EEXIST — a non-EEXIST
  // error, which is the branch that rethrows.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(`${path}.lock`);

  await assert.rejects(() => withFileLock(path, "test", async () => "unreachable"));
  assert.ok(existsSync(`${path}.lock`), "the pre-existing directory is not ours and must be left alone");
});
