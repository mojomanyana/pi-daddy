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

test("the refusal taxonomy includes the stable critical-assurance integration codes", () => {
  for (const code of [
    "CAPABILITY_ESCALATION",
    "DEFINITION_NOT_AUTHORIZED",
    "UNDECLARED_TOOLS",
    "UNKNOWN_TOOL",
    "GATED_UNAPPROVED",
    "APPROVAL_EXPIRED",
    "APPROVAL_SCOPE_MISMATCH",
    "DEPTH_EXCEEDED",
    "FANOUT_EXCEEDED",
    "WORKSPACE_WRITE_CONFLICT",
    "WORKSPACE_LEASE_STALE",
  ]) assert.ok(REFUSAL_CODES.includes(code as never), code);
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
