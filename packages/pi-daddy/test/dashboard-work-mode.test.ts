import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkModeSnapshot } from "../src/kernel/work-mode.ts";
import type { DashboardOwnerObservation } from "../src/kernel/dashboard-observation.ts";
import type { DashboardSettingsSnapshot } from "../src/products/dashboard-settings.ts";
import { dashboardSettingsLines, visibleSettingKeys } from "../src/products/dashboard-settings.ts";
import {
  availableWorkMode,
  openWorkModeEditor,
  workModeEditAction,
  workModeEditorKey,
  workModeEditorLines,
  workModeOverview,
} from "../src/products/dashboard-work-mode.ts";
import { createDashboardDisplayControls } from "../src/products/dashboard-display-controls.ts";
import { renderDashboardScreen } from "../src/products/dashboard-screen.ts";
import { cellWidth } from "../src/products/dashboard-render.ts";
import { createDashboardConnection, type DashboardSessionSnapshot } from "../src/products/dashboard-session-client.ts";

const owner = { sessionId: "owner", cwd: "/work", generation: "generation-one" };
const standard = (): WorkModeSnapshot => ({
  available: true,
  inherited: false,
  selection: { mode: "standard", emphases: [] },
});
function settings(workMode?: WorkModeSnapshot): DashboardSettingsSnapshot {
  return {
    editable: true,
    wallSeconds: 21600,
    idleSeconds: 900,
    wallSource: "startup",
    idleSource: "startup",
    descendants: 8,
    reserved: 0,
    maxDepth: 2,
    perCall: 8,
    jev: { available: false, enabled: false, pending: false },
    ...(workMode ? { workMode } : {}),
  };
}
function snapshot(sequence = 1, workMode = standard()): DashboardSessionSnapshot {
  return {
    rows: [],
    cost: null,
    auto: { enabled: false, source: "session" },
    pendingApprovals: [],
    settings: settings(workMode),
    observation: {
      version: 1,
      ...owner,
      sequence,
      observedAt: "2026-11-19T12:00:00Z",
      capture: { transcripts: false, diagnostics: false },
      resources: { scope: "owner-process", sampledAt: "2026-11-19T12:00:00Z", rssBytes: 0, hostHealth: "unknown" },
      activity: [],
      artifacts: [],
      sources: [],
    } as DashboardOwnerObservation,
  };
}

test("Work mode is an optional separate group; older snapshots keep their existing controls", () => {
  const old = settings();
  assert.doesNotMatch(dashboardSettingsLines(old, false, "auto", 100).join("\n"), /WORK MODE/);
  assert.deepEqual(workModeOverview(undefined), []);
  assert.equal(openWorkModeEditor(undefined, owner), undefined);
  assert.equal(visibleSettingKeys(old.jev).includes("work-mode"), false);
  const mode = standard();
  const text = dashboardSettingsLines(settings(mode), false, "work-mode", 100).join("\n");
  assert.ok(text.indexOf("PERMISSIONS") < text.indexOf("WORK MODE"));
  assert.ok(text.indexOf("WORK MODE") < text.indexOf("JEV"));
  assert.match(text, /Standard: Current behavior/);
  assert.match(text, /Active now: Idle/);
  assert.match(text, /resets to Standard after \/new/);
  assert.deepEqual(visibleSettingKeys(old.jev, false, true).slice(0, 3), ["auto", "work-mode", "jev"]);
  for (const malformed of [
    {},
    { ...mode, selection: { mode: "standard", emphases: ["depth"] } },
    { ...mode, active: { mode: "future", emphases: [] } },
  ]) {
    assert.equal(availableWorkMode(malformed as WorkModeSnapshot), undefined);
    assert.doesNotThrow(() => workModeOverview(malformed as WorkModeSnapshot));
  }
});

test("the editor combines emphases locally and only explicit Apply creates an authenticated action", () => {
  const mode = standard();
  const editor = openWorkModeEditor(mode, owner)!;
  assert.equal(workModeEditorKey(editor, "return"), undefined);
  assert.equal(editor.selection.mode, "ambitious");
  assert.match(workModeEditorLines(editor).join("\n"), /None selected: balanced; Pi chooses useful directions/);
  editor.selected = "speed";
  workModeEditorKey(editor, " ");
  editor.selected = "depth";
  workModeEditorKey(editor, "return");
  editor.selected = "scope";
  workModeEditorKey(editor, "return");
  assert.deepEqual(editor.selection.emphases, ["speed", "depth"]);
  assert.deepEqual(mode, standard(), "editing never mutates the owner observation");
  assert.match(workModeEditorLines(editor).join("\n"), /Expires after one request, including its children/);
  editor.selected = "apply";
  assert.equal(workModeEditorKey(editor, "return"), "apply-work-mode");
  assert.deepEqual(workModeEditAction(editor, mode, owner), {
    action: "set-work-mode",
    selection: { mode: "ambitious", emphases: ["speed", "depth"] },
    scope: "next-request",
    expectedOwner: owner,
  });
  editor.busy = true;
  assert.equal(workModeEditorKey(editor, "return"), undefined, "a pending Apply cannot submit twice");
  editor.busy = false;
  const display = createDashboardDisplayControls(false, true);
  display.screen.view = "work-mode";
  display.screen.workModeEditor = editor;
  assert.equal(display.key("a"), undefined, "Auto shortcut cannot escape the draft editor");
  display.key("pagedown");
  assert.equal(display.screen.manualScroll, true);
  assert.equal(display.screen.offset, 8);
  display.key("up");
  assert.equal(display.screen.manualScroll, false, "selection restores automatic visibility after reading details");
  display.key("escape");
  assert.equal(display.screen.workModeEditor, undefined);
  assert.equal(display.screen.view, "settings");
  assert.deepEqual(mode, standard());
});

test("active and future mode are explicit and stale, disconnected or inherited drafts cannot apply", () => {
  const mode: WorkModeSnapshot = {
    ...standard(),
    active: { mode: "ambitious", emphases: ["depth"] },
    nextRequest: { mode: "ambitious", emphases: ["speed", "range"] },
  };
  const text = workModeOverview(mode).join("\n");
  assert.match(text, /Active now: Ambitious.*Deeper proof/);
  assert.match(text, /Session default: Standard/);
  assert.match(text, /Next request only: Ambitious.*Faster delivery.*Broader approaches/);
  const editor = openWorkModeEditor(mode, owner)!;
  assert.equal(editor.scope, "next-request");
  assert.equal(workModeEditAction(editor, mode, { ...owner, generation: "new-owner" }), undefined);
  assert.match(editor.error!, /Session changed or disconnected/);
  assert.equal(workModeEditAction(editor, undefined, owner), undefined);
  assert.equal(workModeEditAction(editor, { ...mode, inherited: true }, owner), undefined);
  assert.equal(openWorkModeEditor({ ...mode, inherited: true }, owner), undefined);
  assert.match(
    dashboardSettingsLines(settings({ ...mode, inherited: true }), false, "work-mode", 100).join("\n"),
    /Inherited from the parent; read-only/,
  );
});

test("narrow and wide frames keep the selected Apply visible without treating mode as progress", () => {
  const display = createDashboardDisplayControls(false, true);
  const current = snapshot();
  const render = (width: number, height: number) =>
    renderDashboardScreen({ width, height, screen: display.screen, items: [], session: current, connected: true });
  assert.match(render(120, 30), /Work mode · Session: Standard/);
  assert.doesNotMatch(render(120, 30), /Needs you/);
  display.screen.view = "work-mode";
  display.screen.workModeEditor = openWorkModeEditor(standard(), owner)!;
  workModeEditorKey(display.screen.workModeEditor, "return");
  display.screen.workModeEditor.selected = "apply";
  for (const [width, height] of [
    [28, 12],
    [42, 16],
    [80, 24],
    [130, 35],
  ]) {
    const frame = render(width!, height!);
    assert.equal(frame.split("\n").length, height);
    assert.ok(frame.split("\n").every((line) => cellWidth(line) <= width!));
    assert.match(frame, /> Apply work mode/);
  }
});

test("connection applies only a matching owner acknowledgment and supplies the observed generation", async () => {
  for (const response of ["good", "missing", "changed"] as const) {
    const calls: unknown[] = [];
    const connection = createDashboardConnection(async (action) => {
      calls.push(action);
      if (action.action === "get") return snapshot();
      const reply = { ...snapshot(2), ...(response !== "missing" ? { workModeApplied: true as const } : {}) };
      if (response === "changed") reply.observation = { ...reply.observation!, generation: "other" };
      return reply;
    });
    await connection.refresh();
    assert.equal(
      await connection.change({
        action: "set-work-mode",
        selection: { mode: "ambitious", emphases: ["depth"] },
        scope: "next-request",
      }),
      response === "good",
    );
    assert.deepEqual((calls[1] as { expectedOwner: unknown }).expectedOwner, owner);
    assert.equal(connection.state.acknowledgment?.state, response === "good" ? "applied" : "unconfirmed");
    if (response !== "good") assert.equal(connection.state.snapshot, undefined);
  }
});
