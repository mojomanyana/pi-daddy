/**
 * A risk headline may not say OPEN when its own body says FIXED.
 *
 * **R-72, and it is R-59 for the second time.** R-59 was four documents describing a defect that had been
 * fixed four days earlier, and its lesson was that a stale line in an orienting document is not one wrong
 * sentence — it is every downstream reader inheriting it, including the reviewers hired to find wrong
 * sentences. R-72 is five risk headlines saying `OPEN` for defects their own bodies recorded as fixed, one
 * of them *"FULLY FIXED … by ADR-0024"*, inside `docs/03-risks.md` itself.
 *
 * **R-59's trigger did not fire, and why is the interesting part.** It named `CLAUDE.md`, the READMEs and
 * the session log — the three places the *previous* instance had been found. A trigger derived from where
 * the last one turned up finds the last one again. This is the generalised form, and it is mechanical, so
 * it is a control rather than a preference (R-34's distinction, which this project keeps relearning).
 *
 * **The production change that breaks this test** (rule 7): closing a risk by appending a FIXED note to its
 * body and leaving the headline alone — which is exactly what happened five times.
 *
 * Deliberately in the package suite even though it checks a repository document: `npm test` is the only
 * thing anyone runs here, and a check in a place nobody runs is the thing R-34 exists to name. It skips
 * when the file is absent, so an installed copy of the package is unaffected.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const REGISTER = join(import.meta.dirname, "..", "..", "..", "docs", "03-risks.md");

test("no risk headline says OPEN while its body records a fix", { skip: existsSync(REGISTER) ? false : "not in the repository" }, async () => {
  const source = await readFile(REGISTER, "utf8");
  // Split on headlines, keeping them: [preamble, head, body, head, body, …].
  const parts = source.split(/^(## R-\d+ · .*)$/m);
  assert.ok(parts.length > 20, "the split found no risk entries — retarget this guard rather than deleting it");

  const stale: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const headline = parts[i];
    // Stop at the next `## ` heading of ANY kind, not just the next risk headline. The LAST entry's body
    // otherwise ran to end of file and swallowed the register log, whose rows legitimately say "fixed" —
    // so a trailing OPEN entry was flagged for wording that belongs to a different section. The guard was
    // right that this file needs checking and wrong about where one entry ends.
    const body = (parts[i + 1] ?? "").split(/^## /m)[0];
    // `, OPEN` is the status suffix. Matching the bare word would flag R-72, whose TITLE is about the word.
    if (!/,\s*OPEN\s*$/m.test(headline)) continue;
    if (/\bFIXED\b|\bCLOSED\b/.test(body)) stale.push(headline.trim());
  }

  assert.deepEqual(
    stale,
    [],
    "these say OPEN and their bodies say otherwise — a headline is what a reader skims and what " +
      `\`grep '^## R'\` returns, so a closed defect reads as live:\n  ${stale.join("\n  ")}`,
  );
});
