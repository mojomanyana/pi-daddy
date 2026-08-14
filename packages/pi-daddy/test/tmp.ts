/**
 * Temp directories that clean up after themselves.
 *
 * Every suite in this package creates a `mkdtemp` directory per test and none of them removed it. One day's
 * runs left **4,896** directories under `/tmp` (session log, 2026-08-14). The comment that stood where
 * `cleanupTempDirs` is now used said *"the OS reaps them"* — true, and on a timer measured in days, so a week
 * of `npm test` leaves tens of thousands of entries that every `readdir` of `/tmp` then walks.
 *
 * This is hygiene, not correctness: nothing here governs anything. The only property worth protecting is
 * that a *failing* test's fixtures can still be inspected, so `PI_GRANTS_KEEP_TMP=1` skips removal entirely.
 *
 * **Not a `.test.ts` file on purpose** — `npm test` runs `test/*.test.ts`, so this is a helper the suites
 * import, not a suite. `test/temp-hygiene.test.ts` is what holds it to its contract.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Set to any non-empty value to leave every fixture directory on disk for inspection. */
export const KEEP_ENV = "PI_GRANTS_KEEP_TMP";

const created: string[] = [];

/** `mkdtemp` under the OS temp dir, remembered so `cleanupTempDirs` can remove it. */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * Remove everything `tempDir` handed out. Register once per suite: `after(cleanupTempDirs)`.
 *
 * Per file rather than per test because a suite is one process — a leak that only shows up across thousands
 * of runs does not need finer granularity than that, and per-test teardown would fight the tests that stage
 * a directory once and reuse it.
 */
export async function cleanupTempDirs(): Promise<void> {
  const dirs = created.splice(0);
  if (process.env[KEEP_ENV]) return;
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}
