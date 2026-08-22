/**
 * The auditor's own parser, pinned.
 *
 * **The production change that breaks this test** (rule 7): re-anchoring `failedTestNames` on a raw `✖`,
 * dropping the ANSI strip, or deleting the `reporterWasReadable` positive control. Each of those is the
 * defect measured at `0a62a42`, where `npm run test:mutation` reported `0/20` under this environment's
 * `FORCE_COLOR=3` while every one of the twenty guards was intact.
 *
 * Deliberately NOT covered, and said out loud rather than implied: that the auditor pins `FORCE_COLOR=0` in
 * the suite it spawns. The strip below is what makes the parser correct in a colouring environment; the env
 * pin is redundancy, and a test asserting the script's source contains a string would be decoration.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { failedTestNames, reporterWasReadable, stripAnsi } from "../scripts/mutation-parse.ts";

const NAME = "a routing escalation always lands in `denied`";
/** Byte-for-byte what `node --test` emitted for these lines under `FORCE_COLOR=3`. */
const COLOURED_FAILURE = `\u001b[31m✖ ${NAME} \u001b[90m(2.512ms)\u001b[39m\u001b[39m\n`;
const COLOURED_PASS = `\u001b[32m✔ ${NAME} \u001b[90m(2.512ms)\u001b[39m\u001b[39m\n`;

test("a failing test's name is read through the colour codes node --test emits under FORCE_COLOR", () => {
  assert.deepEqual(failedTestNames(COLOURED_FAILURE), [NAME]);
  assert.deepEqual(failedTestNames("✖ plain reporter, no colour (1ms)\n"), ["plain reporter, no colour"]);
});

test("a passing test is never read as a failure, coloured or not", () => {
  assert.deepEqual(failedTestNames(COLOURED_PASS), []);
  assert.deepEqual(failedTestNames("✔ plain and passing (1ms)\n"), []);
});

test("a transcript with no test-name line is reported as unreadable, not as a guard that held", () => {
  assert.equal(reporterWasReadable(COLOURED_FAILURE), true);
  assert.equal(reporterWasReadable(COLOURED_PASS), true);
  assert.equal(reporterWasReadable("node: bad option: --test\n"), false);
  assert.equal(reporterWasReadable(""), false);
  // The distinction the control exists for: "no failures" must not be inferable from an unreadable run.
  assert.deepEqual(failedTestNames("node: bad option: --test\n"), []);
});

test("stripping colour leaves the reporter's text exactly as written", () => {
  assert.equal(stripAnsi(COLOURED_PASS), `✔ ${NAME} (2.512ms)\n`);
});
