/**
 * Every `await` in `session_start` carries its own `catch`.
 *
 * **R-60 was created by ADDING a line, not by editing one.** The hook has always ended in a blanket
 * `try { … } catch { }`; on 2026-08-14 someone added `await verifyLedger(...)` inside it, and `verifyLedger`
 * rethrows every read error that is not `ENOENT`. From that moment an unreadable ledger cancelled every
 * control below it — the corruption alarm it had just been added to raise, and the `holding [...]` line that
 * is the only sign governance is on — in complete silence. No existing line was touched, no test failed,
 * and nothing in review looked wrong, because each line was fine and the *composition* was not.
 *
 * That is the shape this guards. `test/file-size.test.ts` and `test/temp-hygiene.test.ts` are the same idea:
 * a constraint nobody can run is a preference, and the ones worth encoding are the ones a future edit
 * satisfies by accident or violates without noticing.
 *
 * **The production change that breaks this test** (rule 7): adding a bare `await` to the `session_start`
 * hook. That is precisely how R-60 was born, so it can fail, and only for that.
 *
 * **What it does not check**: whether the `catch` is any good. A `catch {}` that swallows silently passes
 * here — the guard is about a throw not escaping past the controls below it, and R-60's outer catch being
 * made loud is a separate property with no test at all (see R-60, "what this does not establish").
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const HOOK = join(import.meta.dirname, "..", "extensions", "grants.ts");

/**
 * The `session_start` hook body, by brace balance from its `pi.on(` line.
 *
 * Deliberately crude. A real parser would be more correct and would also be a second thing to maintain;
 * this only has to find one hook in one file that this repository owns, and it fails loudly if the anchor
 * ever stops matching rather than silently scanning nothing.
 */
function sessionStartBody(source: string): string {
  const start = source.indexOf('pi.on("session_start"');
  assert.notEqual(start, -1, "anchor not found — if the hook was renamed, retarget this guard rather than deleting it");
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail("unbalanced braces while extracting the session_start body");
}

test("R-60: every await in session_start is inside its own try", async () => {
  const body = sessionStartBody(await readFile(HOOK, "utf8"));
  const lines = body.split("\n");

  // Track nesting relative to the hook's own blanket try, which is depth 1. An `await` is guarded when it
  // sits inside a `try` opened deeper than that one — i.e. a `try` of its own.
  let tryDepth = 0;
  const unguarded: string[] = [];

  for (const [index, line] of lines.entries()) {
    const text = line.trim();
    if (text.startsWith("*") || text.startsWith("//")) continue;
    if (/\btry\s*\{/.test(text)) tryDepth += 1;
    // A `catch` closes the innermost `try` for our purposes: anything after it is no longer covered by it.
    if (/^\}\s*catch\b/.test(text)) tryDepth -= 1;
    // The blanket try is depth 1; anything guarded by a nested one is at 2 or more.
    if (/\bawait\b/.test(text) && tryDepth < 2) unguarded.push(`line ${index + 1}: ${text.slice(0, 90)}`);
  }

  assert.deepEqual(
    unguarded,
    [],
    "an await here inherits R-60: if it throws, every control below it is cancelled and the blanket catch " +
      `is the only thing that notices. Give it its own try/catch that says what could not be checked.\n  ${unguarded.join("\n  ")}`,
  );
});
