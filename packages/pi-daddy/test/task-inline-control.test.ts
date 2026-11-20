import assert from "node:assert/strict";
import { test } from "node:test";
import { taskInlineControl } from "../extensions/task-inline-control.ts";

test("task controls hold new root inline work and permit history, inspection and independently governed children", async () => {
  let checks = 0;
  let stopped = true;
  const session = {
    depth: 0,
    taskDispatch: {
      captureInline: () => async () => {
        checks++;
        if (stopped) throw Error("Task dispatch is stopped. Inspect task controls before resuming.");
      },
    },
  };
  for (const name of ["write", "edit", "bash", "apply_patch"]) {
    assert.match((await taskInlineControl(name, session))!.reason, /paused or cancelled/);
  }
  for (const name of ["read", "ls", "find", "grep", "bookie_read", "delegate", "custom_edit"]) {
    assert.equal(await taskInlineControl(name, session), undefined);
  }
  assert.equal(await taskInlineControl("bash", { ...session, depth: 1, ownExecutionId: "child" }), undefined);
  assert.equal(checks, 4);
  stopped = false;
  assert.equal(await taskInlineControl("write", session), undefined);
  assert.equal(await taskInlineControl("write", { depth: 0 }), undefined);
  assert.equal(checks, 5);
});

test("unavailable task binding holds work without echoing provider details", async () => {
  const session = {
    depth: 0,
    taskDispatch: {
      captureInline: () => {
        throw Error("private detail");
      },
    },
  };
  const result = await taskInlineControl("edit", session);
  assert.equal(result?.block, true);
  assert.match(result!.reason, /selected task/);
  assert.doesNotMatch(result!.reason, /private detail/);
});
