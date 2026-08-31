import assert from "node:assert/strict";
import { test } from "node:test";
import { planDelegation } from "../src/delegate.ts";
import { isExecutionId, newExecutionId } from "../src/execution-id.ts";
import { ENV_EXECUTION_ID } from "../src/propagation.ts";

const context = {
  ownGrant: ["tool:read"],
  depth: 0,
  maxDepth: 2,
  gated: [],
  childSpawnId: "d0.1",
};

test("execution ids are globally unique occurrences, not logical tree positions", () => {
  const first = newExecutionId();
  const second = newExecutionId();
  assert.notEqual(first, second);
  assert.equal(isExecutionId(first), true);
  assert.equal(isExecutionId(second), true);
  assert.equal(isExecutionId("d0.1"), false);
});

test("a planned child receives its unique execution id through the governed environment", () => {
  const executionId = newExecutionId();
  const plan = planDelegation(
    { task: "inspect", tools: ["read"] },
    { ...context, childExecutionId: executionId },
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.env[ENV_EXECUTION_ID], executionId);
  assert.equal(plan.childId, "d0.1", "the readable logical position remains separate");
});
