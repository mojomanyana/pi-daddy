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
    workspaceId: upstream.workspace_id,
    contextId: upstream.context_id,
  });
  const digest = approvalBindingDigest(base);
  const variants = [
    buildApprovalBinding({ task: "different task", requested: base.requested, effective: base.effective, definitionSha256: base.definition_sha256, parentId: base.parent_id, workspaceId: upstream.workspace_id, contextId: upstream.context_id }),
    buildApprovalBinding({ task: "debug this probe", requested: ["tool:read"], effective: base.effective, definitionSha256: base.definition_sha256, parentId: base.parent_id, workspaceId: upstream.workspace_id, contextId: upstream.context_id }),
    buildApprovalBinding({ task: "debug this probe", requested: base.requested, effective: base.effective, definitionSha256: "e".repeat(64), parentId: base.parent_id, workspaceId: upstream.workspace_id, contextId: upstream.context_id }),
    buildApprovalBinding({ task: "debug this probe", requested: base.requested, effective: base.effective, definitionSha256: base.definition_sha256, parentId: "d9", workspaceId: upstream.workspace_id, contextId: upstream.context_id }),
    buildApprovalBinding({ task: "debug this probe", requested: base.requested, effective: base.effective, definitionSha256: base.definition_sha256, parentId: base.parent_id, workspaceId: "workspace-b", contextId: upstream.context_id }),
    buildApprovalBinding({ task: "debug this probe", requested: base.requested, effective: base.effective, definitionSha256: base.definition_sha256, parentId: base.parent_id, workspaceId: upstream.workspace_id, contextId: "review-spec-2" }),
  ];
  for (const variant of variants) assert.notEqual(approvalBindingDigest(variant), digest);
});

test("candidate tree identity is separate from committed HEAD identity", () => {
  const a = normaliseCorrelation(upstream)!;
  const b = normaliseCorrelation({ ...upstream, tree_sha: "f".repeat(40) })!;
  assert.equal(a.head_sha, b.head_sha);
  assert.notEqual(a.tree_sha, b.tree_sha);
});

/**
 * `correlation` is a MODEL-FACING tool parameter on all three delegation tools, and it is copied verbatim
 * onto every append-only ledger event. `src/ledger.ts` states the invariant in its own header — capability
 * ids, counts and identifiers only, never prompts, tool arguments or results — and ADR-0034 repeats that
 * the ledger must never carry task text.
 *
 * The bound was "is a JSON object, under 32 KB" with no key whitelist and no per-field length limit, and
 * `assurance_scope` was declared `Type.Any()`. So a model could write 32 KB of arbitrary text into the
 * ledger through it, and disabling the cap entirely left the suite green (R-111).
 */
test("correlation is a whitelist of the pinned contract, not a free-form blob", async () => {
  const { normaliseCorrelation } = await import("../src/correlation.ts");

  // Every declared field still survives untouched — the contract requires passing them through unchanged.
  const declared = {
    schema_version: "1.0", run_id: "run-1", task_id: "task-2", workspace_id: "writer-2",
    context_id: "review-spec-2", phase: "review-specification", assurance_effective: "critical",
    assurance_source: "natural-language", assurance_scope: { type: "selectors", selectors: ["src/auth/**"] },
    activated_at: "2026-08-19T20:00:00Z", event_seq: 41, last_change_seq: 30, last_authority_seq: 38,
  };
  assert.deepEqual(normaliseCorrelation(declared), declared);

  for (const [label, value, expected, code] of [
    ["an undeclared key", { run_id: "r", smuggled: "the entire task text" }, /outside the pinned schema/, "CORRELATION_INVALID"],
    ["an over-long declared field", { run_id: "z".repeat(600) }, /exceeds 512 characters/, "CORRELATION_TOO_LARGE"],
    ["an over-large assurance_scope", { assurance_scope: { blob: "z".repeat(5000) } }, /assurance_scope exceeds/, "CORRELATION_TOO_LARGE"],
    ["a non-string where a string belongs", { run_id: 7 }, /run_id must be a string/, "CORRELATION_INVALID"],
    // `Infinity`/`NaN` serialise to `null` and are dropped, which is the right answer for a value JSON
    // cannot carry. A STRING where a sequence number belongs does survive, and must be refused.
    ["a string where a sequence number belongs", { event_seq: "41" }, /event_seq must be a finite number/, "CORRELATION_INVALID"],
  ] as const) {
    assert.throws(
      () => normaliseCorrelation(value as never),
      (error: Error & { code?: string }) => {
        // A SIZE refusal is retryable by truncating; an undeclared field is not. The two carried one code,
        // so `CORRELATION_TOO_LARGE` was declared in the taxonomy and constructed nowhere.
        assert.equal(error.code, code, label);
        assert.match(error.message, expected, label);
        return true;
      },
      label,
    );
  }

  // A 64 KB blob is refused — though by the `assurance_scope` bound, which fires first. Stated plainly
  // because it matters for what this test does NOT cover: the 32 KB total cap is now unreachable
  // (22 declared fields at 512 characters plus a 4 KB scope cannot sum to it), so disabling that cap
  // alone breaks nothing here. It stays as defence-in-depth for the next field somebody adds.
  assert.throws(
    () => normaliseCorrelation({ assurance_scope: { blob: "z".repeat(64 * 1024) } } as never),
    (error: Error & { code?: string }) => error.code === "CORRELATION_TOO_LARGE",
  );
});

test("an oversized correlation is a RECORDED refusal, not an exception escaping the planner", async () => {
  const { planDelegation } = await import("../src/delegate.ts");
  // It threw a bare `Error` from outside every try in `planDelegation`, so this produced a governed
  // refusal with no code and no ledger line at all — the ledger file was never even created (R-112).
  const plan = planDelegation(
    { task: "read one file", tools: ["read"], correlation: { assurance_scope: "z".repeat(40 * 1024) } as never },
    { ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: [], spawnId: "d0" },
  );
  assert.equal(plan.ok, false);
  // Oversize now carries the size code, and the point of the test is that it is RECORDED at all — it used
  // to throw past every recorder, producing a refusal with no code and no ledger line.
  assert.equal(plan.refusal?.code, "CORRELATION_TOO_LARGE");
  assert.ok(plan.result, "a refusal still carries a result, so it is auditable (G6/B-I3)");
});
