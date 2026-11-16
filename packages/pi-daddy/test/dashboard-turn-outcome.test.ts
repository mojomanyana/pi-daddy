import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { registerActivityTimeline, type ActivitySessionState } from "../extensions/activity-timeline.ts";
import { registerDashboardLive } from "../extensions/dashboard-live.ts";
import {
  ActivityTimelineAliases,
  ActivityTimelineRecorder,
  defaultActivityTimelinePath,
  parseActivityTimeline,
} from "../src/products/activity-timeline.ts";
import { activityStoryItems } from "../src/products/dashboard-activity.ts";
import { needsUserInput, sessionDashboardItems } from "../src/products/dashboard-panels.ts";
import {
  activityDashboardItems,
  dashboardScreenState,
  renderDashboardScreen,
  type DashboardScreenOptions,
} from "../src/products/dashboard-screen.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

async function fixture() {
  const cwd = await tempDir("dashboard-turn-outcome-");
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const api = {
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerTool() {},
  };
  const state: ActivitySessionState = { activityRootId: "root-session" };
  const owner = { sessionId: "session", cwd };
  const ctx = {
    cwd,
    model: { id: "fixture-model" },
    ui: { notify() {} },
    sessionManager: { getSessionId: () => owner.sessionId, getBranch: () => [] },
  };
  registerActivityTimeline(api as never, state);
  const live = registerDashboardLive(api as never, () => owner);
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
  };
  await emit("session_start");
  await emit("before_agent_start", { prompt: "Build the workshop backend" });
  await emit("context");
  await emit("agent_start");
  return {
    state,
    emit,
    live,
    async call(toolName: string, toolCallId: string, args: unknown, isError: boolean) {
      await emit("tool_execution_start", { toolName, toolCallId, args });
      await emit("tool_execution_end", { toolName, toolCallId, isError });
    },
    async child() {
      const recorder = new ActivityTimelineRecorder(cwd, { PI_DADDY_ACTIVITY_ROOT: state.activityRootId });
      await recorder.childStarted("real-child", state.activity!.taskId, "build", "Earlier completed work");
      await recorder.childFinished("real-child", state.activity!.taskId, "build", "Delivered", "completed");
    },
    async finish() {
      await emit("message_end", { message: { role: "assistant", content: "Stopped here", stopReason: "stop" } });
      await emit("agent_end");
      await emit("agent_settled");
    },
    async options(): Promise<DashboardScreenOptions> {
      const timeline = parseActivityTimeline(await readFile(defaultActivityTimelinePath(cwd), "utf8"));
      const now = new Date();
      return {
        width: 110,
        height: 35,
        screen: dashboardScreenState(),
        connected: true,
        now,
        items: activityDashboardItems(timeline, new ActivityTimelineAliases(), now, true),
        session: {
          activity: state.activity as { rootId: string; path: string; taskId: string },
          auto: { enabled: true, source: "session" },
          pendingApprovals: [],
          rows: [],
          cost: null,
          observation: {
            version: 1,
            ...owner,
            generation: "owner",
            sequence: 1,
            observedAt: now.toISOString(),
            resources: { scope: "owner-process", sampledAt: now.toISOString(), rssBytes: 0, hostHealth: "unknown" },
            capture: { diagnostics: false, transcripts: false },
            sources: [],
            ...live(),
          },
        },
      };
    },
  };
}

test("a parent ending after refused actions does not present its last action as delivered work", async () => {
  const app = await fixture();
  await app.call("delegate", "refused-build", { agent: "build" }, true);
  await app.call("principal_workflow", "refused-status", { action: "status" }, true);
  await app.finish();
  const options = await app.options();
  assert.equal(options.items.length, 1, "tool refusals cannot invent a child execution");
  assert.equal(options.items[0]!.status, "turn-ended");
  assert.equal(options.items[0]!.label, "Pi turn ended");
  assert.ok(options.items[0]!.details.includes("Last action: Manage a workflow step"));
  const stories = activityStoryItems(app.live().activity, "owner", false);
  assert.deepEqual(
    stories.filter((item) => item.status === "failed").map((item) => item.label),
    ["Manage a workflow step", "Ask a subagent to implement a change"],
  );
  for (const destination of ["now", "work"] as const) {
    options.screen.destination = destination;
    const frame = renderDashboardScreen(options);
    assert.match(frame, /Pi turn ended · Ended/);
    assert.doesNotMatch(frame, /Manage a workflow step · Finished|build · Finished|Needs your/);
    assert.ok(sessionDashboardItems(options).every((item) => !needsUserInput(item)));
  }
});

test("a recovered turn and an actual earlier child keep separate outcomes", async () => {
  const app = await fixture();
  await app.child();
  await app.call("principal_workflow", "bad-input", { action: "status" }, true);
  await app.call("principal_workflow", "corrected-input", { action: "inspect" }, false);
  await app.finish();
  const options = await app.options();
  assert.equal(options.items.filter((item) => item.status === "turn-ended").length, 1);
  assert.equal(options.items.filter((item) => item.status === "finished" && item.agent).length, 1);
  const frame = renderDashboardScreen(options);
  assert.match(frame, /Pi turn ended · Ended/);
  assert.match(frame, /build task · Finished/);
  const stories = activityStoryItems(app.live().activity, "owner", false);
  assert.ok(stories.some((item) => item.label === "Manage a workflow step" && item.status === "failed"));
  assert.ok(stories.some((item) => item.label === "Check the state of a workflow step" && item.status === "finished"));
  assert.ok(sessionDashboardItems(options).every((item) => !needsUserInput(item)));
  options.session!.pendingApprovals.push({ id: "permission", subject: "build", capability: "tool:write" });
  assert.match(renderDashboardScreen(options), /Needs your permission/);
});

test("live-only parent observation has the same neutral ending and retains purposeful running labels", async () => {
  const app = await fixture();
  await app.emit("tool_execution_start", {
    toolName: "principal_workflow",
    toolCallId: "prepare",
    args: { action: "prepare" },
  });
  const running = await app.options();
  assert.match(renderDashboardScreen(running), /Prepare the next step · Running/);
  await app.emit("tool_execution_end", { toolName: "principal_workflow", toolCallId: "prepare", isError: true });
  await app.finish();
  const ended = await app.options();
  ended.items = [];
  assert.match(renderDashboardScreen(ended), /Pi turn ended · Ended/);
  assert.ok(sessionDashboardItems(ended).every((item) => !needsUserInput(item)));
  ended.connected = false;
  const stale = sessionDashboardItems(ended);
  assert.ok(stale.every((item) => item.status === "last-observed"));
});
