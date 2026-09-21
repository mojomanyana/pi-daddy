import assert from "node:assert/strict";
import { test } from "node:test";
import { activityChildEnv } from "../extensions/session.ts";
import {
  ENV_ACTIVITY_PARENT_TASK,
  ENV_ACTIVITY_PATH,
  ENV_ACTIVITY_ROOT,
  ENV_ACTIVITY_TASK,
} from "../src/products/activity-timeline.ts";

// ADR-0076: the kernel no longer imports the activity timeline; the composition layer hands it the child
// environment through `childEnv`. Production change that breaks this: dropping a key, or emitting keys
// when there is no turn identity or no child execution id (a child must never inherit a stale identity).
test("activityChildEnv emits the four observation keys only when both identities exist", () => {
  const hook = activityChildEnv({ rootId: "root-1", path: "/p/activity.jsonl", taskId: "turn-1" });
  assert.deepEqual(hook({ childExecutionId: "exec-1" }), {
    [ENV_ACTIVITY_PATH]: "/p/activity.jsonl",
    [ENV_ACTIVITY_ROOT]: "root-1",
    [ENV_ACTIVITY_TASK]: "exec-1",
    [ENV_ACTIVITY_PARENT_TASK]: "turn-1",
  });
  assert.deepEqual(hook({}), {});
  assert.deepEqual(activityChildEnv({ rootId: "root-1", path: "/p" })({ childExecutionId: "exec-1" }), {});
  assert.deepEqual(activityChildEnv(undefined)({ childExecutionId: "exec-1" }), {});
});
