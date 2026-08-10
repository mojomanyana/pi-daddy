/**
 * G7 — configuration robustness (review findings A-S4/B-I4, B-I8).
 *
 * Both defects share a shape: a configuration value that is *wrong* is treated as a value that is
 * *absent*, and absence is the permissive case.
 *
 *  - **A-S4/B-I4** — `Number.parseInt(process.env.PI_GRANTS_MAX_DEPTH ?? "2", 10)` with no guard.
 *    `??` catches only `undefined`, so `PI_GRANTS_MAX_DEPTH=""` or `=abc` yields `NaN`, and **every**
 *    comparison against `NaN` is false: `maxDepth <= 0` false, `childDepth > maxDepth` false. Depth
 *    limiting is disabled outright. The adjacent `depth` parse has a `|| 0` guard, which fails open in
 *    the other direction — a malformed depth makes a deep session look like a root.
 *  - **B-I8** — with `PI_GRANTS_GRANT` unset the extension still published grant/depth variables to
 *    children, so "inactive" governance still governed descendants, contradicting the README.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnv, depthConfig, parseBound } from "../src/propagation.ts";

test("parseBound accepts a non-negative integer", () => {
  assert.equal(parseBound("0"), 0);
  assert.equal(parseBound("3"), 3);
  assert.equal(parseBound(" 3 "), 3, "surrounding whitespace is not a malformed value");
});

test("parseBound reports absence distinctly from garbage", () => {
  assert.equal(parseBound(undefined), undefined, "absent means 'use the default', not 'fail'");
  for (const bad of ["", "   ", "abc", "-1", "1.5", "NaN", "Infinity"]) {
    assert.equal(parseBound(bad), null, `${JSON.stringify(bad)} must be rejected, not coerced`);
  }
});

test("parseBound rejects a numeric prefix rather than silently truncating it", () => {
  // This is the whole bug class: parseInt("2abc") is 2, so a typo becomes a plausible-looking bound.
  assert.equal(parseBound("2abc"), null);
  assert.equal(parseBound("0x10"), null);
});

test("absent depth configuration keeps the documented defaults", () => {
  const c = depthConfig(undefined, undefined);
  assert.deepEqual({ depth: c.depth, maxDepth: c.maxDepth }, { depth: 0, maxDepth: 2 });
  assert.deepEqual(c.malformed, []);
});

test("a malformed maxDepth disables spawning instead of disabling the limit", () => {
  const c = depthConfig("0", "");
  assert.equal(c.maxDepth, 0, "maxDepth 0 is refused by decideSpawn; NaN was silently permissive");
  assert.deepEqual(c.malformed, ["PI_GRANTS_MAX_DEPTH"]);
});

test("a malformed depth does not reset a deep session to root", () => {
  const c = depthConfig("abc", "5");
  assert.equal(c.maxDepth, 0, "we cannot know how deep we are, so we must not spawn");
  assert.deepEqual(c.malformed, ["PI_GRANTS_DEPTH"]);
});

test("both malformed are both reported", () => {
  assert.deepEqual(depthConfig("x", "y").malformed, ["PI_GRANTS_DEPTH", "PI_GRANTS_MAX_DEPTH"]);
});

test("an ungoverned session publishes nothing to its children", () => {
  // B-I8. `governed` is false when PI_GRANTS_GRANT is unset; the README promises nothing is blocked,
  // but the extension still exported grant/depth/maxDepth, so a child started governing itself.
  const env = childEnv({
    ownGrant: ["tool:read"],
    depth: 0,
    maxDepth: 2,
    gated: [],
    approved: [],
    governed: false,
  });
  assert.deepEqual(env, {}, "an inactive governance layer must not configure descendants");
});

test("a governed session still publishes what children inherit", () => {
  const env = childEnv({
    ownGrant: ["tool:read"],
    depth: 0,
    maxDepth: 2,
    gated: [],
    approved: [],
    governed: true,
  });
  assert.equal(env.PI_GRANTS_GRANT, "tool:read");
  assert.equal(env.PI_GRANTS_DEPTH, "1");
});
