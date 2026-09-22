/**
 * ADR-0012 — `bash` is gated by default in a governed session.
 *
 * The decision, and the principle it deliberately bends: until now the extension's rule was *"governance
 * is opt-in and never silently tightens a workflow"*, with the code default for `PI_DADDY_GATED` empty.
 *
 * That rule survives where it matters — an **ungoverned** session (no `PI_DADDY_GRANT`) is untouched.
 * Inside a session the operator has already chosen to govern, handing a child `bash` hands it an
 * ungoverned-descendant escape hatch (measured: probe `g5-bash-escape`), and doing that silently is
 * the behaviour worth changing. Combined with subsumption-aware gating, one `bash` gate also covers
 * `write`, `edit`, `read`, `grep`, `find` and `ls`.
 *
 * **Absent and empty must stay distinguishable**, or an operator cannot turn the default off.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { gatedFromEnv, DEFAULT_GATED } from "../src/kernel/propagation.ts";

test("an unset PI_DADDY_GATED gates bash, the whole-session handoff, and the writing tools", () => {
  // ADR-0078 added `context:fork` beside `tool:bash`: both hand a child something the grant alone cannot bound —
  // an execution primitive, or everything the parent has read. Production change that breaks this: dropping any
  // id from DEFAULT_GATED, which makes the riskiest default silent.
  //
  // **The writing tools joined on 2026-09-23 by operator decision**, after a review used pi's own `write` from a
  // governed child to write the operator's accepted-workspace record and to widen the stored grant from
  // `tool:read` to `tool:bash`. `edit` and `edit-diff` are here too: they share the same unconfined path
  // resolution, and gating `write` alone would have been a control with a hole its author already knew about.
  assert.deepEqual(gatedFromEnv(undefined), DEFAULT_GATED);
  assert.deepEqual(DEFAULT_GATED, ["tool:bash", "context:fork", "tool:write", "tool:edit", "tool:edit-diff"]);
});

test("an explicitly empty PI_DADDY_GATED gates nothing", () => {
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

test("a real delegation asking to write is gated by the DEFAULT, with no PI_DADDY_GATED set", async () => {
  // **The default was barely exercised end to end.** Nearly every delegation test sets `PI_DADDY_GATED`
  // explicitly, so adding the writing tools to `DEFAULT_GATED` failed exactly one assertion — the one that
  // restates the list. A default nothing drives is a default nobody is testing, which is the shape this
  // package keeps finding. This drives the real planner with the variable UNSET.
  //
  // Breaks by: removing a writing tool from DEFAULT_GATED, or letting `gatedFromEnv(undefined)` return [].
  const { planDelegation } = await import("../src/kernel/delegate.ts");
  const saved = process.env.PI_DADDY_GATED;
  try {
    delete process.env.PI_DADDY_GATED;
    const ctx = {
      ownGrant: ["tool:read", "tool:write", "tool:edit", "tool:delegate"],
      gated: gatedFromEnv(process.env.PI_DADDY_GATED),
      approved: [],
      depth: 0,
      maxDepth: 3,
    };
    for (const tool of ["write", "edit"]) {
      const plan = planDelegation({ task: "x", tools: [tool] }, ctx as never);
      assert.equal(plan.ok, false, `${tool} must be gated by default`);
      assert.match(plan.reason ?? "", /approval/i, `${tool}: the refusal must say an approval is what is missing`);
    }
    // And a read-only child is untouched, which is the whole point of gating the writing ones specifically.
    assert.equal(planDelegation({ task: "x", tools: ["read"] }, ctx as never).ok, true);
  } finally {
    if (saved === undefined) delete process.env.PI_DADDY_GATED;
    else process.env.PI_DADDY_GATED = saved;
  }
});
