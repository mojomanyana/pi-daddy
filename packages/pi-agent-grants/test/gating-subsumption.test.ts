/**
 * ADR-0012 — gating is closed under `SUBSUMPTION`.
 *
 * Review findings A-S7 / B-C9. Gating matched exact capability names, while the package's own
 * `SUBSUMPTION` table documents that `bash` confers `write`, `edit`, `read`, `grep`, `find` and `ls`. So
 * an operator who gated `write` — the single most likely thing anyone gates — got **no prompt at all**
 * when `bash` was handed to a child that then wrote files. The gate read as satisfied because the string
 * `tool:write` never appeared in the request.
 *
 * The rule: a requested capability is gated if it **is** gated, or if it **subsumes** anything gated.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "../src/resolve.ts";

const R = (over: Partial<Parameters<typeof resolve>[0]> = {}) =>
  resolve({ requested: [], parentGrant: [], ...over });

test("gating write also gates bash, because bash can write", () => {
  const r = R({
    requested: ["tool:bash"],
    parentGrant: ["tool:bash"],
    gated: ["tool:write"],
  });
  assert.deepEqual(r.gatedBlocked, ["tool:bash"], "handing down bash must not be a way around a write gate");
  assert.deepEqual(r.effective, []);
});

test("gating write still gates write directly", () => {
  const r = R({ requested: ["tool:write"], parentGrant: ["tool:write"], gated: ["tool:write"] });
  assert.deepEqual(r.gatedBlocked, ["tool:write"]);
});

test("gating does not spread to unrelated capabilities", () => {
  // `grep` is subsumed BY bash; it does not itself subsume write. Gating must not creep outward, or
  // every gate eventually gates everything and operators stop reading the prompts.
  const r = R({ requested: ["tool:grep"], parentGrant: ["tool:bash"], gated: ["tool:write"] });
  assert.deepEqual(r.gatedBlocked, []);
  assert.deepEqual(r.effective, ["tool:grep"]);
});

test("approving the subsuming capability itself releases it", () => {
  const r = R({
    requested: ["tool:bash"],
    parentGrant: ["tool:bash"],
    gated: ["tool:write"],
    approved: ["tool:bash"],
  });
  assert.deepEqual(r.gatedBlocked, []);
  assert.deepEqual(r.effective, ["tool:bash"], "the human was asked about bash, so approving bash is the answer");
});

test("gating bash does not gate the things bash subsumes", () => {
  // Direction matters and is easy to invert. `write` does not confer `bash`, so a `bash` gate must not
  // block a plain `write` grant — that would make gating the broad capability quietly gate the narrow
  // ones, which is the opposite of least privilege.
  const r = R({ requested: ["tool:write"], parentGrant: ["tool:bash"], gated: ["tool:bash"] });
  assert.deepEqual(r.gatedBlocked, []);
  assert.deepEqual(r.effective, ["tool:write"]);
});

test("subsumption-aware gating can be switched off with the existing flag", () => {
  // `subsumption: false` already means "compare names literally". Gating must honour it, or the flag
  // means two different things depending on which part of the result you read.
  const r = R({
    requested: ["tool:bash"],
    parentGrant: ["tool:bash"],
    gated: ["tool:write"],
    subsumption: false,
  });
  assert.deepEqual(r.gatedBlocked, []);
});
