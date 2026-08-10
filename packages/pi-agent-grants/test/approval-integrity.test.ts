/**
 * ADR-0014 — approval integrity.
 *
 * Three defects, each of which makes the audit trail say something that is not true:
 *
 *  - **A-C3/B-C1** — the store lived inside the governed workspace, so an agent gated on `write` could
 *    write its own approval. Self-defeating in the package's own recommended configuration, and the
 *    ledger recorded the result as `approvalSource: "persisted"` — indistinguishable from a human.
 *  - **A-S1 / B-C6** — the scope a human chose was not carried across boundaries, so "Allow once" was
 *    inherited by an entire descendant subtree.
 *  - **A-S6** — the subject was erased at the propagation boundary, so a `<delegate>`-subject approval
 *    matched *any* subject one hop down. `approval.ts` argues at length that a model-controlled key is
 *    not a key; the propagation disagreed with it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalKey, inheritApprovals, parseInherited, type InheritableApproval } from "../src/approval.ts";
import { approvalsPath, legacyApprovalsPath } from "../src/approval-store.ts";
import { resolveApprovals } from "../src/approval.ts";

const inheritable = (over: Partial<InheritableApproval> = {}): InheritableApproval => ({
  capability: "tool:write",
  subject: "docs-writer",
  scope: "session",
  ...over,
});

// ── the trust root ───────────────────────────────────────────────────────────────────────────────

test("the approvals store lives outside the governed workspace", () => {
  const cwd = "/home/someone/project";
  const path = approvalsPath(cwd);
  assert.ok(
    !path.startsWith(cwd),
    "an agent that may write in the workspace must not be able to write its own approval",
  );
});

test("the legacy in-workspace path is still nameable, so it can be reported", () => {
  // Deliberately NOT auto-imported: migrating it would import exactly the entries we stopped trusting.
  // Naming it lets the extension tell an operator that an old file exists and is being ignored.
  const cwd = "/home/someone/project";
  assert.equal(legacyApprovalsPath(cwd), `${cwd}/.pi/grants-approvals.json`);
});

// ── scope must survive the boundary ──────────────────────────────────────────────────────────────

test("an `once` approval is never inherited", () => {
  const out = inheritApprovals([inheritable({ scope: "once" })], ["tool:write"]);
  assert.deepEqual(out, [], "a human's most conservative answer must not become the least conservative");
});

test("`session` and `always` approvals are inherited", () => {
  for (const scope of ["session", "always"] as const) {
    const out = inheritApprovals([inheritable({ scope })], ["tool:write"]);
    assert.deepEqual(out, ["tool:write@docs-writer"], `scope ${scope}`);
  }
});

test("an approval is still clamped to what the child actually holds", () => {
  // The pre-existing property, which must survive the format change: approval cannot conjure capability.
  assert.deepEqual(inheritApprovals([inheritable()], ["tool:read"]), []);
});

// ── the subject must survive the boundary ────────────────────────────────────────────────────────

test("an inherited approval carries its subject", () => {
  assert.deepEqual(inheritApprovals([inheritable()], ["tool:write"]), ["tool:write@docs-writer"]);
});

test("an inherited approval does NOT satisfy a different subject", () => {
  const inherited = parseInherited("tool:write@<delegate>");
  const result = resolveApprovals({
    gated: ["tool:write"],
    subject: "docs-writer",
    sessionApprovals: new Set(),
    persisted: new Map(),
    inherited,
  });
  assert.deepEqual(result.approved, [], "a <delegate> approval must not authorise an agent type");
  assert.deepEqual(result.needsPrompt, ["tool:write"]);
});

test("an inherited approval DOES satisfy its own subject", () => {
  const result = resolveApprovals({
    gated: ["tool:write"],
    subject: "docs-writer",
    sessionApprovals: new Set(),
    persisted: new Map(),
    inherited: parseInherited("tool:write@docs-writer"),
  });
  assert.deepEqual(result.approved, ["tool:write"]);
  assert.equal(result.sources["tool:write"], "inherited");
});

test("parseInherited tolerates the empty and malformed cases without granting anything", () => {
  for (const raw of ["", "   ", "not-a-pair", "@nosubject", "tool:write@"]) {
    assert.deepEqual(parseInherited(raw).size, 0, `${JSON.stringify(raw)} must grant nothing`);
  }
});

test("the pair format round-trips through approvalKey", () => {
  const key = approvalKey("tool:write", "docs-writer");
  assert.ok(parseInherited(key).has(key), "what we publish must be what the child parses");
});
