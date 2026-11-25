import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseExecutor, EXECUTOR_KINDS } from "../src/executors/executor.ts";

test("chooseExecutor always selects captured subprocess across all OSs with zero external daemon dependency", () => {
  assert.deepEqual([...EXECUTOR_KINDS], ["process"]);
  const choice = chooseExecutor();
  assert.equal(choice.kind, "process");
  assert.equal(choice.refusal, undefined);
  assert.match(choice.disclosure, /subprocess/i);
});
