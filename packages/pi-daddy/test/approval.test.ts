import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVAL_TTL_DAYS,
  DELEGATE_SUBJECT,
  approvalKey,
  expiryFor,
  inheritApprovals,
  offeredScopes,
  shouldSeekApproval,
} from "../src/approval.ts";
import { resolve } from "../src/resolve.ts";
import { planDelegation } from "../src/delegate.ts";

test("a gated capability with nothing else wrong is worth asking a human about", () => {
  const result = resolve({
    requested: ["tool:read", "tool:write"],
    parentGrant: ["tool:read", "tool:write"],
    gated: ["tool:write"],
  });
  assert.deepEqual(result.gatedBlocked, ["tool:write"]);
  assert.equal(shouldSeekApproval(result), true);
});

test("a request mixing a gated capability with a DENIED one raises no dialog", () => {
  // The spawn is refused for `tool:bash` whatever the human says, so asking them about `tool:write`
  // banks a yes — republished to children for `session`, written to disk for `always` — against a
  // delegation that never happens. The old predicate (gatedBlocked.length > 0) said yes here.
  const result = resolve({
    requested: ["tool:write", "tool:bash"],
    parentGrant: ["tool:write"],
    gated: ["tool:write"],
  });
  assert.deepEqual(result.denied, ["tool:bash"], "denied and gatedBlocked are computed independently");
  assert.deepEqual(result.gatedBlocked, ["tool:write"], "so both are populated at once");
  assert.equal(shouldSeekApproval(result), false, "a refused spawn is not a question for a human");
});

test("clipped alone does not suppress the dialog — a clipped spawn still proceeds", () => {
  const result = resolve({
    requested: ["tool:read", "tool:write"],
    parentGrant: ["tool:read", "tool:write"],
    ceiling: ["tool:write"],
    gated: ["tool:write"],
  });
  assert.deepEqual(result.clipped, ["tool:read"]);
  assert.equal(shouldSeekApproval(result), true, "clipping drops capabilities, it does not refuse");
});

test("no resolution at all (depth, unknown capability, bad task) is never a question for a human", () => {
  assert.equal(shouldSeekApproval(undefined), false);
});

test("planDelegation's mixed gated+denied refusal reaches the predicate as a no", () => {
  // The end-to-end shape the wiring sees: `tools: ["write","bash"]` from a session holding a gated
  // `write` but no `bash` at all.
  const plan = planDelegation(
    { task: "edit and grep", tools: ["write", "bash"] },
    { ownGrant: ["tool:write"], depth: 0, maxDepth: 2, gated: ["tool:write"] },
  );
  assert.equal(plan.ok, false);
  assert.match(plan.reason ?? "", /escalation blocked/, "it refuses for bash, not for the gate");
  assert.equal(shouldSeekApproval(plan.result), false);
});

// The `decideSpawn` variant of this test is DELETED rather than retargeted, and deliberately so: the
// test immediately above already pins the identical property (a mixed gated+denied refusal reaches
// `shouldSeekApproval` as a no) on `planDelegation`, which after ADR-0016 is the only decision function.
// Keeping a second copy would be duplication dressed as coverage.

test("a key names the capability and the subject that was approved", () => {
  assert.equal(approvalKey("tool:write", "docs-writer"), "tool:write@docs-writer");
});

test("an approval for one agent type does not satisfy another", () => {
  assert.notEqual(approvalKey("tool:write", "typeA"), approvalKey("tool:write", "typeB"));
});

test("the delegate subject cannot collide with a real agent type", () => {
  // '<' and '>' are not legal in an agent-type name parsed from frontmatter.
  assert.match(DELEGATE_SUBJECT, /^<.+>$/);
});

test("always is offered on the definition path, where the subject is a file a human wrote", () => {
  // ADR-0019. This assertion previously named `"interceptor"`, a path ADR-0016 had already deleted — so
  // the rule was tested against a caller that no longer existed and `always` was reachable from nowhere.
  assert.deepEqual(offeredScopes("definition"), ["once", "session", "always"]);
});

test("always is NEVER offered on the delegate path — the model controls the subject there", () => {
  assert.deepEqual(offeredScopes("delegate"), ["once", "session"]);
  assert.ok(!offeredScopes("delegate").includes("always"));
});

// ADR-0014: approvals crossing a boundary carry subject and scope, and are published as
// `capability@subject`. See test/approval-integrity.test.ts for the scope and subject rules themselves.
// ADR-0022 (hardened after F1): a definition subject must carry a body pin to cross a boundary at all, so
// these fixtures carry one. `<delegate>` legitimately does not — it names no file — and that case is
// covered in `approval-integrity.test.ts`.
const inh = (capability: string) => ({ capability, subject: "docs-writer", scope: "session" as const, bodySha256: "body-digest" });

test("an inherited approval is intersected with the child's grant", () => {
  assert.deepEqual(inheritApprovals([inh("tool:write"), inh("tool:bash")], ["tool:read", "tool:write"]), [
    "tool:write@docs-writer#body-digest",
  ]);
});

test("THE invariant for approvals: approved can never exceed the grant", () => {
  assert.deepEqual(inheritApprovals([inh("tool:write")], []), []);
  assert.deepEqual(inheritApprovals([], ["tool:write"]), []);
});

test("the wildcard is never inherited as an approval (mirrors R-26 for grants)", () => {
  assert.deepEqual(inheritApprovals([inh("tool:*"), inh("tool:read")], ["tool:*", "tool:read"]), [
    "tool:read@docs-writer#body-digest",
  ]);
});

test("expiry is TTL days after approval, as an ISO instant", () => {
  const at = new Date("2026-08-09T14:02:11.331Z");
  const expected = new Date(at.getTime() + APPROVAL_TTL_DAYS * 86_400_000).toISOString();
  assert.equal(expiryFor(at), expected);
  assert.equal(expiryFor(at), "2026-09-08T14:02:11.331Z");
});

import { entryVerdict, resolveApprovals, type ApprovalEntry } from "../src/approval.ts";

const CWD = "/repo/a";
const NOW = new Date("2026-08-20T00:00:00.000Z");

/** The body digest these entries were approved against (ADR-0019). */
const BODY = "1111111111111111111111111111111111111111111111111111111111111111";

const entry = (over: Partial<ApprovalEntry> = {}): ApprovalEntry => ({
  approvedAt: "2026-08-09T00:00:00.000Z",
  expiresAt: "2026-09-08T00:00:00.000Z",
  cwd: CWD,
  grantAtApproval: ["tool:read", "tool:write"],
  bodyAtApproval: BODY,
  ...over,
});

/** The subject as it stands now: a ceiling plus a body digest, in one lookup (ADR-0019). */
const at = (ceiling: string[], bodySha256: string = BODY) => ({ ceiling, bodySha256 });

test("a live entry whose agent type is unchanged is valid", () => {
  const v = entryVerdict({ entry: entry(), cwd: CWD, now: NOW, current: at(["tool:read", "tool:write"]) });
  assert.equal(v, "valid");
});

test("R-27: an entry approved in another directory authorises nothing here", () => {
  const v = entryVerdict({ entry: entry(), cwd: "/repo/b", now: NOW, current: at(["tool:read", "tool:write"]) });
  assert.equal(v, "foreign-cwd");
});

test("an expired entry is not valid", () => {
  const v = entryVerdict({
    entry: entry(),
    cwd: CWD,
    now: new Date("2026-09-09T00:00:00.000Z"),
    current: at(["tool:read", "tool:write"]),
  });
  assert.equal(v, "expired");
});

test("the confused deputy: a rewritten agent type voids the approval", () => {
  const v = entryVerdict({
    entry: entry(),
    cwd: CWD,
    now: NOW,
    current: at(["tool:bash", "tool:read", "tool:write"]),
  });
  assert.equal(v, "type-changed");
});

test("a deleted agent type voids the approval", () => {
  const v = entryVerdict({ entry: entry(), cwd: CWD, now: NOW, current: null });
  assert.equal(v, "type-missing");
});

test("reordering the tools: line is not a change", () => {
  const v = entryVerdict({ entry: entry(), cwd: CWD, now: NOW, current: at(["tool:write", "tool:read"]) });
  assert.equal(v, "valid");
});

test("ADR-0019: the confused deputy one level deeper — same tools, rewritten instructions", () => {
  // `grantAtApproval` cannot see this: `ceilingForDefinition` reads only `allowed-tools`, so a definition
  // whose body was replaced wholesale still compares equal on tools. The body digest is what closes it.
  const v = entryVerdict({
    entry: entry(),
    cwd: CWD,
    now: NOW,
    current: at(["tool:read", "tool:write"], "a-completely-different-body"),
  });
  assert.equal(v, "instructions-changed");
});

test("ADR-0019: an entry with no body pin fails closed rather than being assumed unchanged", () => {
  const v = entryVerdict({
    entry: entry({ bodyAtApproval: undefined }),
    cwd: CWD,
    now: NOW,
    current: at(["tool:read", "tool:write"]),
  });
  assert.equal(v, "instructions-changed", "pre-0.10.0 entries cost one re-approval; that is the honest price");
});

test("a malformed expiresAt fails closed: not valid, treated as expired", () => {
  const v = entryVerdict({
    entry: entry({ expiresAt: "not-a-date" }),
    cwd: CWD,
    now: NOW,
    current: at(["tool:read", "tool:write"]),
  });
  assert.equal(v, "expired");
});

const RA = (over: Partial<Parameters<typeof resolveApprovals>[0]> = {}) =>
  resolveApprovals({
    gated: [],
    subject: "docs-writer",
    sessionApprovals: new Set<string>(),
    persisted: new Map<string, ApprovalEntry>(),
    ...over,
  });

test("nothing gated means nothing to approve and nothing to ask", () => {
  const r = RA();
  assert.deepEqual(r.approved, []);
  assert.deepEqual(r.needsPrompt, []);
});

test("an unsatisfied gated capability needs a prompt", () => {
  const r = RA({ gated: ["tool:write"] });
  assert.deepEqual(r.approved, []);
  assert.deepEqual(r.needsPrompt, ["tool:write"]);
});

test("a session approval satisfies without prompting", () => {
  const r = RA({ gated: ["tool:write"], sessionApprovals: new Set(["tool:write@docs-writer"]) });
  assert.deepEqual(r.approved, ["tool:write"]);
  assert.deepEqual(r.needsPrompt, []);
  assert.equal(r.sources["tool:write"], "session");
  assert.equal(r.scopes["tool:write"], "session");
});

test("a persisted approval satisfies without prompting", () => {
  const r = RA({ gated: ["tool:write"], persisted: new Map([["tool:write@docs-writer", entry()]]) });
  assert.deepEqual(r.approved, ["tool:write"]);
  assert.equal(r.sources["tool:write"], "persisted");
  assert.equal(r.scopes["tool:write"], "always");
  assert.equal(r.expiresAt["tool:write"], entry().expiresAt);
});

test("an inherited approval satisfies, and outranks session and persisted in reporting", () => {
  const r = RA({
    gated: ["tool:write"],
    // ADR-0014: a set of `capability@subject` keys, so it cannot satisfy another subject.
    inherited: new Set(["tool:write@docs-writer"]),
    sessionApprovals: new Set(["tool:write@docs-writer"]),
  });
  assert.deepEqual(r.approved, ["tool:write"]);
  assert.equal(r.sources["tool:write"], "inherited");
  assert.equal(r.scopes["tool:write"], "session");
});

test("a persisted approval for a DIFFERENT subject does not satisfy", () => {
  const r = RA({ gated: ["tool:write"], persisted: new Map([["tool:write@other", entry()]]) });
  assert.deepEqual(r.approved, []);
  assert.deepEqual(r.needsPrompt, ["tool:write"]);
});

test("mixed: one satisfied, one still needing a human", () => {
  const r = RA({
    gated: ["tool:write", "tool:bash"],
    sessionApprovals: new Set(["tool:write@docs-writer"]),
  });
  assert.deepEqual(r.approved, ["tool:write"]);
  assert.deepEqual(r.needsPrompt, ["tool:bash"]);
});
