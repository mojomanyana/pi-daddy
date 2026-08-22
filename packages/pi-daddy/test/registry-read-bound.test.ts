/**
 * **Its own file, because it measures RESIDENT MEMORY.**
 *
 * An RSS delta is only meaningful against a clean baseline, and this lived beside seventeen other cases whose
 * allocations inflated it — so the mutation that should have failed it (`handle.readFile` instead of the
 * bounded loop) passed, in the catalogue built to catch exactly that. The measurement was right and its
 * environment was not. `scripts/mutation-audit.mjs` runs one file per entry, so isolation is what makes this
 * entry trustworthy.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { open as fsOpen, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadWorkspaceRegistry } from "../src/workspace.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

/**
 * The ceiling must bound the READ, not just the file — which the first version did not.
 *
 * `handle.readFile` re-`fstat`s the descriptor internally and reads whatever the size is *then*, so holding
 * one handle closed the NAME race and left the SIZE race open. Review won it against the real function: a
 * same-uid writer grew the same inode between the check and the read, and `loadWorkspaceRegistry` returned
 * **192 MiB after measuring 29 bytes**, 467 MiB RSS, at session start.
 *
 * **The assertion is RESIDENT MEMORY, and the first version of this test got that wrong too.** It asserted
 * that no oversize *content* was accepted — which a NUL-filled grown file satisfies either way, because
 * `JSON.parse` refuses it. The defect is the ALLOCATION, so that is what is measured: `handle.readFile` would
 * allocate the whole grown file before anything parses it, and the bounded loop refuses at
 * `REGISTRY_MAX_BYTES + 1` bytes. Reverting the loop makes RSS jump by the size of the grow.
 *
 * Breaks by: replacing the bounded `handle.read` loop with `handle.readFile`.
 */
test("a registry that GROWS after its size is checked is refused without allocating it", async () => {
  const dir = await tempDir("pi-daddy-grow-");
  const path = join(dir, "registry.json");
  const small = JSON.stringify({ version: 1, workspaces: { prod: { path: "/w/p" } } });
  const GROW_BYTES = 384 * 1024 * 1024;

  let refused = 0;
  let oversizeAccepted = 0;
  let peakGrowthMiB = 0;
  const baseline = process.memoryUsage().rss;
  for (let i = 0; i < 12; i++) {
    await writeFile(path, small, "utf8");
    // Grow the SAME inode concurrently — that is what defeats a size measured beforehand, by name or by fstat.
    const grow = (async () => {
      const handle = await fsOpen(path, "r+");
      try { await handle.truncate(GROW_BYTES); } finally { await handle.close(); }
    })();
    try {
      const registry = await loadWorkspaceRegistry(path);
      if (Object.keys(registry.workspaces).length === 0) oversizeAccepted++;
    } catch {
      refused++;
    }
    await grow.catch(() => {});
    peakGrowthMiB = Math.max(peakGrowthMiB, (process.memoryUsage().rss - baseline) / (1024 * 1024));
  }

  assert.ok(refused > 0, "the grown file must be refused at least once, or this test proves nothing");
  assert.equal(oversizeAccepted, 0, "no read may return content from beyond the ceiling");
  assert.ok(
    peakGrowthMiB < 128,
    `the read must refuse at the ceiling rather than allocate the file: RSS grew ${Math.round(peakGrowthMiB)} MiB ` +
      `against a ${Math.round(GROW_BYTES / 1024 / 1024)} MiB grow and a 1 MiB limit`,
  );

  // And an ordinary registry still loads — the guard is not simply refusing everything.
  await writeFile(path, small, "utf8");
  assert.deepEqual(Object.keys((await loadWorkspaceRegistry(path)).workspaces), ["prod"]);
});

