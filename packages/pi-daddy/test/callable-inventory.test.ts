import assert from "node:assert/strict";
import { test } from "node:test";
import { observeToolNames, deriveOwnGrant } from "../src/kernel/propagation.ts";
import { planDelegation } from "../src/kernel/delegate.ts";

test("native callable inventory survives hidden provider declarations without widening inherited authority", () => {
  const names = observeToolNames(
    { tools: [{ name: "principal_codemode" }] },
    [
      { name: "read", exposure: "direct" },
      { name: "bash", exposure: "direct" },
      { name: "lookup", exposure: "codemode" },
      { name: "search", exposure: "deferred" },
      { name: "principal_codemode", exposure: "model-only" },
      { name: "secret", exposure: "hidden" },
    ],
    ["read", "principal_codemode", "secret"],
  );
  assert.deepEqual(names, ["read", "lookup", "search", "principal_codemode"]);
  const grant = deriveOwnGrant(["tool:read", "tool:lookup"], names);
  assert.deepEqual(grant, ["tool:lookup", "tool:read"]);
  assert.deepEqual(
    observeToolNames({ tools: [{ name: "read" }] }, [{ name: "bash" }], ["bash"]),
    ["read"],
    "older inventories without exposure preserve the provider-observation fallback",
  );
});

test("codemode is allowed only for read-only specialists; mutating children and principal_codemode stay blocked", () => {
  const readOnly = planDelegation(
    { task: "inspect", tools: ["read", "codemode"] },
    { ownGrant: ["tool:*"], gated: [], depth: 0, maxDepth: 4 },
  );
  assert.equal(readOnly.ok, true);
  assert.ok(readOnly.effective.includes("tool:codemode"));

  for (const tools of [
    ["read", "edit", "codemode"],
    ["read", "bash", "codemode"],
    ["ext:codemode"],
    ["principal_codemode"],
    ["ext:principal_codemode"],
  ]) {
    const result = planDelegation(
      { task: "inspect", tools },
      { ownGrant: ["tool:*", "ext:*"], gated: [], depth: 0, maxDepth: 4 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.refusal?.code, "UNKNOWN_TOOL");
    assert.match(result.reason!, /read-only specialists|only for the coordinator/);
  }
});
