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
 * The session-start REPORTER, which now holds most of what this guard was written to protect.
 *
 * **Added because the guard silently stopped covering ten of the thirteen controls it exists for.** Splitting
 * `grants.ts` under the 400-line ceiling moved the ledger-integrity check and the spawnable summary — and every
 * `ctx.ui.notify` around them — into `session-report.ts`, which this file did not read. The guard kept passing,
 * over three awaits instead of five, and would have kept passing while a bare `await` added to the reporter
 * cancelled the executor disclosure, the `holding [...]` line and the ledger check in silence.
 *
 * That is R-60's exact shape, inside the guard FOR R-60, introduced by the commit whose message says the guard
 * was obeyed. A guard whose scope a refactor can shrink without failing is not a guard.
 */
const REPORTER = join(import.meta.dirname, "..", "extensions", "session-report.ts");

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

/** Every `await` in `source` that is not inside a `try` opened deeper than `baseDepth`. */
function unguardedAwaits(source: string, baseDepth: number): string[] {
  const lines = source.split("\n");

  let tryDepth = 0;
  const unguarded: string[] = [];

  for (const [index, line] of lines.entries()) {
    const text = line.trim();
    if (text.startsWith("*") || text.startsWith("//")) continue;
    if (/\btry\s*\{/.test(text)) tryDepth += 1;
    // A `catch` closes the innermost `try` for our purposes: anything after it is no longer covered by it.
    if (/^\}\s*catch\b/.test(text)) tryDepth -= 1;
    if (/\bawait\b/.test(text) && tryDepth < baseDepth) unguarded.push(`line ${index + 1}: ${text.slice(0, 90)}`);
  }
  return unguarded;
}

const WHY =
  "an await here inherits R-60: if it throws, every control below it is cancelled and the blanket catch " +
  "is the only thing that notices. Give it its own try/catch that says what could not be checked.";

test("R-60: every await in session_start is inside its own try", async () => {
  // The hook's own blanket try is depth 1, so a guarded await sits at 2 or more.
  const unguarded = unguardedAwaits(sessionStartBody(await readFile(HOOK, "utf8")), 2);
  assert.deepEqual(unguarded, [], `${WHY}\n  ${unguarded.join("\n  ")}`);
});

test("R-60: every await in the session-start REPORTER is inside its own try", async () => {
  // `reportSessionStart` has no blanket try of its own — `grants.ts` wraps the call — so any `try` here is a
  // control's own, and the base depth is 1 rather than 2.
  //
  // The production change that breaks this: adding a bare `await` to `session-report.ts`, which is precisely
  // what the split made possible and invisible.
  const unguarded = unguardedAwaits(await readFile(REPORTER, "utf8"), 1);
  assert.deepEqual(unguarded, [], `${WHY}\n  ${unguarded.join("\n  ")}`);
});
