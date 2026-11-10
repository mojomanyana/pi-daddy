import assert from "node:assert/strict";
import { after, test } from "node:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
import { recordLines } from "./record-fixtures.ts";
import { dashboardFrame } from "../src/products/dashboard-cli.ts";
after(cleanupTempDirs);
import { createDashboardDisplayControls } from "../src/products/dashboard-display-controls.ts";
import { renderDashboardScreen } from "../src/products/dashboard-screen.ts";
import { activityTaskKey } from "../src/products/activity-timeline.ts";
import { cellWidth } from "../src/products/dashboard-render.ts";
import { createDashboardConnection, type DashboardSessionSnapshot } from "../src/products/dashboard-session-client.ts";
const date = "2026-11-04T12:00:00.000Z";
function snapshot(sequence = 1): DashboardSessionSnapshot {
  return {
    rows: [],
    cost: null,
    auto: { enabled: false, source: "session" },
    pendingApprovals: [],
    observation: {
      version: 1,
      sessionId: "owner",
      cwd: "/work",
      generation: "generation-one",
      sequence,
      observedAt: date,
      capture: { transcripts: false, diagnostics: false },
      resources: { scope: "owner-process", sampledAt: date, rssBytes: 100_000_000, hostHealth: "unknown" },
      turn: { id: "turn", kind: "work", label: "Pi parent", state: "running" },
      activity: [{ id: "tool", kind: "status", label: "read observed", state: "observed" }],
      artifacts: [{ operationId: "op:one", executionId: "exec:one", sha256: "a".repeat(64) }],
      sources: [
        {
          producer: "principal",
          producerVersion: "1",
          generation: "p-one",
          sequence: 3,
          observedAt: date,
          staleAfterMs: 120_000,
          availability: "observed",
          items: [
            { id: "goal", kind: "goal", label: "Preserve exact result", state: "observed" },
            { id: "next", kind: "next", label: "Verify the scoped contract", state: "observed" },
            {
              id: "review",
              kind: "review",
              label: "Review \u001b]8;;https://evil.test\u0007click\u001b]8;;\u0007\u001b[2J safe",
              state: "observed",
              reference: "subject:sha256:abc",
              details: ["quality: pass; alignment: unverified", "independent: yes; scope: one artifact"],
            },
            {
              id: "waiting",
              kind: "work",
              label: "Dependent task",
              state: "dependency-wait",
              details: ["Required result missing"],
            },
          ],
        },
      ],
    },
  };
}
test("six views are bounded, preserve selection on resize and expansion, and keep untrusted links inert", () => {
  const display = createDashboardDisplayControls(false, true);
  for (const view of ["1", "2", "3", "4", "5", "6"]) {
    display.key(view);
    for (const [width, height] of [
      [20, 7],
      [42, 16],
      [80, 24],
      [130, 35],
    ]) {
      const result = renderDashboardScreen({
        width,
        height,
        screen: display.screen,
        items: [],
        session: snapshot(),
        now: new Date(date),
        connected: true,
      });
      assert.equal(result.split("\n").length, height);
      assert.ok(result.split("\n").every((x) => cellWidth(x) <= width));
      assert.doesNotMatch(result, /\u001b|evil\.test/);
    }
  }
  display.key("3");
  const render = (width = 130) =>
    renderDashboardScreen({
      width,
      height: 35,
      screen: display.screen,
      items: [],
      session: snapshot(),
      now: new Date(date),
      connected: true,
    });
  assert.match(render(), /\[3 Reviews\]/);
  const selected = display.screen.selectedKey;
  display.key("x");
  assert.match(render(), /│ Selected item[^\n]*\n[^\n]*│ Review click safe/);
  render(42);
  render();
  assert.equal(display.screen.selectedKey, selected);
  display.key("return");
  assert.match(render(), /subject:sha256:abc/);
  assert.match(render(), /not execution authority/);
  display.key("m");
  assert.match(render(), /SESSION MODELS/);
  display.key("v");
  assert.match(render(), /VERSIONS/);
  display.key("5");
  assert.match(render(), /Run record 1/);
  assert.doesNotMatch(render(), /op:one/);
  display.key("return");
  render();
  display.key("x");
  assert.match(render(), /op:one/);
  display.key("4");
  assert.match(render(), /read observed/);
  display.key("1");
  assert.match(render(), /Next step/);
  assert.match(render(), /Verify the scoped contract/);
});
test("Now keeps the current handoff action visible in a side pane and Reviews opens its exact record", () => {
  const display = createDashboardDisplayControls(false, true);
  const current = snapshot();
  const sources = current.observation!.sources;
  const ref = "sha256:" + "c".repeat(64);
  sources[0]!.items.push({
    id: "other-review",
    kind: "review",
    state: "approval-wait",
    label: "Separate review pending",
  });
  const recommendation = "Review the filtered CSV export";
  const ready = {
    id: "handoff",
    kind: "review" as const,
    state: "approval-wait" as const,
    label: "Filtered CSV export ready for review",
    details: ["Reviewer: service desk owner"],
    reference: ref,
  };
  const bookie: (typeof sources)[number] = {
    ...sources[0]!,
    producer: "bookie",
    items: [
      { id: "next", kind: "next", state: "approval-wait", label: recommendation, reference: ref },
      { ...ready, id: "other", label: "Another draft ready", reference: "sha256:" + "b".repeat(64) },
      ready,
    ],
  };
  sources.push(bookie);
  const draw = (connected = true, now = date) =>
    renderDashboardScreen({
      width: 42,
      height: 15,
      screen: display.screen,
      items: [],
      session: current,
      connected,
      now: new Date(now),
    });
  const initial = draw();
  assert.match(initial, /Next step.*\[3\] Reviews/);
  assert.match(initial, /Review the filtered CSV export/);
  assert.doesNotMatch(initial, /Verify the scoped contract/);
  display.key("3");
  assert.match(draw(), /> Filtered CSV export ready for review/);
  display.key("return");
  assert.equal(display.screen.selectedKey, "source:bookie:p-one:handoff");
  const details = renderDashboardScreen({
    width: 110,
    height: 24,
    screen: display.screen,
    items: [],
    session: current,
    connected: true,
    now: new Date(date),
  });
  assert.match(details, /Reviewer: service desk owner/);
  assert.doesNotMatch(details, /Reference: sha256:/);
  assert.match(details, /x show source/);
  display.key("x");
  const provenance = renderDashboardScreen({
    width: 110,
    height: 24,
    screen: display.screen,
    items: [],
    session: current,
    connected: true,
    now: new Date(date),
  });
  assert.ok(provenance.includes(ref));
  assert.match(provenance, /x hide source/);

  display.key("1");
  bookie.availability = "closed";
  assert.match(draw(), /Verify the scoped contract/);
  assert.doesNotMatch(draw(), /Review the filtered CSV export/);
  bookie.availability = "observed";
  assert.doesNotMatch(draw(false), /Review the filtered CSV export|\[3\] Reviews/);
  assert.doesNotMatch(draw(true, "2026-11-04T13:00:00Z"), /Review the filtered CSV export|\[3\] Reviews/);
  display.key("3");
  assert.match(draw(false), /Last seen.*Filtered CSV/);

  display.key("1");
  bookie.items = [{ id: "next", kind: "next", label: "Restore the missing handoff", state: "dependency-wait" }];
  assert.match(draw(), /Restore the missing handoff/);
  assert.doesNotMatch(draw(), /\[3\] Reviews|Review the filtered CSV export/);
  bookie.items = [{ ...ready, label: "Filtered CSV export accepted", state: "settled" }];
  assert.match(draw(), /Verify the scoped contract/);
  display.key("3");
  assert.match(draw(), /Filtered CSV export accepted/);
});

test("disconnected owner and stale contributions show last observations without fabricated liveness", () => {
  const display = createDashboardDisplayControls(false, true);
  display.key("2");
  const result = renderDashboardScreen({
    width: 100,
    height: 24,
    screen: display.screen,
    items: [],
    session: snapshot(),
    connected: false,
    now: new Date("2026-11-04T13:00:00Z"),
  });
  assert.match(result, /Disconnected · showing last known status/);
  assert.match(result, /Auto unavailable/);
  assert.match(result, /Last seen/);
  assert.doesNotMatch(result, /Permissions connected/);
  display.key("1");
  const absent = snapshot();
  absent.observation!.sources = [];
  display.key("x");
  const empty = renderDashboardScreen({
    width: 100,
    height: 35,
    screen: display.screen,
    items: [],
    session: absent,
    connected: true,
    now: new Date(date),
  });
  assert.doesNotMatch(empty, /Bookie memory · (Available|Project connected)/);
  assert.match(empty, /Parent RSS/);
});
test("a narrow pane keeps review keys legible, and recap and help preserve the selected detail", () => {
  const display = createDashboardDisplayControls(false, true);
  const session = snapshot();
  const draw = () =>
    renderDashboardScreen({
      width: 42,
      height: 16,
      screen: display.screen,
      items: [],
      session,
      now: new Date(date),
      ...display.state,
    });
  draw();
  display.key("tab");
  assert.match(draw(), /Filter: agents/);
  display.key("3");
  const list = draw();
  assert.match(list, /Enter details · \? help/);
  assert.doesNotMatch(list, /Filter: agents/);
  display.key("tab");
  assert.match(draw(), /No items match this filter/);
  for (let i = 0; i < 3; i++) display.key("tab");
  draw();
  display.key("return");
  const identity = display.screen.selectedKey;
  assert.match(draw(), /Reviews \/ Details/);
  display.key("r");
  assert.match(draw(), /Session recap[\s\S]*read observed/);
  display.key("return");
  assert.equal(display.screen.view, "recap");
  display.key("escape");
  assert.equal(display.screen.view, "details");
  display.key("?");
  assert.match(draw(), /DASHBOARD KEYS/);
  display.key("escape");
  assert.equal(display.screen.selectedKey, identity);
  assert.match(draw(), /Reviews \/ Details/);
  display.key("r");
  session.observation!.sources[0]!.items = [
    { id: "another", kind: "review", label: "Unrelated answer", state: "observed" },
  ];
  draw();
  display.key("escape");
  assert.equal(display.screen.selectedKey, identity);
  assert.match(draw(), /no longer visible/);
  assert.doesNotMatch(draw(), /Unrelated answer/);
  display.key("escape");
  assert.match(draw(), /Unrelated answer/);
});

test("a disconnected dashboard withdraws permission prompts and their suggested action", () => {
  const session = snapshot();
  session.pendingApprovals.push({ id: "pending", subject: "build", capability: "tool:bash" });
  const screen = createDashboardDisplayControls(false, true).screen;
  const draw = (connected: boolean) =>
    renderDashboardScreen({ width: 65, height: 20, screen, items: [], session, connected, now: new Date(date) });
  assert.match(draw(true), /permission request in the parent Pi/);
  assert.match(draw(true), /build needs shell access/);
  const offline = draw(false);
  assert.match(offline, /Disconnected · showing last known status/);
  assert.match(offline, /In the current Pi chat, run \/grants dashboard/);
  assert.doesNotMatch(offline, /Respond to the permission request|build needs shell access|Auto unavailable \[a\]/);
});

test("automatically opened Overview welcomes the first task without asking the operator to reopen it", async () => {
  const cwd = await tempDir("dashboard-first-open-");
  const screen = createDashboardDisplayControls(false, true).screen;
  const session = snapshot();
  Object.assign(session.observation!, { turn: undefined, sources: [], activity: [], artifacts: [] });
  const common = { cwd, width: 80, height: 24, screen };
  const connected = await dashboardFrame({ ...common, session, connected: true });
  assert.match(connected, /Connected/);
  assert.match(connected, /Give Pi a task in the main chat/);
  assert.doesNotMatch(connected, /Waiting for local work|\/grants dashboard|Evidence unavailable/);
  const standalone = await dashboardFrame(common);
  assert.match(standalone, /open from \/grants dashboard/);
});

test("recap works from the session snapshot without a local ledger or a retained private detail", async () => {
  const display = createDashboardDisplayControls(false, true);
  display.key("r");
  const frame = await dashboardFrame({
    cwd: await tempDir("dashboard-recap-no-ledger-"),
    ledgerPath: "missing-ledger",
    width: 42,
    height: 14,
    screen: display.screen,
    session: snapshot(),
    now: new Date(date),
    connected: true,
    activityDetail: { taskKey: "missing:private", field: "final" },
  });
  assert.match(frame, /read observed/);
  assert.doesNotMatch(frame, /Waiting for local work|[Dd]etail unavailable|[Ee]vidence unavailable/);
  display.key("1");
  const small = renderDashboardScreen({
    width: 28,
    height: 8,
    screen: display.screen,
    items: [],
    session: snapshot(),
    now: new Date(date),
  });
  assert.equal(small.split("\n").length, 8);
  assert.doesNotMatch(small, /Rows \d+–0/);
});

test("owner snapshot sequence cannot move backward; connection loss retains display only and does not retry controls", async () => {
  let next = snapshot(2),
    fail = false,
    writes = 0;
  const connection = createDashboardConnection(async (action) => {
    if (action.action !== "get") writes++;
    if (fail) throw Error("disconnected");
    return next;
  });
  await connection.refresh();
  next = snapshot(1);
  await connection.refresh();
  assert.equal(connection.state.lastObserved!.observation!.sequence, 2);
  assert.equal(connection.state.snapshot, undefined);
  next = snapshot(1);
  next.observation!.generation = "generation-two";
  await connection.refresh();
  next = snapshot(99);
  await connection.refresh();
  assert.equal(connection.state.lastObserved!.observation!.generation, "generation-two");
  assert.equal(connection.state.snapshot, undefined);
  fail = true;
  await connection.refresh();
  assert.equal(connection.state.snapshot, undefined);
  assert.equal(connection.state.lastObserved!.observation!.generation, "generation-two");
  assert.equal(await connection.change({ action: "set-auto", enabled: true }), false);
  assert.equal(writes, 0);
});

test("capture-off current owner still shows its governed children and excludes siblings without modifying evidence", async () => {
  const cwd = await tempDir("dashboard-current-owner-"),
    path = join(cwd, "grants.jsonl");
  const decision = (n: number, parent: string, name: string) => ({
    ledgerVersion: 3,
    event: "capability_decision",
    ts: date,
    executionId: `exec:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    parentExecutionId: null,
    parentId: parent,
    childId: `${parent}.1`,
    depth: 1,
    agentType: name,
    requested: ["tool:read"],
    parentGrant: ["tool:read"],
    effective: ["tool:read"],
    denied: [],
    clipped: [],
    gatedBlocked: [],
    blocked: false,
    executor: "process",
    taskDigest: "a".repeat(64),
  });
  const text = recordLines(decision(1, "owner-one", "owned-review"), decision(2, "other-owner", "foreign-review"));
  await writeFile(path, text);
  const session = snapshot(),
    display = createDashboardDisplayControls(false, true);
  session.observation!.logicalOwnerId = "owner-one";
  session.observation!.sources = [];
  display.key("2");
  const draw = () =>
    dashboardFrame({
      cwd,
      ledgerPath: path,
      width: 100,
      height: 24,
      screen: display.screen,
      session,
      connected: true,
      now: new Date(date),
    });
  assert.match(await draw(), /owned-review/);
  assert.doesNotMatch(await draw(), /foreign-review/);
  assert.match(await draw(), /Pi parent/);
  assert.equal(await readFile(path, "utf8"), text);
});

test("modern control requests bind the exact observed owner before asynchronous dispatch", async () => {
  let action: any;
  const connection = createDashboardConnection(async (request) => {
    if (request.action === "get") return snapshot(1);
    action = request;
    const result = snapshot(2);
    result.auto.enabled = true;
    return result;
  });
  await connection.refresh();
  assert.equal(await connection.change({ action: "set-auto", enabled: true }), true);
  assert.deepEqual(action.expectedOwner, { sessionId: "owner", cwd: "/work", generation: "generation-one" });
  assert.equal(connection.state.acknowledgment?.state, "applied");
});

test("compact prose wraps at words, attention names waits, and clipped Settings are explicitly scrollable", () => {
  const display = createDashboardDisplayControls(false, true);
  const current = snapshot();
  current.settings = {
    editable: true,
    wallSeconds: 21600,
    idleSeconds: 1200,
    wallSource: "startup",
    idleSource: "session",
    descendants: 8,
    reserved: 1,
    maxDepth: 2,
    perCall: 8,
    jev: { available: true, enabled: false, pending: false, remaining: 0, availability: "disabled" },
  };
  const render = () =>
    renderDashboardScreen({
      width: 52,
      height: 20,
      screen: display.screen,
      items: [],
      session: current,
      now: new Date(date),
      connected: true,
    });
  const now = render();
  assert.match(now, /Dependent task · Waiting on dependency/);
  assert.equal(now.split("Dependent task").length - 1, 1);
  assert.doesNotMatch(now, /recommenda\ntion|obse\nrved/);
  display.key("6");
  assert.match(render(), /Rows 1–.*PgUp\/PgDn/);
  display.key("pagedown");
  const scrolled = render();
  assert.ok(display.screen.offset > 0, "settings page scroll is not reset to the selected toggle");
  assert.ok(scrolled.includes(`Rows ${display.screen.offset + 1}–`));
  assert.match(scrolled, /CAPTURE · restart Pi to change.*\n  Transcripts: off\n  Diagnostics: off/);
});

test("initiative scope and related-session counts remain explicit; stale goals are not presented as current", () => {
  const current = snapshot(),
    display = createDashboardDisplayControls(false, true);
  current.observation!.sources.push({
    producer: "daddy-initiative",
    producerVersion: "v1",
    generation: "init:1",
    sequence: 1,
    observedAt: date,
    staleAfterMs: 120000,
    availability: "observed",
    items: [
      {
        id: "scope",
        kind: "status",
        label: "Initiative bookie:v/p",
        state: "observed",
        details: ["One-host coordinator generation2", "2 known session(s); 3 recorded attempt(s)"],
      },
    ],
  });
  const render = () =>
    renderDashboardScreen({
      width: 100,
      height: 35,
      screen: display.screen,
      items: [],
      session: current,
      now: new Date("2026-11-04T13:00:00Z"),
      connected: true,
    });
  display.key("2");
  assert.match(render(), /Selected Initiative bookie:v\/p \(last known\)/);
  assert.match(render(), /2 known session\(s\); 3 recorded attempt\(s\)/);
  display.key("1");
  assert.match(render(), /Preserve exact result \(last known\)/);
});

test("Overview reports a real review when no task or next step accompanies it", () => {
  const session = snapshot();
  session.observation!.sources[0]!.items = [
    {
      id: "draft",
      kind: "review",
      label: "Customer update draft",
      state: "approval-wait",
      reference: "output/1",
    },
  ];
  const options = {
    width: 88,
    height: 28,
    screen: createDashboardDisplayControls(false, true).screen,
    session,
    items: [],
    connected: true,
    now: new Date(date),
  };
  const overview = renderDashboardScreen(options);
  assert.match(overview, /Needs your decision/);
  assert.match(overview, /Customer update draft/);
  assert.doesNotMatch(overview, /No decision requested/);
  assert.doesNotMatch(renderDashboardScreen({ ...options, connected: false }), /Needs your decision/);
});

test("failures are visible in the timeline and the current parent has the latest observed purpose", () => {
  const session = snapshot();
  session.activity = { rootId: "root", taskId: "turn", path: "/unused" };
  const key = activityTaskKey("root", "turn");
  session.observation!.turn!.label = "Check the queue export";
  session.observation!.activity = [
    {
      id: "e",
      kind: "status",
      label: "bash: tool end",
      state: "failed",
      details: ["Purpose: Run the project tests", "Call: 1"],
    },
  ];
  const controls = createDashboardDisplayControls(false, true);
  const render = () =>
    renderDashboardScreen({
      width: 84,
      height: 29,
      screen: controls.screen,
      session,
      connected: true,
      items: [
        { key, taskKey: key, label: "Pi is working on your request", status: "active", elapsed: "1:30", details: [] },
      ],
      now: new Date(date),
    });
  const overview = render();
  assert.match(overview, /Check the queue export/);
  assert.match(overview, /Run the project tests · Failed/);
  controls.key("4");
  const timeline = render();
  assert.match(timeline, /Run the project tests · Failed/);
  assert.doesNotMatch(timeline, /tool end|Purpose: |Call: 1/);
});

test("Activity keeps an explicit workspace inspection discoverable outside the event timeline", () => {
  const session = snapshot();
  session.observation!.sources.push({
    ...session.observation!.sources[0]!,
    producer: "workspace-routing",
    items: [
      {
        id: "workspace-routing",
        label: "Workspace service desk: unavailable",
        kind: "status",
        state: "unavailable",
        details: ["Inspect the selected workspace."],
      },
    ],
  });
  const display = createDashboardDisplayControls(false, true);
  display.key("4");
  const render = () =>
    renderDashboardScreen({
      width: 88,
      height: 26,
      screen: display.screen,
      items: [],
      session,
      connected: true,
      now: new Date(date),
    });
  assert.match(render(), /Current reports[\s\S]+Workspace service desk: unavailable/);
  display.key("down");
  display.key("return");
  assert.match(render(), /Inspect the selected workspace/);
});

test("a lost control reply remains actionable even after a second failed poll", async () => {
  const live = snapshot();
  let fail = false;
  const client = createDashboardConnection(async () => {
    if (fail) throw Error("connect ENOENT /private/control.sock");
    return live;
  });
  await client.refresh();
  fail = true;
  await client.change({ action: "set-auto", enabled: true });
  await client.refresh();
  const screen = createDashboardDisplayControls(false, true).screen;
  const result = renderDashboardScreen({
    width: 65,
    height: 20,
    screen,
    items: [],
    session: client.state.lastObserved,
    connected: false,
    acknowledgment: client.state.acknowledgment,
    notice: client.state.error,
    now: new Date(date),
  });
  assert.match(result.replace(/\s+/g, " "), /Unconfirmed Auto change. Check the main Pi chat before trying again/);
  assert.doesNotMatch(result, /ENOENT|control.sock/);
});
