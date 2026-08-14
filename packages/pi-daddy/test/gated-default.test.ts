/**
 * ADR-0012 — `bash` is gated by default in a governed session.
 *
 * The decision, and the principle it deliberately bends: until now the extension's rule was *"governance
 * is opt-in and never silently tightens a workflow"*, with the code default for `PI_GRANTS_GATED` empty.
 *
 * That rule survives where it matters — an **ungoverned** session (no `PI_GRANTS_GRANT`) is untouched.
 * Inside a session the operator has already chosen to govern, handing a child `bash` hands it an
 * ungoverned-descendant escape hatch (measured: `docs/probes/g5-bash-escape`), and doing that silently is
 * the behaviour worth changing. Combined with subsumption-aware gating, one `bash` gate also covers
 * `write`, `edit`, `read`, `grep`, `find` and `ls`.
 *
 * **Absent and empty must stay distinguishable**, or an operator cannot turn the default off.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { gatedFromEnv, DEFAULT_GATED } from "../src/propagation.ts";

test("an unset PI_GRANTS_GATED gates bash", () => {
  assert.deepEqual(gatedFromEnv(undefined), DEFAULT_GATED);
  assert.deepEqual(DEFAULT_GATED, ["tool:bash"]);
});

test("an explicitly empty PI_GRANTS_GATED gates nothing", () => {
  // The escape hatch. Without this, an operator who wants no gates has no way to say so, and the only
  // remaining option is to stop governing altogether — which is strictly worse.
  assert.deepEqual(gatedFromEnv(""), []);
});

test("an explicit list replaces the default rather than adding to it", () => {
  assert.deepEqual(gatedFromEnv("tool:write"), ["tool:write"]);
});

test("whitespace is not mistaken for an explicit empty value", () => {
  assert.deepEqual(gatedFromEnv("   "), [], "a value was set, however blank — respect it");
});
