import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { dashboardFrame } from "../src/products/dashboard-cli.ts";
import { createDashboardDisplayControls } from "../src/products/dashboard-display-controls.ts";
import { cellWidth } from "../src/products/dashboard-render.ts";
import { activityDashboardItems, renderDashboardScreen, type DashboardItem } from "../src/products/dashboard-screen.ts";
import { createDashboardConnection, type DashboardSessionSnapshot } from "../src/products/dashboard-session-client.ts";
import {
  ActivityTimelineAliases,
  ActivityTimelineRecorder,
  defaultActivityTimelinePath,
  parseActivityTimeline,
  activityTaskKey,
} from "../src/products/activity-timeline.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
const snapshot = (enabled = false): DashboardSessionSnapshot => ({
  rows: [{ definition: "build", model: "provider/private-model-setting", thinking: "high", source: "session/session" }],
  cost: null,
  auto: { enabled, source: "session" },
  pendingApprovals: [{ id: "approval-one", subject: "build", capability: "tool:bash" }],
});
const tasks: DashboardItem[] = Array.from({ length: 14 }, (_, i) => ({
  key: `task-${i}`,
  taskKey: `root:task-${i}`,
  label: `build ${i} 界`,
  status: i < 5 ? "running" : "completed",
  elapsed: "0:42",
  details: [`Task ${i} detail`],
  agent: true,
  skills: i === 0,
}));

test("split-pane screens preserve permission, current work, actual approvals, and controls within both viewports", () => {
  for (const [width, height] of [
    [42, 16],
    [80, 24],
  ]) {
    const display = createDashboardDisplayControls(false, true);
    const frame = renderDashboardScreen({
      width,
      height,
      screen: display.screen,
      items: tasks,
      session: snapshot(),
      current: "Fix the dashboard",
    });
    const lines = frame.split("\n");
    assert.equal(lines.length, height);
    assert.ok(lines.every((line) => cellWidth(line) <= width));
    assert.match(lines[0], /PI DADDY \| Auto OFF.*\[a\]/);
    assert.match(frame, /NEEDS YOU[\s\S]*build · bash +Needs you/);
    assert.match(frame, /CURRENT REQUEST\nFix the dashboard/);
    assert.match(frame, /5 active/);
    assert.match(frame, /build 0 界 +Running/);
    assert.match(lines.at(-2)!, /Enter details/);
    assert.match(lines.at(-1)!, /m models/);
    assert.doesNotMatch(frame, /private-model-setting|%|build 5 界/);
  }
});

test("single keys keep stable selection through updates and give queue, models, help, and private-detail navigation", () => {
  const display = createDashboardDisplayControls(false, true);
  const draw = (items = tasks) =>
    renderDashboardScreen({
      width: 42,
      height: 16,
      screen: display.screen,
      items,
      session: snapshot(),
      ...display.state,
    });
  draw();
  display.key("down");
  const selected = display.screen.selectedKey;
  draw([{ ...tasks[1], key: "new-task" }, ...tasks]);
  assert.equal(display.screen.selectedKey, selected);
  display.key("p");
  assert.equal(display.state.activityDetail?.taskKey, tasks.find((item) => item.key === selected)?.taskKey);
  display.key("escape");
  assert.equal(display.state.activityDetail, undefined);
  display.key("tab");
  display.key("tab");
  display.key("tab");
  assert.match(draw(), /build · bash +Needs you/);
  assert.deepEqual(
    display.screen.items.map((item) => item.key),
    ["approval:approval-one"],
  );
  display.key("m");
  assert.match(draw(), /private-model-setting/);
  display.key("?");
  display.screen.offset = 999;
  assert.match(draw(), /OFF does not cancel already admitted work/);
  assert.equal(display.key("a"), "auto");
  assert.equal(display.key(":"), "command");
  assert.equal(display.key("q"), "quit");
});

test("details wrap retained content and neutralize terminal controls without hiding later text", () => {
  const display = createDashboardDisplayControls(false, true);
  display.screen.view = "details";
  const frame = renderDashboardScreen({
    width: 42,
    height: 16,
    screen: display.screen,
    items: [tasks[0]],
    content: {
      title: "PRIVATE FINAL",
      text: "\u001b[2JFirst line\n" + "x".repeat(50) + " last word\n\u001b]0;injected-title\u0007safe tail",
    },
  });
  assert.doesNotMatch(frame, /\u001b|injected-title/);
  assert.match(frame, /last word/);
  assert.match(frame, /safe tail/);
  assert.ok(frame.split("\n").every((line) => cellWidth(line) <= 42));
});

test("Auto changes only after owner ACK, ignores stale polls, and exposes failure until a fresh owner read", async () => {
  let completePoll!: (value: DashboardSessionSnapshot) => void;
  let completeChange!: (value: DashboardSessionSnapshot) => void;
  let polls = 0,
    changes = 0,
    fail = false;
  const connection = createDashboardConnection(async (action) => {
    if (action.action === "get") {
      polls++;
      return polls === 2
        ? new Promise((resolve) => {
            completePoll = resolve;
          })
        : snapshot();
    }
    changes++;
    if (fail) throw Error("owner closed");
    return new Promise((resolve) => {
      completeChange = resolve;
    });
  });
  await connection.refresh();
  const poll = connection.refresh(),
    change = connection.change({ action: "set-auto", enabled: true });
  assert.equal(connection.state.snapshot?.auto.enabled, false);
  assert.equal(connection.state.pending, true);
  assert.equal(await connection.change({ action: "set-auto", enabled: true }), false);
  assert.equal(changes, 1);
  completeChange(snapshot(true));
  assert.equal(await change, true);
  completePoll(snapshot(false));
  await poll;
  assert.equal(connection.state.snapshot?.auto.enabled, true);
  fail = true;
  assert.equal(await connection.change({ action: "set-auto", enabled: false }), false);
  assert.equal(connection.state.snapshot, undefined);
  assert.match(connection.state.error!, /Control change not confirmed: owner closed/);
  await connection.refresh();
  assert.equal((connection.state.snapshot as DashboardSessionSnapshot | undefined)?.auto.enabled, false);
  assert.equal(connection.state.error, undefined);
});

test("owner activity enriches only its exact task; explicit selectors fail closed and metadata-only has no excerpt", async () => {
  const cwd = await tempDir("dashboard-owner-task-"),
    ledgerPath = join(cwd, "ledger.jsonl");
  await writeFile(ledgerPath, "");
  const owner = new ActivityTimelineRecorder(cwd, { PI_DADDY_ACTIVITY_ROOT: "owner-root" });
  await owner.start("Repair the current dashboard\u001b[2J safely");
  await owner.finish("owner final");
  const other = new ActivityTimelineRecorder(cwd, { PI_DADDY_ACTIVITY_ROOT: "other-root" });
  await other.start("unrelated private request");
  await other.finish("unrelated private final");
  const path = defaultActivityTimelinePath(cwd),
    task = parseActivityTimeline(await readFile(path, "utf8")).tasks.find((t) => t.rootId === "owner-root")!;
  const session = { ...snapshot(), pendingApprovals: [], activity: { rootId: task.rootId, taskId: task.id, path } };
  const display = createDashboardDisplayControls(false, true);
  const frame = () =>
    dashboardFrame({
      cwd,
      ledgerPath,
      width: 80,
      height: 24,
      screen: display.screen,
      session,
      activityAliases: display.aliases,
      ...display.state,
    });
  assert.match(await frame(), /LATEST REQUEST · Finished\nRepair the current dashboard safely/);
  assert.doesNotMatch(await frame(), /unrelated private|other-root|\u001b/);
  display.input("f r1/t1");
  assert.match(await frame(), /owner final/);
  display.input("p unknown-task");
  assert.match(await frame(), /Activity detail unavailable/);
  assert.doesNotMatch(await frame(), /PRIVATE PROMPT/);
  const metadata = new ActivityTimelineRecorder(cwd, {
    PI_DADDY_ACTIVITY_ROOT: "metadata-root",
    PI_DADDY_ACTIVITY_CONTENT: "metadata-only",
  });
  await metadata.start("must not be retained");
  const task2 = parseActivityTimeline(await readFile(path, "utf8")).tasks.find((t) => t.rootId === "metadata-root")!;
  session.activity = { rootId: task2.rootId, taskId: task2.id, path };
  display.key("escape");
  assert.match(await frame(), /CURRENT REQUEST\nUser turn/);
  assert.doesNotMatch(await frame(), /must not be retained|Repair the current dashboard/);
});

test("an explicitly selected activity envelope stays a timeline in compact and redirected views", async () => {
  const cwd = await tempDir("dashboard-explicit-timeline-");
  const recorder = new ActivityTimelineRecorder(cwd, { PI_DADDY_ACTIVITY_ROOT: "selected-root" });
  await recorder.childStarted("review-task", undefined, "Review", "private review prompt");
  const display = createDashboardDisplayControls(false, true);
  const options = { cwd, ledgerPath: defaultActivityTimelinePath(cwd) };
  const compact = await dashboardFrame({ ...options, width: 42, height: 16, screen: display.screen });
  assert.match(compact, /Review/);
  assert.doesNotMatch(compact, /corrupt|private review prompt/);
  assert.match(await dashboardFrame(options), /Review/);
});

test("Versions distinguishes loaded/installed drift and exposes only selected native management guidance", () => {
  const display = createDashboardDisplayControls(false, true);
  const session: DashboardSessionSnapshot = {
    ...snapshot(),
    versions: {
      checkedAt: "2026-10-09T10:00:00Z",
      rows: [
        {
          id: "pi",
          label: "Pi",
          loadedVersion: "1.0.4",
          installedVersion: "1.1.0",
          state: "reload-required",
          source: "npm",
          path: "/fixture/pi",
          commands: ["pi update"],
          note: "Restart Pi to load installed code.",
        },
        {
          id: "skill-harness",
          label: "Harness",
          loadedVersion: null,
          installedVersion: "0.26.1",
          state: "not-reported",
          source: "local",
          path: "/fixture/harness",
          commands: ["pi list"],
          note: "Loaded version was not reported.",
        },
      ],
    },
  };
  assert.equal(display.key("v"), undefined);
  const draw = () => renderDashboardScreen({ width: 42, height: 16, screen: display.screen, items: [], session });
  assert.match(draw(), /Pi: 1.0.4 -> 1.1.0/);
  assert.match(draw(), /Restart needed/);
  display.key("return");
  assert.match(draw(), /Restart Pi/);
  assert.match(draw(), /pi update/);
  assert.doesNotMatch(draw(), /fixture\/harness/);
  display.key("escape");
  assert.equal(display.screen.view, "versions");
  display.key("down");
  display.key("return");
  assert.match(draw(), /Loaded: not reported/);
  assert.match(draw(), /fixture\/harness/);
  assert.match(draw(), /pi list/);
});

test("finished history is explicitly requested and optional color preserves width and safe content", () => {
  const display = createDashboardDisplayControls(false, true);
  const options = {
    width: 42,
    height: 16,
    screen: display.screen,
    items: tasks.slice(5),
    session: snapshot(),
    current: "Last request",
    currentStatus: "finished",
  };
  const hidden = renderDashboardScreen(options);
  assert.match(hidden, /9 finished · h shows history/);
  assert.doesNotMatch(hidden, /build 5 界|HISTORY/);
  display.key("h");
  const shown = renderDashboardScreen({ ...options, ...display.state, color: true });
  assert.match(shown, /HISTORY/);
  assert.match(shown, /build 13 界/);
  assert.match(shown, /\u001b\[1;36mPI DADDY/);
  assert.ok(shown.split("\n").every((line) => cellWidth(line) <= 42));
});

test("observed tool activity shows actual cwd and silence without inventing a stall or approval", async () => {
  const cwd = await tempDir("dashboard-observed-"),
    recorder = new ActivityTimelineRecorder(cwd, {});
  await recorder.start("Review this candidate");
  await recorder.append("tool_started", { tool: "bash", cwd: "/actual/pilot" });
  const timeline = parseActivityTimeline(await readFile(recorder.path, "utf8"));
  const event = timeline.tasks[0].lastEvent!;
  const now = new Date(Date.parse(event.at) + 3_800_000);
  const items = activityDashboardItems(timeline, new ActivityTimelineAliases(), now);
  assert.match(items[0].observation!, /bash tool started · 1:03:20 ago/);
  assert.ok(items[0].details.includes("Working directory: /actual/pilot"));
  assert.equal(items[0].status, "active");
  const display = createDashboardDisplayControls(false, true);
  const frame = renderDashboardScreen({ width: 70, height: 16, screen: display.screen, items });
  assert.match(frame, /Observed: bash tool started · 1:03:20 ago/);
  assert.doesNotMatch(frame, /Stalled|APPROVE|Thinking/);
  await recorder.append("tool_finished", { tool: "bash", outcome: "completed" });
  const after = parseActivityTimeline(await readFile(recorder.path, "utf8"));
  assert.equal(after.tasks[0].lastEvent?.kind, "tool_finished");
  assert.equal(after.tasks[0].status, "active");
});
