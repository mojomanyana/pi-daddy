import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { registerActivityTimeline, type ActivitySessionState } from "../extensions/activity-timeline.ts";
import {
  ActivityTimelineAliases,
  ActivityTimelineRecorder,
  activityTaskKey,
  defaultActivityTimelinePath,
  detailForTimeline,
  parseActivityTimeline,
  renderActivityTimeline,
} from "../src/products/activity-timeline.ts";
import { activityDashboardItems } from "../src/products/dashboard-screen.ts";
import { recordLinesOf } from "./record-fixtures.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

// Removing the custom-trigger branch makes the extension turn empty or assigns the queued user.
test("custom starts retain their own text and origin between user turns, including early cancellation", async () => {
  const cwd = await tempDir("activity-custom-"),
    hooks = new Map<string, Function>();
  const branch: Array<Record<string, unknown>> = [];
  const context = { cwd, sessionManager: { getBranch: () => branch }, ui: { notify() {} } };
  const state: ActivitySessionState = { activityRootId: "custom-root" };
  registerActivityTimeline({ on: (name: string, fn: Function) => hooks.set(name, fn) } as never, state, false);
  const emit = async (name: string, event: unknown = {}) => await hooks.get(name)!(event, context);
  await emit("session_start");
  await emit("before_agent_start", { prompt: "legacy prompt" });
  branch.push({ id: "old-user", type: "message", message: { role: "user", content: "finalized user" } });
  await emit("context");
  await emit("agent_settled");

  for (const cancelled of [false, true]) {
    await emit("before_agent_start", {
      messageType: "custom",
      message: {
        role: "custom",
        customType: "timer:tick",
        content: [
          { type: "text", text: cancelled ? "cancelled custom" : "custom " },
          { type: "image", data: "private-image" },
          { type: "text", text: cancelled ? "" : "content" },
        ],
        details: { private: "not-retained" },
      },
    });
    // Messages queued during before_agent_start may be persisted before the starting message.
    branch.push({
      id: `queued-custom-${cancelled}`,
      type: "custom_message",
      customType: "timer:tick",
      content: "unrelated custom",
    });
    branch.push({ id: `queued-user-${cancelled}`, type: "message", message: { role: "user", content: "queued user" } });
    await emit("message_end", { message: { role: "user", content: "queued user" } });
    if (!cancelled) await emit("context");
    await emit("agent_settled", { aborted: cancelled });
  }
  await emit("before_agent_start", { messageType: "user", prompt: "new user" });
  await emit("context");
  await emit("agent_settled");
  const path = defaultActivityTimelinePath(cwd),
    raw = await readFile(path, "utf8");
  await emit("before_agent_start", { messageType: "unsupported" });
  await emit("agent_settled");
  assert.equal(await readFile(path, "utf8"), raw, "unknown triggers cannot finish the prior task again");
  assert.equal(state.activity?.taskId, undefined);
  const timeline = parseActivityTimeline(raw);
  assert.deepEqual(
    timeline.tasks.map((task) => task.trigger),
    [
      { type: "user" },
      { type: "custom", customType: "timer:tick" },
      { type: "custom", customType: "timer:tick" },
      { type: "user" },
    ],
  );
  assert.deepEqual(
    await Promise.all(
      timeline.tasks.map(
        async (task) => (await detailForTimeline(path, activityTaskKey(task.rootId, task.id), "prompt")).text,
      ),
    ),
    ["finalized user", "custom content", "cancelled custom", "new user"],
  );
  assert.equal(timeline.tasks[2].status, "cancelled");
  assert.doesNotMatch(raw, /private-image|not-retained/);
  const items = activityDashboardItems(timeline, new ActivityTimelineAliases(), new Date());
  assert.match(items[0].label, /^User turn/);
  assert.match(items[1].label, /^Extension turn/);
  assert.ok(items[1].details.includes("Trigger: extension message (timer:tick)"));
  assert.match(renderActivityTimeline(timeline, { details: true }), /EXT Extension turn/);
});

// Routing custom text through a second store, or retaining it in metadata, makes these checks fail.
test("custom content obeys the existing metadata-only and observation-off policies", async () => {
  for (const policy of ["metadata-only", "off"]) {
    const cwd = await tempDir("activity-custom-retention-");
    const recorder = new ActivityTimelineRecorder(
      cwd,
      policy === "off" ? { PI_DADDY_ACTIVITY_TIMELINE: "off" } : { PI_DADDY_ACTIVITY_CONTENT: "metadata-only" },
    );
    await recorder.start("private custom body", undefined, undefined, undefined, {
      type: "custom",
      customType: "heartbeat",
    });
    const path = defaultActivityTimelinePath(cwd);
    if (policy === "off") {
      await assert.rejects(readFile(path), { code: "ENOENT" });
      continue;
    }
    const raw = await readFile(path, "utf8"),
      task = parseActivityTimeline(raw).tasks[0];
    assert.equal(task.prompt?.bytes, Buffer.byteLength("private custom body"));
    assert.equal(task.prompt?.ref, undefined);
    assert.equal(task.trigger?.type, "custom");
    assert.doesNotMatch(raw, /private custom body/);
    await assert.rejects(readdir(join(dirname(path), "content")), { code: "ENOENT" });
  }
});

test("historical activity stays readable while malformed trigger attribution is refused", () => {
  const event = {
    version: 1,
    id: "event",
    kind: "task_started",
    at: "2026-10-27T10:00:00Z",
    rootId: "root",
    taskId: "task",
  };
  const historical = parseActivityTimeline(recordLinesOf("activity", event));
  assert.equal(historical.refusals.length, 0);
  assert.equal(historical.tasks[0].trigger, undefined);
  for (const trigger of [{ type: "human-approval" }, { type: "custom" }, { type: "custom", customType: 42 }]) {
    const invalid = parseActivityTimeline(recordLinesOf("activity", { ...event, trigger }));
    assert.equal(invalid.tasks.length, 0);
    assert.equal(invalid.refusals.length, 1);
  }
});

test("rejected root starts cannot attach tools to the previous turn; native string custom types are preserved", async () => {
  const cwd = await tempDir("activity-rejected-start-"),
    hooks = new Map<string, Function>();
  const context = { cwd, ui: { notify() {} } };
  registerActivityTimeline({ on: (name: string, fn: Function) => hooks.set(name, fn) } as never, undefined, false);
  const emit = async (name: string, event: unknown = {}) => await hooks.get(name)!(event, context);
  await emit("session_start");
  const run = async (event: unknown) => {
    await emit("before_agent_start", event);
    await emit("context");
    await emit("tool_execution_start", { toolName: "read", toolCallId: "tool" });
    await emit("tool_execution_end", { toolName: "read", toolCallId: "tool" });
    await emit("agent_settled");
  };
  await run({ prompt: "previous user" });
  const path = defaultActivityTimelinePath(cwd),
    before = await readFile(path, "utf8");
  for (const event of [
    { messageType: "unsupported" },
    { messageType: "custom", message: { customType: 42, content: "invalid" } },
    { messageType: "custom", message: { customType: "x".repeat(20000), content: "over event bound" } },
  ]) {
    await run(event);
    assert.equal(await readFile(path, "utf8"), before, "rejected observation cannot append to any task");
  }
  for (const customType of ["", "x".repeat(201)])
    await run({ messageType: "custom", message: { customType, content: "accepted custom" } });
  await run({ messageType: "user", prompt: "next user" });
  const tasks = parseActivityTimeline(await readFile(path, "utf8")).tasks;
  assert.equal(tasks.length, 4);
  assert.deepEqual(
    tasks.map((task) => task.trigger),
    [
      { type: "user" },
      { type: "custom", customType: "" },
      { type: "custom", customType: "x".repeat(201) },
      { type: "user" },
    ],
  );
  assert.equal(
    (await detailForTimeline(path, activityTaskKey(tasks[3].rootId, tasks[3].id), "prompt")).text,
    "next user",
  );
});
