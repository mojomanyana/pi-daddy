/**
 * ADR-0031's decision table, as a pure function.
 *
 * **The production changes that break these:** making an unset variable mean `runChild` again (that is the
 * reversal itself), or making `PI_GRANTS_HERDR=1` fall back to the process executor when herdr is down. The
 * operator chose refusal over fallback on 2026-08-17, and the reason is the audit story: with a fallback, a
 * ledger can contain a child that ran somewhere nobody chose.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseExecutor, needsProbe } from "../src/executor.ts";

const reachable = { ok: true };
const down = { ok: false, error: "could not connect to herdr" };

test("unset + reachable herdr means panes — this is ADR-0031's reversal", () => {
  const choice = chooseExecutor(undefined, reachable);
  assert.equal(choice.kind, "herdr");
  assert.equal(choice.forced, false);
  assert.equal(choice.refusal, undefined);
});

test("unset + no herdr means the captured subprocess, and never refuses", () => {
  // CI is this case. It must behave exactly as it did before ADR-0031.
  const choice = chooseExecutor(undefined, down);
  assert.equal(choice.kind, "process");
  assert.equal(choice.refusal, undefined, "an unforced fallback must never refuse a delegation");
});

test("`0` forces the subprocess and does not probe at all", () => {
  assert.equal(needsProbe("0"), false);
  const choice = chooseExecutor("0", null);
  assert.equal(choice.kind, "process");
  assert.equal(choice.forced, true);
  assert.equal(choice.probed, false);
  assert.equal(choice.refusal, undefined);
});

test("`1` + reachable herdr means panes, and records that it was demanded", () => {
  const choice = chooseExecutor("1", reachable);
  assert.equal(choice.kind, "herdr");
  assert.equal(choice.forced, true);
  assert.equal(choice.refusal, undefined);
});

test("`1` + herdr down REFUSES rather than falling back, naming the variable and the reason", () => {
  const choice = chooseExecutor("1", down);
  assert.equal(choice.kind, "herdr", "kind must not flip to process — nothing may mistake this for a working session");
  assert.equal(choice.forced, true);
  assert.ok(choice.refusal, "a forced-and-unreachable executor must set a refusal");
  assert.match(choice.refusal, /PI_GRANTS_HERDR/);
  assert.match(choice.refusal, /could not connect to herdr/);
});

test("`1` still probes, so the failure is reported at session start rather than at the first delegation", () => {
  assert.equal(needsProbe("1"), true);
});

test("`1` with no probe result at all still refuses rather than proceeding", () => {
  // The defensive case: if resolveExecutor's probe throws and is swallowed, `1` must not silently become a
  // working herdr session. Failing closed here means refusing, because herdr was demanded.
  const choice = chooseExecutor("1", null);
  assert.ok(choice.refusal);
});

test("an unrecognised value fails CLOSED to the dependency-free executor, loudly", () => {
  // Rule 8. "yes"/"true"/"on" are the plausible typos, and a typo must not silently relocate a run — nor
  // break delegation outright, because the operator meant something and the subprocess is the safe read.
  for (const raw of ["yes", "true", "on", "2", ""]) {
    const choice = chooseExecutor(raw, reachable);
    assert.equal(choice.kind, "process", `${JSON.stringify(raw)} should not select herdr`);
    assert.match(choice.disclosure, /PI_GRANTS_HERDR/);
    assert.equal(choice.refusal, undefined, "a malformed value must not break delegation outright");
  }
});

test("every outcome carries a disclosure line, because ADR-0031 rests on not being silent", () => {
  const cases: Array<[string | undefined, { ok: boolean; error?: string } | null]> = [
    [undefined, reachable], [undefined, down], ["0", null],
    ["1", reachable], ["1", down], ["nonsense", down],
  ];
  for (const [raw, probe] of cases) {
    const choice = chooseExecutor(raw, probe);
    assert.ok(choice.disclosure.length > 0, `no disclosure for ${JSON.stringify(raw)}`);
  }
});

test("the disclosure says what to set, not merely what happened", () => {
  // An operator on a herdr machine who sees "captured subprocess" needs the next action on the same line.
  // This is the gap that produced ADR-0031: the state was discoverable and the remedy was not.
  assert.match(chooseExecutor(undefined, down).disclosure, /PI_GRANTS_HERDR=1/);
});
