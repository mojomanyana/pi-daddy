import assert from "node:assert/strict";
import test from "node:test";
import { planDelegation } from "../src/kernel/delegate.ts";
import { childToolDeliveryRefusal, snapshotChildTools } from "../src/kernel/child-tools.ts";
import { shouldSeekApproval } from "../src/kernel/approval.ts";
import { classifyToolNames, makeCatalog } from "../src/kernel/catalog.ts";

const builtin = (name: string) => ({ name, sourceInfo: { source: "builtin", path: `builtin:${name}` } });
const context = (sources = [builtin("read"), builtin("write")]) => ({
  ownGrant: ["tool:read", "tool:write", "tool:scout_research"],
  depth: 0,
  maxDepth: 2,
  gated: ["tool:write"],
  childToolSources: sources,
  catalog: makeCatalog(classifyToolNames(["read", "write", "scout_research"])),
});

test("parent-visible external tools refuse before permission resolution, not after a silently narrowed launch", () => {
  const plan = planDelegation(
    { task: "research then write", tools: ["write", "scout_research"] },
    context([
      builtin("write"),
      { name: "scout_research", sourceInfo: { source: "package", path: "/selected/scout.ts" } },
    ]),
  );
  assert.equal(plan.ok, false);
  assert.equal(plan.refusal?.code, "UNKNOWN_TOOL");
  assert.equal(plan.refusal?.details?.kind, "child-tool-unavailable");
  assert.match(plan.reason!, /scout_research/);
  assert.equal(shouldSeekApproval(plan.result), false);
  assert.deepEqual(plan.args, []);
});

test("native origins retain the exact allowlist and do not bypass permissions", () => {
  const plan = planDelegation({ task: "read", tools: ["read"] }, context());
  assert.equal(plan.ok, true);
  assert.equal(plan.args[plan.args.indexOf("--tools") + 1], "read");
  assert.ok(plan.args.includes("--no-extensions"));
  assert.ok(!plan.args.includes("-e"));
  const write = planDelegation({ task: "write", tools: ["write"] }, context());
  assert.equal(write.refusal?.code, "GATED_UNAPPROVED");
  assert.equal(shouldSeekApproval(write.result), true);
});

test("missing, duplicate, mismatched, overridden and synthetic tool origins never become native delivery", () => {
  for (const sources of [
    [],
    [{ name: "read" }],
    [builtin("read"), builtin("read")],
    [{ name: "read", sourceInfo: { source: "builtin", path: "builtin:write" } }],
    [{ name: "read", sourceInfo: { source: "package", path: "/override.ts" } }],
    [{ name: "read", sourceInfo: { source: "sdk", path: "<sdk:read>" } }],
  ])
    assert.equal(planDelegation({ task: "read", tools: ["read"] }, context(sources as never)).ok, false);
  for (const name of ["mcp", "codemode", "parallel", "edit-diff", "scout_research"])
    assert.ok(childToolDeliveryRefusal([`tool:${name}`], { childToolSources: [builtin(name)] }));
});

test("Daddy tools require their actual explicit entrypoint and the existing delegation capability", () => {
  const extensionPath = "/selected/grants.ts";
  const childToolSources = ["delegate", "delegate_all", "delegate_chain", "delegate_describe"].map((name) => ({
    name,
    sourceInfo: { source: "local", path: extensionPath },
  }));
  const ctx = {
    ...context(),
    extensionPath,
    childToolSources,
    catalog: undefined,
    ownGrant: childToolSources.map(({ name }) => `tool:${name}`),
  };
  const plan = planDelegation({ task: "coordinate", tools: ["delegate", "delegate_chain"] }, ctx);
  assert.equal(plan.ok, true);
  assert.equal(plan.args[plan.args.indexOf("-e") + 1], extensionPath);
  assert.equal(plan.args[plan.args.indexOf("--tools") + 1], "delegate,delegate_chain");
  assert.equal(planDelegation({ task: "coordinate", tools: ["delegate_chain"] }, ctx).ok, false);
  assert.equal(
    planDelegation({ task: "coordinate", tools: ["delegate"] }, { ...ctx, extensionPath: undefined }).ok,
    false,
  );
  assert.equal(
    planDelegation({ task: "coordinate", tools: ["delegate"] }, { ...ctx, extensionPath: "/other.ts" }).ok,
    false,
  );
});

test("unavailable tools cannot turn existing permission into delivery or erase authority denials", () => {
  const plan = planDelegation(
    { task: "research", tools: ["scout_research"] },
    {
      ...context(),
      approved: [{ capability: "tool:scout_research", subject: "<delegate>", scope: "session" }],
    },
  );
  assert.equal(plan.ok, false);
  const denied = planDelegation(
    { task: "research", tools: ["scout_research"] },
    { ...context(), ownGrant: ["tool:read"] },
  );
  assert.equal(denied.refusal?.code, "CAPABILITY_ESCALATION");
  assert.deepEqual(denied.result.denied, ["tool:scout_research"]);
});

test("source snapshots are copied and frozen; non-tool capabilities and ext aliases do not widen delivery", () => {
  const input = [builtin("read")];
  const copied = snapshotChildTools(input);
  input[0].sourceInfo.path = "/override.ts";
  assert.equal(copied[0].sourceInfo?.path, "builtin:read");
  assert.ok(Object.isFrozen(copied[0].sourceInfo));
  assert.equal(
    childToolDeliveryRefusal(["agent:build", "skill:review", "context:files"], { childToolSources: [] }),
    undefined,
  );
  assert.ok(childToolDeliveryRefusal(["ext:scout/scout_research"], { childToolSources: [] }));
  assert.ok(
    childToolDeliveryRefusal(["tool:scout_research"], {}),
    "legacy pure callers still cannot promise external tools",
  );
});
