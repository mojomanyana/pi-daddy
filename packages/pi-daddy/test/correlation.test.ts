import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalBindingDigest,
  buildApprovalBinding,
  digestCapabilities,
  digestTask,
  normaliseCorrelation,
} from "../src/correlation.ts";

const upstream = {
  schema_version: "1.0",
  run_id: "run-1",
  task_id: "task-2",
  workspace_id: "workspace-a",
  context_id: "review-spec-1",
  phase: "review",
  assurance: "critical",
  assurance_source: "natural-language",
  assurance_scope: { type: "selectors", selectors: ["src/auth/**"] },
  activated_at: "2026-08-19T20:00:00Z",
  plan_digest: "1".repeat(64),
  definition_digest: "2".repeat(64),
  task_digest: "3".repeat(64),
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  tree_sha: "c".repeat(40),
  event_seq: 19,
  last_change_seq: 12,
  last_authority_seq: 17,
};

test("upstream assurance values are preserved as opaque correlation metadata", () => {
  const got = normaliseCorrelation(upstream);
  assert.deepEqual(got, upstream);
  assert.notEqual(got, upstream, "the ledger receives a snapshot, not a caller-owned mutable object");
  assert.notEqual(got?.assurance_scope, upstream.assurance_scope);
});

test("trusted task and capability digests are computed, never copied from correlation", () => {
  assert.equal(digestTask("exact task"), "dbeee95e71e7a2f50648e6630e61a58dac3272fdb29838d37f58b0f564f7f15e");
  assert.equal(digestCapabilities(["tool:write", "tool:read", "tool:read"]), digestCapabilities(["tool:read", "tool:write"]));
  assert.notEqual(digestTask("exact task"), upstream.task_digest);
});

test("approval binding changes for task, capability, workspace, context, parent, or definition", () => {
  const base = buildApprovalBinding({
    task: "debug this probe",
    requested: ["tool:read", "tool:bash"],
    effective: ["tool:bash", "tool:read"],
    definitionSha256: "d".repeat(64),
    parentId: "d0",
    correlation: upstream,
  });
  const digest = approvalBindingDigest(base);
  const variants = [
    buildApprovalBinding({ task: "different task", requested: base.requested, effective: base.effective, definitionSha256: base.definition_sha256, parentId: base.parent_id, correlation: upstream }),
    buildApprovalBinding({ task: "debug this probe", requested: ["tool:read"], effective: base.effective, definitionSha256: base.definition_sha256, parentId: base.parent_id, correlation: upstream }),
    buildApprovalBinding({ task: "debug this probe", requested: base.requested, effective: base.effective, definitionSha256: "e".repeat(64), parentId: base.parent_id, correlation: upstream }),
    buildApprovalBinding({ task: "debug this probe", requested: base.requested, effective: base.effective, definitionSha256: base.definition_sha256, parentId: "d9", correlation: upstream }),
    buildApprovalBinding({ task: "debug this probe", requested: base.requested, effective: base.effective, definitionSha256: base.definition_sha256, parentId: base.parent_id, correlation: { ...upstream, workspace_id: "workspace-b" } }),
    buildApprovalBinding({ task: "debug this probe", requested: base.requested, effective: base.effective, definitionSha256: base.definition_sha256, parentId: base.parent_id, correlation: { ...upstream, context_id: "review-spec-2" } }),
  ];
  for (const variant of variants) assert.notEqual(approvalBindingDigest(variant), digest);
});

test("candidate tree identity is separate from committed HEAD identity", () => {
  const a = normaliseCorrelation(upstream)!;
  const b = normaliseCorrelation({ ...upstream, tree_sha: "f".repeat(40) })!;
  assert.equal(a.head_sha, b.head_sha);
  assert.notEqual(a.tree_sha, b.tree_sha);
});
