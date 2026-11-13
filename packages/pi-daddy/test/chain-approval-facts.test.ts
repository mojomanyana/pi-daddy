import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chainApprovalFacts,
  newChainApprovalAudit,
  rememberChainApproval,
  retainedChainApproval,
} from "../extensions/chain-approval-facts.ts";
import type { ApprovalOutcome } from "../extensions/approvals.ts";

test("chain ledger facts preserve persisted provenance instead of fabricating a prompt", () => {
  const audit = newChainApprovalAudit();
  const outcome: ApprovalOutcome = {
    approved: ["tool:bash"],
    sources: { "tool:bash": "persisted" },
    scopes: {},
    recordedScopes: { "tool:bash": "always" },
    bindings: {},
    expiresAt: { "tool:bash": "2026-09-18T00:00:00.000Z" },
    uses: {},
    humanDenied: false,
  };
  rememberChainApproval(audit, "tool:bash", "reviewer", outcome);
  const facts = chainApprovalFacts(
    audit,
    [{ capability: "tool:bash", subject: "reviewer", scope: "once", bodySha256: "a".repeat(64) }],
    "reviewer",
  );
  assert.equal(facts.sources["tool:bash"], "persisted");
  assert.equal(facts.scopes["tool:bash"], "always");
  assert.equal(facts.expiresAt["tool:bash"], "2026-09-18T00:00:00.000Z");
});

test("an upfront mixed stored and Auto set retains only its pre-existing permission facts", () => {
  const outcome: ApprovalOutcome = {
    approved: ["tool:write", "tool:bash"],
    sources: { "tool:write": "persisted", "tool:bash": "auto" },
    scopes: { "tool:bash": "once" },
    recordedScopes: { "tool:write": "always", "tool:bash": "once" },
    bindings: {},
    expiresAt: { "tool:write": "2026-12-01T00:00:00.000Z" },
    uses: { "tool:bash": { max: 1, remaining: 0 } },
    humanDenied: false,
    banked: [],
  };
  const retained = retainedChainApproval(outcome)!;
  assert.deepEqual(retained.approved, ["tool:write"]);
  assert.deepEqual(retained.sources, { "tool:write": "persisted" });
  assert.deepEqual(retained.recordedScopes, { "tool:write": "always" });
  assert.deepEqual(retained.uses, {});
  assert.deepEqual(retained.scopes, {});
  assert.deepEqual(retained.expiresAt, outcome.expiresAt);
  assert.deepEqual(outcome.approved, ["tool:write", "tool:bash"], "live admission facts remain unchanged");
  assert.equal(retainedChainApproval({ ...outcome, approved: ["tool:bash"] }), undefined);
});
