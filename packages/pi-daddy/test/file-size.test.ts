/**
 * A ceiling on file length, enforced rather than remembered.
 *
 * `extensions/grants.ts` reached 866 lines and every wiring bug this package has had lived in it: the G7
 * `NaN` bound, the discarded `isError`, the unconditionally-registered `delegate` (S-5) and R-28's omitted
 * argument. Three independent reviewers flagged its size before any of them was found, and it was flagged
 * again in the session log after the first extraction — a constraint nobody can run is a preference.
 *
 * **The production change that breaks this test** (rule 7): folding `session.ts`, `approvals.ts`,
 * `delegation.ts` or `grants-command.ts` back into `grants.ts`, or letting any one module grow past the
 * bound. That is the exact regression the split exists to prevent, so the test can fail, and only for that.
 *
 * The bound covers `src/` and `extensions/` — the code that ships. Tests are deliberately exempt: a long
 * test file is a lot of small independent cases, which is not the failure mode being prevented here.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

/** Generous on purpose: this is a tripwire for a file becoming unreviewable, not a style rule. */
const MAX_LINES = 400;

const packageRoot = join(import.meta.dirname, "..");

test("no shipped module exceeds the line ceiling", async () => {
  const oversized: string[] = [];

  // Recursive since ADR-0076 moved `src/` into layer directories; a non-recursive read would have checked
  // only the two composition roots and reported the guard green. Vendored files are exempt, as before.
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(join(packageRoot, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== "vendor") out.push(...await walk(relative)); }
      else if (entry.name.endsWith(".ts")) out.push(relative);
    }
    return out;
  };
  for (const dir of ["src", "extensions"]) {
    for (const relative of await walk(dir)) {
      const lines = (await readFile(join(packageRoot, relative), "utf8")).split("\n").length;
      if (lines > MAX_LINES) oversized.push(`${relative} (${lines} lines)`);
    }
  }

  assert.deepEqual(
    oversized,
    [],
    `over ${MAX_LINES} lines: ${oversized.join(", ")} — split it, the way extensions/grants.ts was split ` +
      `into session.ts, approvals.ts, delegation.ts and grants-command.ts`,
  );
});
