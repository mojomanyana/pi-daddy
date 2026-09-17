import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  DASHBOARD_PROTOCOL_VERSION,
  dashboardActionFeedback,
  dashboardFrame,
} from "../src/dashboard-cli.ts";
import { createDashboardDisplayControls } from "../src/dashboard-display-controls.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { ActivityTimelineRecorder, defaultActivityTimelinePath, parseActivityTimeline } from "../src/activity-timeline.ts";

after(cleanupTempDirs);

test("the installed-style symlink actually invokes the dashboard bin", async () => {
  const cwd = await tempDir("dashboard-bin-");
  const link = join(cwd, "pi-daddy-dashboard");
  await symlink(join(import.meta.dirname, "..", "src", "dashboard-cli.ts"), link);
  const output = execFileSync(process.execPath, [link, "--once", "--no-color"], { cwd, encoding: "utf8" });
  assert.match(output, /pi-daddy is missing or its ledger is inactive/);
});

test("a plugin opened before pi-daddy explains exact setup without modifying pi", async () => {
  const cwd = await tempDir("dashboard-setup-");
  const frame = await dashboardFrame({ cwd, color: false, width: 100 });
  assert.match(frame, /pi-daddy is missing or its ledger is inactive/i);
  assert.match(frame, /pi install npm:pi-daddy/);
  assert.match(frame, /export PI_GRANTS_LEDGER=/);
  assert.match(frame, /\/grants dashboard/);
});

test("activity dashboard filters and loads exact private prompt/final only on demand", async () => {
  const cwd = await tempDir("dashboard-activity-"); const recorder = new ActivityTimelineRecorder(cwd, { PI_DADDY_ACTIVITY_ROOT: "root-a" });
  await recorder.start("exact submitted prompt", "model-a", "high"); await recorder.skill("skill_available", { name: "review", source: "/skills/review", digest: "a".repeat(64) }); await recorder.finish("exact final response");
  const task = parseActivityTimeline(await import("node:fs/promises").then(({ readFile }) => readFile(defaultActivityTimelinePath(cwd), "utf8"))).tasks[0]!;
  const compact = await dashboardFrame({ cwd, details: true, filter: "skills" });
  assert.match(compact, /skill review/);
  assert.match(compact, new RegExp(`p ${task.id}`)); assert.doesNotMatch(compact, /exact submitted prompt/);
  const shown = await dashboardFrame({ cwd, details: true, activityDetail: { taskId: task.id, field: "final" } });
  assert.match(shown, /exact final response/);
  const bad = await dashboardFrame({ cwd, activityDetail: { taskId: "../secret", field: "final" } });
  assert.match(bad, /ACTIVITY DETAIL UNAVAILABLE/);
});

test("dashboard feedback never upgrades host readback, unknown or pending results to applied", () => {
  assert.match(dashboardActionFeedback("pause-new-dispatch", { state: "failed-or-unknown" }), /NO ACTION CLAIM/);
  assert.match(dashboardActionFeedback("pause-new-dispatch", { state: "readback-only" }), /NO ACTION CLAIM/);
  assert.match(dashboardActionFeedback("revise-scope", { state: "acknowledged", result: { application: "not-applied" } }), /no applied effect is claimed/);
  assert.match(dashboardActionFeedback("revise-scope", { state: "acknowledged", result: { application: "pending-ordinary-boundary" } }), /no applied effect is claimed/);
  assert.match(dashboardActionFeedback("pause-new-dispatch", { state: "acknowledged", result: { application: "applied" } }), /native application applied/);
  assert.doesNotMatch(dashboardActionFeedback("resume-dispatch", { state: "acknowledged", result: { records: [{ request: { requestId: "old" }, application: "applied" }, { request: { requestId: "current" }, application: "pending" }] } }), /native application applied/, "uncorrelated historical records cannot speak for the current dashboard command");
});

test("an incompatible core/plugin protocol is loud and renders no guessed tree", async () => {
  const cwd = await tempDir("dashboard-protocol-");
  const frame = await dashboardFrame({
    cwd,
    ledgerPath: join(cwd, "ledger.jsonl"),
    protocol: DASHBOARD_PROTOCOL_VERSION + 1,
    color: false,
    width: 100,
  });
  assert.match(frame, /INCOMPATIBLE/);
  assert.match(frame, new RegExp(`plugin protocol ${DASHBOARD_PROTOCOL_VERSION}`));
  assert.match(frame, new RegExp(`core requested ${DASHBOARD_PROTOCOL_VERSION + 1}`));
  assert.doesNotMatch(frame, /No governed executions recorded/);
});

test("a configured ledger that does not exist yet remains a live empty view", async () => {
  const cwd = await tempDir("dashboard-empty-");
  const ledgerPath = join(cwd, ".pi", "grants.jsonl");
  const frame = await dashboardFrame({ cwd, ledgerPath, color: false, width: 100 });
  assert.match(frame, /No governed executions recorded yet/);
  assert.match(frame, /waiting for ledger/);
});

test("a corrupt ledger is surfaced and never rewritten", async () => {
  const cwd = await tempDir("dashboard-corrupt-");
  const ledgerPath = join(cwd, ".pi", "grants.jsonl");
  await mkdir(join(cwd, ".pi"));
  const content = "{not-json\n";
  await writeFile(ledgerPath, content);
  const frame = await dashboardFrame({ cwd, ledgerPath, color: false, width: 100 });
  assert.match(frame, /1 corrupt line/);
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(ledgerPath, "utf8")), content);
});

function completedLedger(): string {
  return Array.from({ length: 6 }, (_, i) => {
    const executionId = `exec:00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
    const identity = { ledgerVersion: 3, ts: `2026-09-15T12:00:0${i}.000Z`, executionId, parentExecutionId: null, childId: "d0.1" };
    return [
      { ...identity, event: "capability_decision", parentId: "d0", depth: 1, agentType: `review-${i}`, requested: ["tool:read"], parentGrant: ["tool:read"], effective: ["tool:read"], denied: [], clipped: [], gatedBlocked: [], blocked: false, executor: "process", taskDigest: "a".repeat(64) },
      { ...identity, event: "child_lifecycle", state: "completed", executor: "process", exitCode: 0, signal: null },
    ].map(event => JSON.stringify(event)).join("\n");
  }).join("\n") + "\n";
}

test("local display input expands and collapses ledger history through the frame", async () => {
  const cwd = await tempDir("dashboard-history-");
  const ledgerPath = join(cwd, "ledger.jsonl");
  await writeFile(ledgerPath, completedLedger());
  const display = createDashboardDisplayControls(false, true);
  const frame = () => dashboardFrame({ cwd, ledgerPath, color: false, ...display.state });
  const compact = await frame();
  assert.match(compact, /3 completed roots hidden/);
  assert.doesNotMatch(compact, /review-0/);
  assert.match(display.prompt(), /h Expand history/);
  assert.equal(display.input(" H "), true);
  const expanded = await frame();
  for (let i = 0; i < 6; i++) assert.match(expanded, new RegExp(`review-${i}`));
  assert.doesNotMatch(expanded, /roots hidden|grant tool:read/);
  assert.match(display.prompt(), /h Collapse history/);
  assert.equal(display.input("D"), true);
  assert.match(await frame(), /grant tool:read/);
  assert.equal(display.input("h"), true);
  assert.match(await frame(), /3 completed roots hidden/);
  assert.equal(display.input("d"), true);
  assert.equal(await frame(), compact);
});

test("non-ledger display controls preserve connected action keys and prompt", () => {
  const display = createDashboardDisplayControls(false, false);
  assert.equal(display.prompt(), "Action number / d Details, then Enter: ");
  for (const key of ["h", "1", "pause", ""]) assert.equal(display.input(key), false);
  assert.deepEqual(display.state, { details: false, history: false });
  assert.equal(display.input("d"), true);
  assert.deepEqual(display.state, { details: true, history: false });
});

// Disconnecting the helper from readline or omitting state from draw breaks the actual CLI path.
test("ledger CLI readline accepts h, details, and collapse without dispatching an action", { timeout: 15000 }, async () => {
  const cwd = await tempDir("dashboard-history-input-");
  const ledgerPath = join(cwd, "ledger.jsonl");
  await writeFile(ledgerPath, completedLedger());
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_DADDY_")));
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "dashboard-cli.ts"), "--ledger", ledgerPath, "--no-color"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const screen = () => output.split("\u001b[2J\u001b[H").at(-1) ?? "";
  const waitFor = async (pattern: RegExp) => {
    const deadline = Date.now() + 4000;
    while (!pattern.test(screen())) {
      assert.equal(child.exitCode, null, errors);
      assert.ok(Date.now() < deadline, `missing ${pattern}: ${screen()} ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return screen();
  };
  try {
    await waitFor(/h Expand history/);
    assert.match(screen(), /3 completed roots hidden/);
    child.stdin.write("h\n");
    await waitFor(/h Collapse history/);
    for (let i = 0; i < 6; i++) assert.match(screen(), new RegExp(`review-${i}`));
    child.stdin.write("d\n");
    await waitFor(/grant tool:read/);
    assert.match(screen(), /review-0/);
    child.stdin.write("h\n");
    await waitFor(/h Expand history/);
    assert.match(screen(), /3 completed roots hidden/);
    assert.match(screen(), /grant tool:read/);
    assert.doesNotMatch(screen(), /review-0/);
    assert.doesNotMatch(output, /awaiting acknowledgement|REJECTED|ACKNOWLEDGED/);
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
});
