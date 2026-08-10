import assert from "node:assert/strict";
import { test } from "node:test";
import { DELEGATE_CAPABILITY, normaliseCapability, planDelegation } from "../src/delegate.ts";
import { ENV_DEPTH, ENV_GRANT, ENV_MAX_DEPTH } from "../src/propagation.ts";

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
