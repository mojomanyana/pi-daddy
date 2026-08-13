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
import { approvalKey, inheritApprovals, parseInherited, verifyInherited, type InheritableApproval } from "../src/approval.ts";
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
  // The `cwd` argument is REAL since ADR-0020 (one file per project) and was a lie before it — accepted and
  // ignored, which is how the unit suite came to rewrite the developer's own store while believing it was
  // hermetic (R-40). It now selects which project's file, and the assertion is that it never selects a path
  // inside the project itself: the store must stay somewhere a governed agent cannot write.
  const cwd = "/home/someone/project";
  assert.ok(
    !approvalsPath(cwd).startsWith(cwd),
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
    inherited: verifyInherited(inherited, () => null),
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
    inherited: verifyInherited(parseInherited("tool:write@docs-writer"), () => null),
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

// ── ADR-0022: an inherited approval names the instructions it was given for ──────────────────────────

test("ADR-0022: an inherited approval is dropped when the body it was given for has changed", () => {
  // The hole: `resolveApprovals` checks `inherited` FIRST and nothing on that path had ever been through
  // `entryVerdict`, so ADR-0019's "void once the instructions change" held only for persisted entries. A
  // child is a fresh process that re-reads the definition from disk, so a `git pull` between the parent's
  // approval and the child's spawn meant the child ran a rewritten body under the old yes — and recorded
  // `approvalSource: "inherited"`, which reads as correct.
  //
  // Breaks if the digest stops being compared, or if a mismatch is treated as "no pin" and honoured.
  const published = inheritApprovals(
    [{ capability: "tool:bash", subject: "deploy", scope: "session", bodySha256: "aaa111" }],
    ["tool:bash"],
  );
  assert.deepEqual(published, ["tool:bash@deploy#aaa111"], "the digest rides with the key");

  const asParentSawIt = verifyInherited(parseInherited(published.join(",")), () => ({
    ceiling: ["tool:bash"],
    bodySha256: "aaa111",
  }));
  assert.deepEqual([...asParentSawIt], ["tool:bash@deploy"], "same body: the approval applies");

  const afterRewrite = verifyInherited(parseInherited(published.join(",")), () => ({
    ceiling: ["tool:bash"],
    bodySha256: "bbb222",
  }));
  assert.deepEqual([...afterRewrite], [], "rewritten body: the approval does not apply");

  const deleted = verifyInherited(parseInherited(published.join(",")), () => null);
  assert.deepEqual([...deleted], [], "definition gone: an approval pinned to it cannot be verified, so it fails closed");
});

test("ADR-0022: an entry with no pin is still honoured, and one promising a pin without carrying it is not", () => {
  // `<delegate>` names no file to hash, and a pre-0.11 parent sends no digest at all — both legitimately
  // unpinned, and both a much shorter chain to trust than a 30-day-old file (which `entryVerdict` refuses
  // for exactly this reason). `key#` with nothing after it is neither: it claims a pin and carries none.
  const unpinned = verifyInherited(parseInherited("tool:write@<delegate>"), () => null);
  assert.deepEqual([...unpinned], ["tool:write@<delegate>"]);

  const truncated = verifyInherited(parseInherited("tool:bash@deploy#"), () => ({
    ceiling: ["tool:bash"],
    bodySha256: "aaa111",
  }));
  assert.deepEqual([...truncated], [], "a promise of a pin with no pin is dropped, not guessed at");
});

test("ADR-0022: the digest survives a round trip through the environment format", () => {
  // The propagation format is a comma-separated string, and `#` had to be a character that cannot occur in
  // a capability id or a definition name (identity comes from a path component). This pins that.
  const published = inheritApprovals(
    [
      { capability: "tool:bash", subject: "deploy", scope: "session", bodySha256: "abc" },
      { capability: "tool:write", subject: "<delegate>", scope: "session" },
    ],
    ["tool:bash", "tool:write"],
  );
  const parsed = parseInherited(published.join(","));
  assert.equal(parsed.get("tool:bash@deploy"), "abc");
  assert.equal(parsed.get("tool:write@<delegate>"), undefined);
  assert.equal(parsed.size, 2);
});

test("ADR-0022: a stale inherited approval is not laundered into a fresh one on the way down", async () => {
  // Found while reviewing my own change. `verifyInherited` correctly stops THIS session using an approval
  // whose body digest no longer matches — but `republishable` mapped over the RAW inherited keys and
  // stamped each with THIS session's current digest. So a middle session that cannot use the approval
  // would still hand its child a perfectly valid-looking one:
  //
  //   parent approves body A, sends  tool:bash@deploy#A
  //   middle loads body B, refuses it locally, republishes  tool:bash@deploy#B
  //   child  loads body B, digest matches, uses it — under a yes given about A
  //
  // That is ADR-0022's hole reappearing one hop further down, which is exactly the failure the ADR says
  // its digest exists to prevent. Breaks if `republishable` stops filtering through `verifyInherited`.
  const { republishable } = await import("../extensions/approvals.ts");

  const definition = {
    name: "deploy",
    description: "d",
    allowedTools: "Bash",
    body: "BODY B",
    source: "/p/.pi/skills/deploy/SKILL.md",
  };
  const session = {
    definitions: new Map([["deploy", definition]]),
    // The parent's pin is for a body this session does not have.
    inheritedApprovals: new Map([["tool:bash@deploy", "digest-of-body-A"]]),
    sessionApprovals: new Set<string>(),
  };

  const published = republishable(session as never);
  assert.deepEqual(
    published,
    [],
    "an approval this session may not use must not be handed to its children with a fresh digest",
  );
});
