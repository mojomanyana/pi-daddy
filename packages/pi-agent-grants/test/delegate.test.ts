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
      ownGrant: ["tool:read", "tool:grep", "tool:bash"],
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
      ownGrant: ["tool:read"],
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
      ownGrant: ["tool:read", "tool:grep"],
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
      ownGrant: ["tool:read", "tool:bash"],
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

test("ADR-0016: the definition body becomes the child's system prompt", () => {
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
  const at = plan.args.indexOf("--append-system-prompt");
  assert.ok(at >= 0, "a spawned definition must carry its own instructions");
  assert.match(plan.args[at + 1], /Find what breaks\./);
  assert.equal(plan.args.at(-1), " review the diff", "the task still ends the argv (G1)");
});
