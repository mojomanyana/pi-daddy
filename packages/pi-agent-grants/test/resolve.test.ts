import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNarrowing,
  resolve,
  toPiToolsAllowlist,
  UNIVERSAL_CAPABILITIES,
  expandSubsumed,
} from "../src/resolve.ts";
import { buildRecord, isEscalationAttempt } from "../src/ledger.ts";
import { planSpawn } from "../src/spawn.ts";

const R = (over: Partial<Parameters<typeof resolve>[0]> = {}) =>
  resolve({ requested: [], parentGrant: [], ...over });

test("grants only what the parent holds", () => {
  const r = R({ requested: ["tool:read", "tool:write"], parentGrant: ["tool:read"] });
  assert.deepEqual(r.effective, ["tool:read"]);
  assert.deepEqual(r.denied, ["tool:write"]);
});

test("THE invariant: a child can never exceed its parent, however much it asks", () => {
  const r = R({ requested: ["tool:write", "tool:bash", "agent:x"], parentGrant: ["tool:read"] });
  assert.deepEqual(r.effective, []);
  assert.deepEqual(r.denied, ["agent:x", "tool:bash", "tool:write"]);
});

test("attenuation is transitive across three levels", () => {
  const root = ["tool:read", "tool:write", "tool:bash"];
  const l1 = R({ requested: ["tool:read", "tool:write"], parentGrant: root }).effective;
  const l2 = R({ requested: ["tool:read", "tool:write"], parentGrant: l1 }).effective;
  // the grandchild tries to reclaim what level 1 gave up
  const l3 = R({ requested: ["tool:bash"], parentGrant: l2 });
  assert.deepEqual(l3.effective, []);
  assert.deepEqual(l3.denied, ["tool:bash"]);
});

test("ceiling clips without being confused for escalation", () => {
  const r = R({
    requested: ["tool:read", "tool:bash"],
    parentGrant: ["tool:read", "tool:bash"],
    ceiling: ["tool:read"],
  });
  assert.deepEqual(r.effective, ["tool:read"]);
  assert.deepEqual(r.clipped, ["tool:bash"]);
  assert.deepEqual(r.denied, [], "clipped by ceiling is not an escalation attempt");
});

test("an absent ceiling is unbounded, not empty", () => {
  const r = R({ requested: ["tool:read"], parentGrant: ["tool:read"] });
  assert.deepEqual(r.effective, ["tool:read"]);
});

test("an empty ceiling grants nothing", () => {
  const r = R({ requested: ["tool:read"], parentGrant: ["tool:read"], ceiling: [] });
  assert.deepEqual(r.effective, []);
  assert.deepEqual(r.clipped, ["tool:read"]);
});

test("gated capabilities need approval even when legitimately held", () => {
  const base = { requested: ["tool:deploy"], parentGrant: ["tool:deploy"], gated: ["tool:deploy"] };
  assert.deepEqual(R(base).effective, []);
  assert.deepEqual(R(base).gatedBlocked, ["tool:deploy"]);
  assert.deepEqual(R({ ...base, approved: ["tool:deploy"] }).effective, ["tool:deploy"]);
});

test("approval cannot conjure a capability the parent lacks", () => {
  const r = R({
    requested: ["tool:deploy"],
    parentGrant: [],
    gated: ["tool:deploy"],
    approved: ["tool:deploy"],
  });
  assert.deepEqual(r.effective, [], "approval is not a grant");
  assert.deepEqual(r.denied, ["tool:deploy"]);
});

test("rejection reasons do not mask one another", () => {
  const r = R({
    requested: ["tool:a", "tool:b", "tool:c"],
    parentGrant: ["tool:b", "tool:c"],
    ceiling: ["tool:c"],
    gated: ["tool:c"],
  });
  assert.deepEqual(r.denied, ["tool:a"]);
  assert.deepEqual(r.clipped, ["tool:b"]);
  assert.deepEqual(r.gatedBlocked, ["tool:c"]);
  assert.deepEqual(r.effective, []);
});

test("duplicates and ordering do not change the outcome", () => {
  const a = R({ requested: ["tool:read", "tool:read"], parentGrant: ["tool:read"] });
  const b = R({ requested: ["tool:read"], parentGrant: ["tool:read", "tool:read"] });
  assert.deepEqual(a.effective, b.effective);
  assert.equal(a.effective.length, 1, "deduplicated");
});

test("empty request yields empty grant, not a wildcard", () => {
  assert.deepEqual(R({ requested: [], parentGrant: ["tool:read", "tool:write"] }).effective, []);
});

test("universal capabilities are detected and refused by default", () => {
  for (const universal of UNIVERSAL_CAPABILITIES) {
    const r = R({ requested: [universal], parentGrant: [universal] });
    assert.deepEqual(r.effective, [universal]);
    assert.deepEqual(r.universal, [universal]);
    assert.throws(() => assertNarrowing(r), /universal capabilities/);
    assert.doesNotThrow(() => assertNarrowing(r, true), "explicit override is allowed");
  }
});

test("a narrow grant with fabric_exec smuggled in is refused — the measured escalation", () => {
  // Probes 2/4/7/8: tools:[] + recursive:true still reached pi.write and spawned a writing grandchild.
  const r = R({
    requested: ["tool:read", "ext:pi-fabric/fabric_exec"],
    parentGrant: ["tool:read", "ext:pi-fabric/fabric_exec"],
  });
  assert.throws(() => assertNarrowing(r), /fabric_exec/);
});

test("clean grants pass the narrowing assertion", () => {
  assert.doesNotThrow(() => assertNarrowing(R({ requested: ["tool:read"], parentGrant: ["tool:read"] })));
});

test("allowlist projection maps namespaces to bare pi tool names", () => {
  assert.deepEqual(
    toPiToolsAllowlist(["tool:read", "ext:pi-web-access/web_search", "skill:x", "agent:y"]),
    ["read", "web_search"],
    "only tool: and ext: are callable tools; skills and agent types are not --tools entries",
  );
});

test("allowlist is null for a toolless grant, so callers emit --no-tools", () => {
  assert.equal(toPiToolsAllowlist([]), null);
  assert.equal(toPiToolsAllowlist(["skill:x", "agent:y"]), null);
});

test("planSpawn expresses a zero grant as --no-tools, never as pi defaults", () => {
  const plan = planSpawn({ effective: [], prompt: "go" });
  assert.ok(plan.args.includes("--no-tools"));
  assert.ok(!plan.args.includes("--tools"));
  assert.equal(plan.allowlist, null);
});

test("planSpawn passes a real allowlist and disables extension discovery", () => {
  const plan = planSpawn({ effective: ["tool:read", "tool:grep"], prompt: "go" });
  const i = plan.args.indexOf("--tools");
  assert.ok(i >= 0);
  assert.equal(plan.args[i + 1], "grep,read");
  assert.ok(plan.args.includes("--no-extensions"), "ambient extensions must not widen a governed child");
  assert.ok(plan.args.includes("--no-session"));
});

test("ledger flags escalation attempts and records what was refused", () => {
  const result = R({ requested: ["tool:read", "tool:bash"], parentGrant: ["tool:read"] });
  const record = buildRecord({
    parentId: "p1",
    childId: "c1",
    depth: 2,
    requested: ["tool:read", "tool:bash"],
    parentGrant: ["tool:read"],
    result,
    blocked: false,
    now: new Date("2026-08-09T00:00:00Z"),
  });
  assert.equal(isEscalationAttempt(record), true);
  assert.deepEqual(record.denied, ["tool:bash"]);
  assert.deepEqual(record.effective, ["tool:read"]);
  assert.equal(record.ts, "2026-08-09T00:00:00.000Z");
});

test("ledger does not flag a clean grant", () => {
  const result = R({ requested: ["tool:read"], parentGrant: ["tool:read"] });
  const record = buildRecord({
    parentId: "p",
    childId: "c",
    depth: 1,
    requested: ["tool:read"],
    parentGrant: ["tool:read"],
    result,
    blocked: false,
    now: new Date("2026-08-09T00:00:00Z"),
  });
  assert.equal(isEscalationAttempt(record), false);
});

// ---- functional subsumption -------------------------------------------------------------------

test("bash subsumes the file/search tools, so a bash-holder can grant grep", () => {
  const r = R({ requested: ["tool:grep", "tool:ls"], parentGrant: ["tool:bash"] });
  assert.deepEqual(r.effective, ["tool:grep", "tool:ls"]);
  assert.deepEqual(r.denied, []);
  assert.deepEqual(r.subsumedBy, ["tool:grep", "tool:ls"], "flagged as covered indirectly, not held");
});

test("subsumption does not invent unrelated capabilities", () => {
  const r = R({ requested: ["ext:pkg/deploy"], parentGrant: ["tool:bash"] });
  assert.deepEqual(r.effective, []);
  assert.deepEqual(r.denied, ["ext:pkg/deploy"]);
});

test("directly held capabilities are not reported as subsumed", () => {
  const r = R({ requested: ["tool:read"], parentGrant: ["tool:read", "tool:bash"] });
  assert.deepEqual(r.subsumedBy, []);
});

test("subsumption can be switched off for a strict name check", () => {
  const r = R({ requested: ["tool:grep"], parentGrant: ["tool:bash"], subsumption: false });
  assert.deepEqual(r.denied, ["tool:grep"]);
});

test("a bash grant is honestly not narrow — expandSubsumed shows its true reach", () => {
  const reach = expandSubsumed(["tool:bash"]);
  for (const implied of ["tool:read", "tool:write", "tool:edit", "tool:grep", "tool:find", "tool:ls"]) {
    assert.ok(reach.includes(implied), `bash should confer ${implied}`);
  }
});

test("the ledger records what was approved and where the yes came from", () => {
  const result = resolve({
    requested: ["tool:write"],
    parentGrant: ["tool:write"],
    gated: ["tool:write"],
    approved: ["tool:write"],
  });
  const record = buildRecord({
    parentId: "d0",
    childId: "docs-writer@d1",
    depth: 1,
    agentType: "docs-writer",
    requested: ["tool:write"],
    parentGrant: ["tool:write"],
    result,
    blocked: false,
    approved: ["tool:write"],
    approvalSource: "prompt",
    approvalScope: "once",
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.deepEqual(record.approved, ["tool:write"]);
  assert.equal(record.approvalSource, "prompt");
  assert.equal(record.approvalScope, "once");
  assert.equal(record.humanDenied, undefined);
});

test("a human saying no is recorded distinctly from an escalation attempt", () => {
  const result = resolve({
    requested: ["tool:write"],
    parentGrant: ["tool:write"],
    gated: ["tool:write"],
  });
  const record = buildRecord({
    parentId: "d0",
    childId: "docs-writer@d1",
    depth: 1,
    requested: ["tool:write"],
    parentGrant: ["tool:write"],
    result,
    blocked: true,
    humanDenied: true,
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(record.humanDenied, true);
  assert.deepEqual(record.gatedBlocked, ["tool:write"]);
  assert.deepEqual(record.denied, [], "a human declining is NOT an escalation attempt");
  assert.equal(isEscalationAttempt(record), false);
});

test("a gate hit with nobody present is neither an escalation nor a human refusal", () => {
  const result = resolve({
    requested: ["tool:write"],
    parentGrant: ["tool:write"],
    gated: ["tool:write"],
  });
  const record = buildRecord({
    parentId: "d0",
    childId: "docs-writer@d1",
    depth: 1,
    requested: ["tool:write"],
    parentGrant: ["tool:write"],
    result,
    blocked: true,
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(record.humanDenied, undefined);
  assert.equal(record.approvalSource, undefined);
  assert.deepEqual(record.gatedBlocked, ["tool:write"]);
  assert.equal(isEscalationAttempt(record), false);
});

test("existing records are unaffected — the new fields are absent, not null", () => {
  const result = resolve({ requested: ["tool:read"], parentGrant: ["tool:read"] });
  const record = buildRecord({
    parentId: "d0",
    childId: "x@d1",
    depth: 1,
    requested: ["tool:read"],
    parentGrant: ["tool:read"],
    result,
    blocked: false,
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  const round = JSON.parse(JSON.stringify(record));
  assert.equal("approved" in round, false);
  assert.equal("humanDenied" in round, false);
});

test("defined-but-falsy approval fields do not leak into the audit record", () => {
  const result = resolve({ requested: ["tool:read"], parentGrant: ["tool:read"] });
  const record = buildRecord({
    parentId: "d0",
    childId: "x@d1",
    depth: 1,
    requested: ["tool:read"],
    parentGrant: ["tool:read"],
    result,
    blocked: false,
    approved: [],  // explicitly defined but empty
    humanDenied: false,  // explicitly defined but false
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  const round = JSON.parse(JSON.stringify(record));
  assert.equal("approved" in round, false, "empty approved[] should not appear in JSON");
  assert.equal("humanDenied" in round, false, "false humanDenied should not appear in JSON");
});

// ── ADR-0023: `agent:*` ──────────────────────────────────────────────────────────────────────────────

test("ADR-0023: agent:* covers any definition id and confers no tools", () => {
  // The configuration that was unexpressible: "may spawn any of our definitions, but never hand over
  // write". The only wildcard was `tool:*`, which is authority to grant EVERY tool — so an operator had to
  // choose between an unmaintainable list and a total grant, and R-25 records which one gets chosen.
  const r = resolve({
    requested: ["agent:deploy", "agent:review", "tool:read"],
    parentGrant: ["agent:*", "tool:read"],
  });

  assert.deepEqual(r.denied, [], "any agent: id is covered");
  assert.deepEqual(r.effective, ["agent:deploy", "agent:review", "tool:read"]);

  const noTools = resolve({ requested: ["tool:write"], parentGrant: ["agent:*", "tool:read"] });
  assert.deepEqual(noTools.denied, ["tool:write"], "and it grants no tool authority whatsoever");
});

test("ADR-0023: agent:* is not a general namespace wildcard", () => {
  // Deliberately one explicit case rather than a `<ns>:*` mechanism, so a namespace added later does not
  // silently acquire a wildcard. If this ever starts passing, that was a decision someone should have made.
  const r = resolve({ requested: ["skill:review"], parentGrant: ["skill:*", "tool:read"] });
  assert.deepEqual(r.denied, ["skill:review"], "skill:* is not a rule this package implements");
});

test("ADR-0023: agent:* does not exempt a definition id from a gate", () => {
  // Holding a wildcard is authority to grant widely, never authority to skip a human — the property
  // ADR-0011 established for `tool:*` and integration-tested since. It must hold for the new wildcard too.
  const r = resolve({
    requested: ["agent:deploy"],
    parentGrant: ["agent:*"],
    gated: ["agent:deploy"],
  });
  assert.deepEqual(r.gatedBlocked, ["agent:deploy"], "covered by the wildcard, still gated");
  assert.deepEqual(r.effective, []);
});
