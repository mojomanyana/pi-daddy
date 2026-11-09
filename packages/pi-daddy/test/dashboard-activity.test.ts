import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { registerDashboardLive } from "../extensions/dashboard-live.ts";
import { safeDashboardSummary, observedPurpose } from "../src/products/activity-summary.ts";
import { ActivityTimelineRecorder, parseActivityTimeline } from "../src/products/activity-timeline.ts";
import { activityStoryItems, activityTaskTitle, applyOwnerTaskTitles } from "../src/products/dashboard-activity.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";

after(cleanupTempDirs);

test("the parent's public assignment describes its exact child; metadata-only and legacy rows remain interpretable", async () => {
  const cwd = await tempDir("dashboard-public-summary-");
  for (const [mode, expected] of [
    ["on", "Check duplicate queue entries · investigate"],
    ["metadata-only", "investigate task"],
  ] as const) {
    const recorder = new ActivityTimelineRecorder(cwd, {
      PI_DADDY_ACTIVITY_ROOT: mode,
      PI_DADDY_ACTIVITY_CONTENT: mode,
    });
    await recorder.childStarted(
      "child",
      "parent",
      "investigate",
      "private source and file names",
      undefined,
      undefined,
      "Check duplicate queue entries",
    );
    await recorder.childFinished("child", "parent", "investigate", "private final", "completed");
    const text = await readFile(recorder.path, "utf8");
    const lines = text
      .trimEnd()
      .split("\n")
      .filter((line) => JSON.parse(line).body.rootId === mode);
    if (mode === "metadata-only") assert.doesNotMatch(lines.join(" "), /duplicate queue entries/);
    const task = parseActivityTimeline(text).tasks.find((t) => t.rootId === mode)!;
    assert.equal(activityTaskTitle(task), expected);
    const admitted = [{ key: "child", label: "investigate", status: "failed", elapsed: "0:04", details: [] }];
    const sibling = { ...task, rootId: "another-session", dashboardSummary: "PRIVATE OTHER ASSIGNMENT" };
    const joined = applyOwnerTaskTitles(admitted, [task, sibling], mode);
    assert.equal(joined[0]!.label, mode === "on" ? expected : "investigate");
    assert.equal(joined[0]!.status, "failed");
    assert.equal(applyOwnerTaskTitles([], [task], mode).length, 0);
    assert.doesNotMatch(text, /private source|private final/);
  }
});

test("one-line summaries exclude controls, paths, links and common credentials; ordinary tool arguments remain private", () => {
  for (const unsafe of [
    "Read /home/alice/private",
    "read C:\\Users\\Bob",
    "Review\nInjected",
    "look at https://example.com",
    "Bearer abc",
    "token=do-not-copy",
    "db9559a1c920fef748610be5982688d6a0e70a5e",
    "x".repeat(161),
  ])
    assert.equal(safeDashboardSummary(unsafe), undefined);
  assert.equal(
    observedPurpose("delegate", { dashboardSummary: "Check the queue", task: "never show this prompt" }, false),
    "Ask a subagent to work on a task",
  );
  assert.equal(observedPurpose("bash", { command: "npm test && cat Private" }, true), "Run a shell command");
  assert.equal(observedPurpose("bash", { command: "npm test" }, true), "Run the project tests");
  assert.equal(observedPurpose("read", { path: "/private/tenant/README.md" }, false), "Read the project guide");
  assert.equal(observedPurpose("read", { path: "/private/customer/tests/cache.spec.js" }, false), "Read a test file");
});

test("Activity pairs interleaved hooks by call and collapses repeated successes while exposing all raw observations", () => {
  const hooks = new Map<string, (evt: any, ctx: any) => void>();
  const owner = { sessionId: "s", cwd: "/work" };
  const ctx = { sessionManager: { getSessionId: () => "s" } };
  const snapshot = registerDashboardLive(
    { on: (name: string, handler: any) => hooks.set(name, handler) } as never,
    () => owner,
  );
  const emit = (name: string, evt: any) => hooks.get(name)!(evt, ctx);
  emit("agent_start", {});
  emit("tool_execution_start", {
    toolName: "delegate",
    toolCallId: "p",
    args: { task: "PRIVATE", dashboardSummary: "Review cache behavior" },
  });
  emit("tool_execution_start", { toolName: "bash", toolCallId: "x", args: { command: "npm test" } });
  assert.equal(snapshot().turn?.label, "Run the project tests");
  emit("tool_execution_start", { toolName: "bash", toolCallId: "y", args: { command: "secret-cmd" } });
  emit("tool_execution_end", { toolName: "bash", toolCallId: "y", isError: true, result: "PRIVATE" });
  assert.equal(snapshot().turn?.label, "Run the project tests");
  emit("tool_execution_end", { toolName: "bash", toolCallId: "x", isError: false });
  assert.equal(snapshot().turn?.label, "Review cache behavior");
  emit("tool_execution_end", { toolName: "delegate", toolCallId: "p", isError: false });
  assert.equal(snapshot().turn?.label, "Pi is working on your request");
  for (const id of ["r1", "r2"]) {
    emit("tool_execution_start", { toolName: "read", toolCallId: id, args: { path: "PRIVATE" } });
    emit("tool_execution_end", { toolName: "read", toolCallId: id, isError: false });
  }
  emit("agent_end", {});
  const view = snapshot(),
    rows = activityStoryItems(view.activity, "owner", false);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|secret-cmd/);
  assert.deepEqual(
    rows.map((r) => [r.label, r.status]),
    [
      ["Pi finished its turn", "observed"],
      ["Read a project file (×2)", "finished"],
      ["Review cache behavior", "finished"],
      ["Run the project tests", "finished"],
      ["Run a shell command", "failed"],
      ["Pi started a turn", "observed"],
    ],
  );
  assert.equal(rows[1]!.details.length, 4);
  assert.equal(rows[1]!.details.filter((d) => d.includes("read: tool start")).length, 2);
  assert.ok(activityStoryItems(view.activity, "owner", true).every((r) => r.status === "last-observed"));
  emit("agent_start", {});
  emit("tool_execution_start", { toolName: "bash", toolCallId: "known", args: { command: "npm test" } });
  emit("tool_execution_start", { toolName: "bash" });
  emit("tool_execution_end", { toolName: "bash" });
  assert.equal(snapshot().turn?.label, "Pi is working on your request");
  const last = snapshot().activity.at(-1)!;
  assert.ok(!last.details?.some((line) => line.startsWith("Call: ")));
});
