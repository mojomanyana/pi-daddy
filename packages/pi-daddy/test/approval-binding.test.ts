import assert from "node:assert/strict";
import { test } from "node:test";
import { planDelegation } from "../src/delegate.ts";
import { approvalBindingDigest, digestTask } from "../src/correlation.ts";
import { inheritApprovals, resolveApprovals, type ApprovalEntry } from "../src/approval.ts";
import type { SkillDefinition } from "../src/definitions.ts";

const def: SkillDefinition = {
  name: "debugger",
  description: "debugs",
  allowedTools: "Read Bash",
  body: "Diagnose one probe.",
  source: "/skills/debugger/SKILL.md",
};

const base = {
  ownGrant: ["agent:debugger", "tool:read", "tool:bash"],
  depth: 0,
  maxDepth: 2,
  gated: ["tool:bash"],
  definitions: new Map([["debugger", def]]),
  spawnId: "d0",
};
const correlation = { schema_version: "1.0", run_id: "run-1", task_id: "task-1", workspace_id: "w1", context_id: "ctx-1" };

test("a correlated plan computes trusted task and approval bindings", () => {
  const plan = planDelegation({
    task: "probe one failure", agent: "debugger",
    correlation: { ...correlation, task_digest: "f".repeat(64) },
    boundWorkspaceId: "w1", boundContextId: "ctx-1",
  }, base);
  assert.equal(plan.ok, false, "precondition: bash is gated");
  assert.equal(plan.taskDigest, digestTask("probe one failure"));
  assert.notEqual(plan.taskDigest, plan.correlation?.task_digest, "external correlation cannot replace the trusted digest");
  assert.equal(plan.approvalBinding?.workspace_id, "w1");
  assert.equal(plan.approvalBinding?.context_id, "ctx-1");
  assert.equal(plan.approvalBinding?.parent_id, "d0");
  assert.equal(plan.approvalBinding?.definition_sha256, plan.definitionDigest?.sha256);
});

test("correlation alone cannot put a workspace or context into the binding", () => {
  // The values are identical to the trusted ones in the test above; only the SOURCE differs. Reading them
  // out of correlation is what let a bound approval be spent in a workspace the child never entered.
  const claimed = planDelegation({ task: "probe one failure", agent: "debugger", correlation }, base);
  assert.equal(claimed.approvalBinding?.workspace_id, undefined);
  assert.equal(claimed.approvalBinding?.context_id, undefined);
  assert.equal(claimed.correlation?.workspace_id, "w1", "the join metadata is still preserved verbatim");
});

/** A correlated request whose binding scope comes from trusted routing, not from `correlation`. */
const BOUND_REQUEST = {
  task: "probe one failure",
  agent: "debugger",
  correlation,
  boundWorkspaceId: "w1",
  boundContextId: "ctx-1",
} as const;

test("a bound approval permits only the exact definition/task/grant/workspace/context/parent", () => {
  const blocked = planDelegation(BOUND_REQUEST, base);
  assert.ok(blocked.approvalBinding);
  const approved = {
    capability: "tool:bash",
    subject: "debugger",
    scope: "once" as const,
    bodySha256: blocked.definitionDigest?.sha256,
    binding: blocked.approvalBinding,
  };

  const exact = planDelegation(BOUND_REQUEST, { ...base, approved: [approved] });
  assert.equal(exact.ok, true, exact.reason);

  for (const [label, request, over] of [
    ["task", { ...BOUND_REQUEST, task: "probe another failure" }, {}],
    ["workspace", { ...BOUND_REQUEST, boundWorkspaceId: "w2" }, {}],
    ["context", { ...BOUND_REQUEST, boundContextId: "ctx-2" }, {}],
    ["parent", BOUND_REQUEST, { spawnId: "d9" }],
    // The scope must follow the ROUTING SPEC, not the model's correlation claim. Dropping the trusted
    // ids while still claiming them in correlation is exactly how a bound approval was spent outside the
    // workspace it named (R-110): no registry lookup, no lease, the parent's own cwd, digests unchanged.
    ["correlation claim without routing", { task: "probe one failure", agent: "debugger", correlation }, {}],
  ] as const) {
    const plan = planDelegation(request, { ...base, ...over, approved: [approved] });
    assert.equal(plan.ok, false, `${label} mismatch must not replay the approval`);
    assert.equal(plan.refusal?.code, "APPROVAL_SCOPE_MISMATCH");
  }
});

test("legacy unbound approvals remain compatible when no correlation is supplied", () => {
  const plan = planDelegation(
    { task: "legacy task", agent: "debugger" },
    { ...base, approved: [{ capability: "tool:bash", subject: "debugger", scope: "session" }] },
  );
  assert.equal(plan.ok, true, plan.reason);
});

test("session and persisted approvals require the exact binding when one is expected", () => {
  const binding = planDelegation({ task: "probe one failure", agent: "debugger", correlation }, base).approvalBinding!;
  const changed = { ...binding, workspace_id: "w2" };
  const key = "tool:bash@debugger";
  const entry: ApprovalEntry = {
    approvedAt: "2026-08-19T00:00:00Z",
    expiresAt: "2026-09-18T00:00:00Z",
    cwd: "/repo",
    grantAtApproval: ["tool:bash", "tool:read"],
    bodyAtApproval: def.body,
    binding,
  };
  const exactSession = resolveApprovals({
    gated: ["tool:bash"], subject: "debugger", sessionApprovals: new Set(),
    sessionApprovalBindings: new Map([[key, binding]]), persisted: new Map(), expectedBinding: binding,
  });
  assert.deepEqual(exactSession.approved, ["tool:bash"]);

  const wrongSession = resolveApprovals({
    gated: ["tool:bash"], subject: "debugger", sessionApprovals: new Set(),
    sessionApprovalBindings: new Map([[key, changed]]), persisted: new Map(), expectedBinding: binding,
  });
  assert.deepEqual(wrongSession.needsPrompt, ["tool:bash"]);
  assert.deepEqual(wrongSession.scopeMismatched, ["tool:bash"]);

  const wrongPersisted = resolveApprovals({
    gated: ["tool:bash"], subject: "debugger", sessionApprovals: new Set(),
    persisted: new Map([[key, { ...entry, binding: changed }]]), expectedBinding: binding,
  });
  assert.deepEqual(wrongPersisted.approved, []);
  assert.deepEqual(wrongPersisted.scopeMismatched, ["tool:bash"]);

  const expired = resolveApprovals({
    gated: ["tool:bash"], subject: "debugger", sessionApprovals: new Set(), persisted: new Map(),
    expectedBinding: binding, expiredKeys: new Set([key]),
  });
  assert.deepEqual(expired.expired, ["tool:bash"]);
});

test("binding effective capabilities exactly match the eventual grant when agent authority is also declared", () => {
  const self: SkillDefinition = { ...def, allowedTools: "Read agent:debugger" };
  const ctx = {
    ...base,
    ownGrant: ["agent:debugger", "tool:read"],
    gated: ["agent:debugger"],
    definitions: new Map([["debugger", self]]),
  };
  const blocked = planDelegation({ task: "self", agent: "debugger", correlation }, ctx);
  const allowed = planDelegation({ task: "self", agent: "debugger", correlation }, {
    ...ctx,
    approved: [{ capability: "agent:debugger", subject: "debugger", scope: "once", binding: blocked.approvalBinding }],
  });
  assert.equal(allowed.ok, true, allowed.reason);
  assert.deepEqual(blocked.approvalBinding?.effective, allowed.effective);
});

test("bound approval identity is deterministic", () => {
  const a = planDelegation({ task: "probe one failure", agent: "debugger", correlation }, base).approvalBinding!;
  const b = planDelegation({ task: "probe one failure", agent: "debugger", correlation: { ...correlation } }, base).approvalBinding!;
  assert.equal(approvalBindingDigest(a), approvalBindingDigest(b));
});

/**
 * ADR-0034's load-bearing approval bullet — "a bound approval cannot cross a delegation boundary" — was
 * stated in the ADR, in `docs/SPEC.md` and in the package README, asserted by two guards in the code, and
 * pinned by nothing. Both of these mutations left the suite fully green before this test existed, which is
 * why they are here: the guards were correct and undefended.
 */
test("a bound approval is never inherited across a delegation boundary", () => {
  const bound = planDelegation(BOUND_REQUEST, base);
  assert.ok(bound.approvalBinding, "precondition: this call is task-bound");

  const published = inheritApprovals([
    { capability: "tool:bash", subject: "debugger", scope: "always", bodySha256: "a".repeat(64), binding: bound.approvalBinding },
    { capability: "tool:read", subject: "debugger", scope: "always", bodySha256: "a".repeat(64) },
  ], ["tool:bash", "tool:read"]);

  // Dropping `binding === undefined` from `inheritApprovals` makes a task-scoped answer subtree-wide.
  assert.equal(published.some((key) => key.startsWith("tool:bash")), false,
    "a task-bound answer must not be republished to a child");
  assert.equal(published.some((key) => key.startsWith("tool:read")), true,
    "an unbound approval still crosses, or this test would pass for the wrong reason");
});

test("a bound approval does not satisfy an uncorrelated delegation for the same capability and subject", () => {
  const bound = planDelegation(BOUND_REQUEST, base);
  assert.ok(bound.approvalBinding);
  const approved = {
    capability: "tool:bash",
    subject: "debugger",
    scope: "always" as const,
    bodySha256: bound.definitionDigest?.sha256,
    binding: bound.approvalBinding,
  };

  // Same capability, same subject, same task — but no `correlation`, so no binding is expected. If a bound
  // entry could satisfy this, the exact scope would be escaped by simply omitting one optional field.
  const legacy = planDelegation({ task: "probe one failure", agent: "debugger" }, { ...base, approved: [approved] });
  assert.equal(legacy.ok, false, "a bound approval must not be spendable by an unbound call");
  assert.equal(legacy.refusal?.code, "GATED_UNAPPROVED");

  // And the bound call it WAS given for still works, so the refusal above is about the binding.
  const exact = planDelegation(BOUND_REQUEST, { ...base, approved: [approved] });
  assert.equal(exact.ok, true, exact.reason);
});

test("an internally contradictory persisted binding is not a binding at all", async () => {
  const { isApprovalBinding } = await import("../src/correlation.ts");
  const bound = planDelegation(BOUND_REQUEST, base);
  assert.ok(bound.approvalBinding);
  assert.equal(isApprovalBinding(bound.approvalBinding), true);
  // This guard's only trust boundary is a binding parsed off disk, so digests that disagree with the
  // capability arrays beside them must be rejected rather than merely improbable.
  assert.equal(isApprovalBinding({ ...bound.approvalBinding, requested: ["tool:read", "tool:bash", "tool:write"] }), false);
  assert.equal(isApprovalBinding({ ...bound.approvalBinding, effective_sha256: "b".repeat(64) }), false);
  assert.equal(isApprovalBinding({ ...bound.approvalBinding, workspace_id: 7 }), false);
});
