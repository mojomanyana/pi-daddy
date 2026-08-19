import assert from "node:assert/strict";
import { test } from "node:test";
import { chainApprovalFacts, newChainApprovalAudit, rememberChainApproval } from "../extensions/chain-approval-facts.ts";
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
  const facts = chainApprovalFacts(audit, [
    { capability: "tool:bash", subject: "reviewer", scope: "once", bodySha256: "a".repeat(64) },
  ], "reviewer");
  assert.equal(facts.sources["tool:bash"], "persisted");
  assert.equal(facts.scopes["tool:bash"], "always");
  assert.equal(facts.expiresAt["tool:bash"], "2026-09-18T00:00:00.000Z");
});
