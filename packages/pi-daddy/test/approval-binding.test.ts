import assert from "node:assert/strict";
import { test } from "node:test";
import { planDelegation } from "../src/delegate.ts";
import { approvalBindingDigest, digestTask } from "../src/correlation.ts";
import { resolveApprovals, type ApprovalEntry } from "../src/approval.ts";
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
  const plan = planDelegation({ task: "probe one failure", agent: "debugger", correlation: { ...correlation, task_digest: "f".repeat(64) } }, base);
  assert.equal(plan.ok, false, "precondition: bash is gated");
  assert.equal(plan.taskDigest, digestTask("probe one failure"));
  assert.notEqual(plan.taskDigest, plan.correlation?.task_digest, "external correlation cannot replace the trusted digest");
  assert.equal(plan.approvalBinding?.workspace_id, "w1");
  assert.equal(plan.approvalBinding?.context_id, "ctx-1");
  assert.equal(plan.approvalBinding?.parent_id, "d0");
  assert.equal(plan.approvalBinding?.definition_sha256, plan.definitionDigest?.sha256);
});

test("a bound approval permits only the exact definition/task/grant/workspace/context/parent", () => {
  const blocked = planDelegation({ task: "probe one failure", agent: "debugger", correlation }, base);
  assert.ok(blocked.approvalBinding);
  const approved = {
    capability: "tool:bash",
    subject: "debugger",
    scope: "once" as const,
    bodySha256: blocked.definitionDigest?.sha256,
    binding: blocked.approvalBinding,
  };

  const exact = planDelegation({ task: "probe one failure", agent: "debugger", correlation }, { ...base, approved: [approved] });
  assert.equal(exact.ok, true, exact.reason);

  for (const [label, request, over] of [
    ["task", { task: "probe another failure", agent: "debugger", correlation }, {}],
    ["workspace", { task: "probe one failure", agent: "debugger", correlation: { ...correlation, workspace_id: "w2" } }, {}],
    ["context", { task: "probe one failure", agent: "debugger", correlation: { ...correlation, context_id: "ctx-2" } }, {}],
    ["parent", { task: "probe one failure", agent: "debugger", correlation }, { spawnId: "d9" }],
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
