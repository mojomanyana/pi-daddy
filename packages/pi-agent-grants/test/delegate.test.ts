import assert from "node:assert/strict";
import { test } from "node:test";
import { DELEGATE_CAPABILITY, normaliseCapability, planDelegation } from "../src/delegate.ts";
import { ENV_DEPTH, ENV_GRANT, ENV_MAX_DEPTH } from "../src/propagation.ts";
import type { SkillDefinition } from "../src/definitions.ts";

const ctx = (over: Partial<Parameters<typeof planDelegation>[1]> = {}) => ({
  ownGrant: ["tool:read", "tool:bash", "tool:edit", "tool:write"],
  depth: 0,
  maxDepth: 2,
  gated: [] as string[],
  ...over,
});

test("normalises bare tool names and leaves namespaced ids alone", () => {
  assert.equal(normaliseCapability("read"), "tool:read");
  assert.equal(normaliseCapability(" bash "), "tool:bash");
  assert.equal(normaliseCapability("ext:pkg/web_search"), "ext:pkg/web_search");
  assert.equal(normaliseCapability("skill:review"), "skill:review");
});

test("provisions a narrower grant than the delegator holds — the actual requirement", () => {
  const d = planDelegation({ task: "summarise", tools: ["read"] }, ctx());
  assert.equal(d.ok, true);
  assert.deepEqual(d.effective, ["tool:read"]);
  const i = d.args.indexOf("--tools");
  assert.equal(d.args[i + 1], "read", "the child gets exactly read, not the parent's four tools");
});

test("each child gets its OWN env object — no shared mutation, so no race", () => {
  const shared = ctx();
  const a = planDelegation({ task: "a", tools: ["read"] }, shared);
  const b = planDelegation({ task: "b", tools: ["bash"] }, shared);
  assert.equal(a.env[ENV_GRANT], "tool:read");
  assert.equal(b.env[ENV_GRANT], "tool:bash");
  assert.notEqual(a.env[ENV_GRANT], b.env[ENV_GRANT], "concurrent delegations carry different grants safely");
  assert.equal(a.env[ENV_DEPTH], "1");
  assert.equal(a.env[ENV_MAX_DEPTH], "2");
});

test("refuses to grant what the delegator does not hold", () => {
  const d = planDelegation({ task: "x", tools: ["read", "deploy"] }, ctx());
  assert.equal(d.ok, false);
  assert.match(d.reason ?? "", /cannot grant tool:deploy/);
  assert.match(d.reason ?? "", /escalation blocked/);
});

test("a zero-tool delegation is expressed as --no-tools", () => {
  const d = planDelegation({ task: "think only", tools: [] }, ctx());
  assert.equal(d.ok, true);
  assert.ok(d.args.includes("--no-tools"));
  assert.ok(!d.args.includes("--tools"));
});

test("depth: maxDepth 0 disables delegation; exceeding the bound fails closed", () => {
  assert.match(planDelegation({ task: "x", tools: [] }, ctx({ maxDepth: 0 })).reason ?? "", /disabled/);
  assert.match(
    planDelegation({ task: "x", tools: [] }, ctx({ depth: 2, maxDepth: 2 })).reason ?? "",
    /depth limit reached \(2\)/,
  );
});

test("an empty task is refused", () => {
  assert.equal(planDelegation({ task: "   ", tools: ["read"] }, ctx()).ok, false);
});

test("gated capability blocks until approved", () => {
  const gatedCtx = ctx({ gated: ["tool:write"] });
  assert.match(planDelegation({ task: "x", tools: ["write"] }, gatedCtx).reason ?? "", /requires explicit approval/);
  const ok = planDelegation({ task: "x", tools: ["write"] }, ctx({ gated: ["tool:write"], approved: [{ capability: "tool:write", subject: "<delegate>", scope: "once" }] }));
  assert.equal(ok.ok, true);
});

test("spawning is a capability: the extension is passed only when delegate is granted", () => {
  const withDelegate = planDelegation(
    { task: "x", tools: ["read", "delegate"] },
    ctx({ ownGrant: ["tool:read", DELEGATE_CAPABILITY], extensionPath: "/x/grants.ts" }),
  );
  assert.ok(withDelegate.args.includes("-e"), "a child that may sub-delegate needs the extension");
  assert.ok(withDelegate.args.includes("/x/grants.ts"));

  const leaf = planDelegation(
    { task: "x", tools: ["read"] },
    ctx({ ownGrant: ["tool:read", DELEGATE_CAPABILITY], extensionPath: "/x/grants.ts" }),
  );
  assert.ok(!leaf.args.includes("-e"), "a leaf child must not receive the delegation machinery");
});

test("a child cannot be granted delegate unless the delegator holds it", () => {
  const d = planDelegation({ task: "x", tools: ["delegate"] }, ctx({ ownGrant: ["tool:read"] }));
  assert.equal(d.ok, false);
  assert.match(d.reason ?? "", /cannot grant tool:delegate/);
});

test("the prompt stays last in argv even when the extension is injected", () => {
  const d = planDelegation(
    { task: "THE-TASK", tools: ["read", "delegate"] },
    ctx({ ownGrant: ["tool:read", DELEGATE_CAPABILITY], extensionPath: "/x/g.ts" }),
  );
  // Positional, not byte-identical: `planSpawn` neutralises the argv position the task occupies, so the
  // element ends with the task rather than equalling it. See test/spawn-argv.test.ts (G1).
  assert.ok(d.args[d.args.length - 1].endsWith("THE-TASK"));
});

test("a universal capability cannot be provisioned even if somehow held", () => {
  const d = planDelegation(
    { task: "x", tools: ["ext:pi-fabric/fabric_exec"] },
    ctx({ ownGrant: ["ext:pi-fabric/fabric_exec"] }),
  );
  assert.equal(d.ok, false);
  assert.match(d.reason ?? "", /universal capabilities/);
});

test("unknown capabilities are refused as unknown, not as escalation", async () => {
  const { makeCatalog } = await import("../src/catalog.ts");
  const catalog = makeCatalog([
    { capability: "tool:read", kind: "builtin" },
    { capability: "tool:delegate", kind: "extension" },
  ]);
  const d = planDelegation({ task: "x", tools: ["read", "reed"] }, { ...ctx(), catalog });
  assert.equal(d.ok, false);
  assert.match(d.reason ?? "", /unknown capability: tool:reed/);
  assert.doesNotMatch(d.reason ?? "", /escalation/, "a typo must not be reported as an escalation attempt");
});

test("a known capability still passes the catalog check", async () => {
  const { makeCatalog } = await import("../src/catalog.ts");
  const catalog = makeCatalog([{ capability: "tool:read", kind: "builtin" }]);
  assert.equal(planDelegation({ task: "x", tools: ["read"] }, { ...ctx(), catalog }).ok, true);
});

// ---------------------------------------------------------------------------
// ADR-0016 — delegate by NAMED DEFINITION, not by a model-chosen tool list.
//
// Before this, `DelegationRequest` was `{task, tools[]}`: the model picked the capabilities. That is
// backwards for governance — the definition is an operator-authored artifact and should be the upper
// bound, with the model choosing only WHICH definition and WHAT task.
// ---------------------------------------------------------------------------

const definition = (over: Partial<SkillDefinition> = {}): SkillDefinition => ({
  name: "review",
  description: "Reviews code",
  allowedTools: "Read Grep",
  body: "# Review\n\nFind what breaks.",
  source: "/skills/review/SKILL.md",
  ...over,
});

test("ADR-0016: a named definition supplies the ceiling, clamped by the session grant", () => {
  const plan = planDelegation(
    { task: "review the diff", agent: "review" },
    {
      ownGrant: ["agent:review", "tool:read", "tool:grep", "tool:bash"],
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: new Map([["review", definition()]]),
    },
  );
  assert.equal(plan.ok, true, plan.reason);
  assert.deepEqual(plan.effective, ["tool:grep", "tool:read"], "the definition bounds it, not the grant");
});

test("ADR-0016: a definition can never widen past the session grant", () => {
  // ADR-0008 is untouched by the new entry point: a definition is an upper bound, never a grant.
  const plan = planDelegation(
    { task: "review", agent: "review" },
    {
      ownGrant: ["agent:review", "tool:read"],
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: new Map([["review", definition({ allowedTools: "Read Grep Bash" })]]),
    },
  );
  assert.equal(plan.ok, false);
  assert.match(String(plan.reason), /grep|bash/);
});

test("ADR-0016: an undeclared allowed-tools refuses, and says how to fix it", () => {
  const plan = planDelegation(
    { task: "review", agent: "review" },
    {
      ownGrant: ["agent:review", "tool:read", "tool:grep"],
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: new Map([["review", definition({ allowedTools: undefined })]]),
    },
  );
  assert.equal(plan.ok, false);
  assert.match(String(plan.reason), /allowed-tools/, "the message must name the field the author must add");
});

test("ADR-0016: a sub-tool pattern refuses and names the pattern", () => {
  const plan = planDelegation(
    { task: "review", agent: "review" },
    {
      ownGrant: ["agent:review", "tool:read", "tool:bash"],
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: new Map([["review", definition({ allowedTools: "Read Bash(git:*)" })]]),
    },
  );
  assert.equal(plan.ok, false);
  assert.match(String(plan.reason), /Bash\(git:\*\)/);
  assert.ok(!plan.effective.includes("tool:bash"), "refusing must not also have granted it");
});

test("ADR-0016: an unknown definition name refuses rather than falling back", () => {
  // pi-subagents resolves an unknown type to `general-purpose`, whose tool list means EVERYTHING. That
  // fallback is why a typo could grant the full toolset. There is no fallback here.
  const plan = planDelegation(
    { task: "x", agent: "reviewww" },
    { ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: [], definitions: new Map() },
  );
  assert.equal(plan.ok, false);
  assert.match(String(plan.reason), /reviewww/);
});

// ---------------------------------------------------------------------------
// ADR-0017 — `agent:<name>` authorises a definition. Before this the ONLY gate on spawning one was
// whether its `allowed-tools` fitted the session grant, so a capability the catalog emitted and the
// parser accepted enforced nothing (R-35).
// ---------------------------------------------------------------------------

test("ADR-0017: a definition cannot be spawned without agent:<name>, even when its tools fit", () => {
  // The exact shape R-35 described: the grant covers everything the definition needs, and that used to
  // be sufficient. Nothing about the tool surface changed — only the authority to run THIS definition.
  const plan = planDelegation(
    { task: "review the diff", agent: "review" },
    {
      ownGrant: ["tool:read", "tool:grep"],
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: new Map([["review", definition()]]),
    },
  );
  assert.equal(plan.ok, false, "tools fitting is no longer sufficient");
  assert.match(String(plan.reason), /agent:review/, "the refusal must name the missing capability");
  assert.match(String(plan.reason), /SKILL\.md/, "and where the definition lives");
});

test("ADR-0017: the refusal is recorded as a DENIAL, so it reaches the escalation signal", () => {
  // `denied` is the signal ADR-0008 designates. A refusal that left it empty would be invisible to every
  // audit query asking "did anything try to exceed its grant?".
  const plan = planDelegation(
    { task: "x", agent: "review" },
    { ownGrant: ["tool:read", "tool:grep"], depth: 0, maxDepth: 2, gated: [], definitions: new Map([["review", definition()]]) },
  );
  assert.deepEqual(plan.result.denied, ["agent:review"]);
  assert.deepEqual(plan.requested, ["agent:review"], "the ledger must record what was actually asked for");
  assert.deepEqual(plan.effective, [], "and nothing may be granted on the way out");
});

test("ADR-0017: holding agent:<name> is what makes it spawnable", () => {
  const plan = planDelegation(
    { task: "review the diff", agent: "review" },
    {
      ownGrant: ["agent:review", "tool:read", "tool:grep"],
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: new Map([["review", definition()]]),
    },
  );
  assert.equal(plan.ok, true, plan.reason);
  assert.deepEqual(plan.effective, ["tool:grep", "tool:read"], "the agent: id authorises, it is not granted");
});

test("ADR-0017: the wildcard satisfies any agent: prerequisite", () => {
  // Governance is opt-in. An ungoverned session holds `tool:*` and must keep spawning exactly as before —
  // and `resolve()` has no wildcard rule, so this only works because the check honours it explicitly.
  const plan = planDelegation(
    { task: "review", agent: "review" },
    {
      ownGrant: ["tool:*", "tool:read", "tool:grep"],
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: new Map([["review", definition()]]),
    },
  );
  assert.equal(plan.ok, true, plan.reason);
});

test("ADR-0017: the refusal names the definitions this session CAN spawn", () => {
  const plan = planDelegation(
    { task: "ship it", agent: "deploy" },
    {
      ownGrant: ["agent:review", "tool:read", "tool:bash"],
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: new Map([
        ["review", definition()],
        ["deploy", definition({ name: "deploy", allowedTools: "Bash", source: "/skills/deploy/SKILL.md" })],
      ]),
    },
  );
  assert.equal(plan.ok, false);
  assert.match(String(plan.reason), /may spawn: agent:review/, "an operator needs the fix, not just the refusal");
});

test("ADR-0017: authorisation is decided before anything is said about the file", () => {
  // A malformed-file diagnostic reported to a caller who was never allowed to spawn it discloses the
  // definition's contents and misnames the actual problem.
  const plan = planDelegation(
    { task: "x", agent: "review" },
    {
      ownGrant: ["tool:read"],
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: new Map([["review", definition({ allowedTools: undefined })]]),
    },
  );
  assert.match(String(plan.reason), /does not hold agent:review/);
  assert.doesNotMatch(String(plan.reason), /allowed-tools/, "the file's problems are not this caller's business");
});

test("ADR-0017: agent: authority attenuates — a definition declares which others it may spawn", () => {
  // The property that makes this coherent with ADR-0008: `ceilingForDefinition` already parses `agent:`
  // entries in `allowed-tools`, so an operator writes a delegator's spawn rights in the same file as its
  // tools, and the child can never receive one the parent does not hold.
  const orchestrator = definition({
    name: "orchestrator",
    // Bare names are the documented form and are lowercased into `tool:`; only `ext:`, `skill:` and
    // `agent:` are passed through as written. Writing `tool:delegate` here yields `tool:tool:delegate`,
    // which the catalog then refuses as unknown — loud, but confusing. See the note on R-35 in the log.
    allowedTools: "Read Delegate agent:review",
    source: "/skills/orchestrator/SKILL.md",
  });
  const ctxFor = (ownGrant: string[]) => ({
    ownGrant,
    depth: 0,
    maxDepth: 3,
    gated: [],
    definitions: new Map([["orchestrator", orchestrator], ["review", definition()]]),
  });

  const granted = planDelegation({ task: "coordinate", agent: "orchestrator" }, ctxFor(["agent:orchestrator", "agent:review", "tool:read", "tool:delegate"]));
  assert.equal(granted.ok, true, granted.reason);
  assert.ok(granted.effective.includes("agent:review"), "the child may spawn review in turn");
  assert.ok(!granted.args.includes("agent:review"), "and the id never reaches pi's --tools");

  const withheld = planDelegation({ task: "coordinate", agent: "orchestrator" }, ctxFor(["agent:orchestrator", "tool:read", "tool:delegate"]));
  assert.equal(withheld.ok, false, "a parent cannot hand down spawn rights it does not hold");
  assert.match(String(withheld.reason), /agent:review/);
});

// ---------------------------------------------------------------------------
// ADR-0018 — the ledger records WHICH instructions ran, as a digest.
// ---------------------------------------------------------------------------

test("ADR-0018: a definition spawn carries a digest of the body it passed to the child", async () => {
  const { createHash } = await import("node:crypto");
  const d = definition();
  const plan = planDelegation(
    { task: "review the diff", agent: "review" },
    { ownGrant: ["agent:review", "tool:read", "tool:grep"], depth: 0, maxDepth: 2, gated: [], definitions: new Map([["review", d]]) },
  );
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.definitionDigest?.sha256, createHash("sha256").update(d.body, "utf8").digest("hex"));
  assert.equal(plan.definitionDigest?.source, "/skills/review/SKILL.md", "a reader must be able to rehash it");

  // The digest must cover exactly what the child received, or it identifies the wrong thing.
  const at = plan.args.indexOf("--append-system-prompt");
  assert.equal(plan.args[at + 1], d.body);
});

test("ADR-0018: rewriting the body changes the digest; rewording the frontmatter does not", () => {
  const ctxFor = (d: SkillDefinition) => ({
    ownGrant: ["agent:review", "tool:read", "tool:grep"],
    depth: 0,
    maxDepth: 2,
    gated: [],
    definitions: new Map([["review", d]]),
  });
  const base = planDelegation({ task: "x", agent: "review" }, ctxFor(definition()));
  const reworded = planDelegation({ task: "x", agent: "review" }, ctxFor(definition({ description: "Totally different blurb" })));
  const rewritten = planDelegation({ task: "x", agent: "review" }, ctxFor(definition({ body: "# Review\n\nApprove everything." })));

  assert.equal(base.definitionDigest?.sha256, reworded.definitionDigest?.sha256, "description is not an instruction");
  assert.notEqual(base.definitionDigest?.sha256, rewritten.definitionDigest?.sha256, "the instructions changed");
});

test("ADR-0018: a tools-only delegation has no digest, and the task is never in the plan's record fields", () => {
  const plan = planDelegation(
    { task: "SECRET-TASK-TEXT", tools: ["read"] },
    { ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: [] },
  );
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.definitionDigest, undefined, "there are no operator-authored instructions to identify");
});

test("ADR-0018: a refusal after the file is read still identifies the version that was refused", () => {
  // A spawn refused for a malformed declaration is still a spawn of THIS version of the definition, and
  // `empty` is spread by every such return — which is what makes the field impossible to forget.
  const plan = planDelegation(
    { task: "x", agent: "review" },
    {
      ownGrant: ["agent:review", "tool:read"],
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: new Map([["review", definition({ allowedTools: "Read Bash(git:*)" })]]),
    },
  );
  assert.equal(plan.ok, false);
  assert.ok(plan.definitionDigest?.sha256, "a refused spawn must still name what was refused");
});

test("ADR-0018: an ADR-0017 authorisation refusal carries NO digest", () => {
  // Deliberate, and the ordering is the reason: authorisation is decided before the file is read, so a
  // caller who was never allowed to spawn it learns nothing about its contents — not even its hash.
  const plan = planDelegation(
    { task: "x", agent: "review" },
    { ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: [], definitions: new Map([["review", definition()]]) },
  );
  assert.equal(plan.ok, false);
  assert.equal(plan.definitionDigest, undefined);
});

test("ADR-0016: the definition body becomes the child's system prompt", () => {
  const plan = planDelegation(
    { task: "review the diff", agent: "review" },
    {
      ownGrant: ["agent:review", "tool:read", "tool:grep"],
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: new Map([["review", definition()]]),
    },
  );
  const at = plan.args.indexOf("--append-system-prompt");
  assert.ok(at >= 0, "a spawned definition must carry its own instructions");
  assert.match(plan.args[at + 1], /Find what breaks\./);
  assert.equal(plan.args.at(-1), " review the diff", "the task still ends the argv (G1)");
});
