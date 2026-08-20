import assert from "node:assert/strict";
import { test } from "node:test";
import { planDelegation } from "../src/delegate.ts";
import { GovernanceRefusal, REFUSAL_CODES, refusal } from "../src/refusals.ts";
import type { SkillDefinition } from "../src/definitions.ts";

const definition = (over: Partial<SkillDefinition> = {}): SkillDefinition => ({
  name: "worker",
  description: "works",
  allowedTools: "Read",
  body: "Do the work.",
  source: "/skills/worker/SKILL.md",
  ...over,
});

const ctx = (over: Record<string, unknown> = {}) => ({
  ownGrant: ["agent:worker", "tool:read"],
  depth: 0,
  maxDepth: 2,
  gated: [] as string[],
  definitions: new Map([["worker", definition()]]),
  ...over,
});

/**
 * The complete refusal union, listed by hand.
 *
 * Listed COMPLETELY and length-checked, because the previous version of this guard enumerated eleven of
 * eighteen members — so the seven `CHECK_*`/`EXECUTOR_*` codes could be deleted from `REFUSAL_CODES` with
 * this test still green, which is the exact failure mode the guard exists to prevent. Adding a code to the
 * union without adding it here now fails.
 */
const ENUMERATED = [
  "CAPABILITY_ESCALATION",
  "DEFINITION_NOT_AUTHORIZED",
  "UNDECLARED_TOOLS",
  "UNKNOWN_TOOL",
  "GATED_UNAPPROVED",
  "APPROVAL_EXPIRED",
  "APPROVAL_SCOPE_MISMATCH",
  "APPROVAL_FLOW_FAILED",
  "DEPTH_EXCEEDED",
  "FANOUT_EXCEEDED",
  "EXECUTOR_UNAVAILABLE",
  "CHILD_TIMED_OUT",
  "CHILD_CANCELLED",
  "CHILD_EXIT_NONZERO",
  "TASK_MISSING",
  "UNKNOWN_DEFINITION",
  "CEILING_PATTERNS_UNRESOLVED",
  "NARROWING_VIOLATED",
  "DEFINITION_UNREADABLE",
  "CORRELATION_TOO_LARGE",
  "CORRELATION_INVALID",
  "LEDGER_WRITE_FAILED",
  "FANOUT_FAILED",
  "WORKSPACE_NOT_REGISTERED",
  "WORKSPACE_WRITE_CONFLICT",
  "WORKSPACE_LEASE_STALE",
  "CHECK_NOT_CONFIGURED",
  "CHECK_CONFIGURATION_INVALID",
  "CHECK_IDENTITY_UNAVAILABLE",
  "CHECK_IDENTITY_MISMATCH",
] as const;

test("the refusal taxonomy is enumerated in full, so it cannot silently shrink or drift", () => {
  for (const code of ENUMERATED) assert.ok(REFUSAL_CODES.includes(code as never), `missing from the union: ${code}`);
  assert.deepEqual(
    [...REFUSAL_CODES].sort(),
    [...ENUMERATED].sort(),
    "the union and this enumeration must match exactly — add new codes here too",
  );
});

test("structured refusals retain actionable human text", () => {
  const r = refusal("WORKSPACE_WRITE_CONFLICT", "workspace w1 already has a governed writer", { workspace_id: "w1" });
  assert.equal(r.code, "WORKSPACE_WRITE_CONFLICT");
  assert.match(r.message, /already has a governed writer/);
  const error = new GovernanceRefusal(r);
  assert.equal(error.code, r.code);
  assert.equal(error.message, r.message);
});

test("planner refusals expose stable codes without changing their human reasons", () => {
  const cases = [
    [planDelegation({ task: "x", tools: ["write"] }, { ...ctx(), ownGrant: ["tool:read"] }), "CAPABILITY_ESCALATION", /escalation blocked/],
    [planDelegation({ task: "x", agent: "worker" }, { ...ctx(), ownGrant: ["tool:read"] }), "DEFINITION_NOT_AUTHORIZED", /agent:worker/],
    [planDelegation({ task: "x", agent: "worker" }, ctx({ definitions: new Map([["worker", definition({ allowedTools: undefined })]]) })), "UNDECLARED_TOOLS", /allowed-tools/],
    [planDelegation({ task: "x", agent: "worker" }, ctx({ gated: ["tool:read"] })), "GATED_UNAPPROVED", /requires explicit approval/],
    [planDelegation({ task: "x", tools: [] }, ctx({ depth: 2 })), "DEPTH_EXCEEDED", /depth limit/],
  ] as const;

  for (const [plan, code, text] of cases) {
    assert.equal(plan.refusal?.code, code);
    assert.match(plan.reason ?? "", text);
    assert.equal(plan.refusal?.message, plan.reason);
  }
});
