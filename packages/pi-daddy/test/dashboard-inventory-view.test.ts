import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardInventory, DashboardSourceSnapshot } from "../src/kernel/dashboard-observation.ts";
import { componentItems } from "../src/products/dashboard-components.ts";
import { createDashboardDisplayControls } from "../src/products/dashboard-display-controls.ts";
import { inventoryPresentation } from "../src/products/dashboard-inventory-view.ts";
import { sessionDashboardItems } from "../src/products/dashboard-panels.ts";
import { cellWidth } from "../src/products/dashboard-render.ts";
import { renderDashboardScreen, type DashboardScreenOptions } from "../src/products/dashboard-screen.ts";

const at = "2026-11-16T10:00:00.000Z";
const reference = "sha256:" + "a".repeat(64);
const inventory = (memory: boolean): DashboardInventory => ({
  scope: "Workshop Desk · this folder",
  state: "available",
  summary: memory ? "2 saved notes · progress and audience" : "1 saved brief · partial findings",
  count: memory ? 2 : 1,
  limited: false,
  entries: memory
    ? [
        { id: "progress", title: "Workshop Desk progress", summary: "API and restart checks passed.", reference },
        { id: "audience", title: "Workshop audience", summary: "Dispatchers managing the queue." },
      ]
    : [
        {
          id: "forms",
          title: "Accessible workshop forms",
          summary: "Partial · labels and grouping verified.",
          details: [
            "Useful finding: every input needs a visible label.",
            "Gap: keyboard reordering remains unchecked.",
          ],
          reference,
        },
      ],
});
function fixture(width = 110, height = 34) {
  const display = createDashboardDisplayControls(false, true);
  const sources: DashboardSourceSnapshot[] = ["bookie-memory", "scout-worker"].map((producer) => ({
    producer,
    producerVersion: "test",
    generation: "g",
    observedAt: at,
    availability: "observed",
    staleAfterMs: 120_000,
    sequence: 1,
    items:
      producer === "bookie-memory"
        ? [{ id: "project-memory", kind: "work", state: "observed", label: "Workspace memory" }]
        : [
            { id: "research", kind: "work", state: "failed", label: "Last research attempt" },
            {
              id: "availability",
              kind: "status",
              state: "unavailable",
              label: "Docker unavailable",
              details: ["Docker is not responding. Saved research is still available below."],
            },
          ],
    inventory: inventory(producer === "bookie-memory"),
  }));
  const options: DashboardScreenOptions = {
    width,
    height,
    screen: display.screen,
    now: new Date(at),
    items: [],
    connected: true,
    session: {
      auto: { enabled: true, source: "session" },
      pendingApprovals: [],
      rows: [],
      cost: null,
      observation: {
        version: 1,
        generation: "g",
        sequence: 1,
        sessionId: "s",
        cwd: "/workshop",
        observedAt: at,
        capture: { diagnostics: false, transcripts: false },
        sources,
        resources: { scope: "owner-process", sampledAt: at, rssBytes: 0, hostHealth: "unknown" },
      },
    },
  };
  return { options, sources, display };
}

test("saved research remains useful when worker availability and the latest attempt fail", () => {
  const { options } = fixture();
  const rows = componentItems(options);
  const research = rows.find((item) => item.key === "component:scout-worker")!;
  assert.match(research.label, /Docker unavailable/);
  assert.match(research.briefDetails!.join("\n"), /Partial.*labels[\s\S]*Gap: keyboard reordering/);
  assert.match(research.previewLines!.join("\n"), /Accessible workshop forms/);
  assert.doesNotMatch(research.briefDetails!.join("\n"), /sha256:|APPROVE|research complete/i);
  assert.ok(research.details.some((line) => line.includes(reference)));
  const shown = sessionDashboardItems(options);
  assert.equal(shown.filter((item) => item.key.startsWith("component:scout")).length, 1);
  assert.ok(!shown.some((item) => item.status === "needs-you" || item.status === "approval-wait"));
});

test("empty, limited and inaccessible inventories never imply a complete empty history", () => {
  const empty = inventoryPresentation({
    scope: "This folder",
    state: "empty",
    count: 0,
    limited: false,
    summary: "No saved notes in this folder.",
    entries: [],
  });
  assert.match(empty.content.join("\n"), /No saved notes/);
  const bounded = inventoryPresentation({ ...inventory(true), count: undefined, limited: true });
  assert.match(bounded.content.join("\n"), /not the full inventory/);
  const inaccessible = inventoryPresentation({
    ...inventory(true),
    state: "unavailable",
    count: undefined,
    summary: "Cannot read this project's notes.",
    limited: true,
    entries: [],
  });
  assert.match(inaccessible.content.join("\n"), /Cannot read/);
  assert.doesNotMatch(inaccessible.content.join("\n"), /No saved notes|Workshop audience/);
});

test("Bookie read failure cannot be promoted to ready or an empty note store", () => {
  const { options, sources } = fixture();
  const memory = sources[0]!;
  memory.items[0]!.state = "unknown";
  memory.items[0]!.details = ["Saved notes could not be enumerated."];
  memory.inventory = {
    scope: "This folder",
    state: "unknown",
    summary: "Saved notes could not be enumerated.",
    limited: true,
    entries: [],
  };
  let row = componentItems(options)[0]!;
  assert.match(row.label, /Cannot check notes/);
  assert.doesNotMatch(row.briefDetails!.join("\n"), /Ready|No saved notes|Workshop audience/);
  memory.items[0]!.state = "unavailable";
  row = componentItems(options)[0]!;
  assert.match(row.label, /Memory unavailable/);
  assert.ok(!sessionDashboardItems(options).some((item) => item.status === "needs-you"));
});

test("disconnection, stale reports, ended access and failed refresh hide saved previews immediately", () => {
  for (const condition of ["disconnected", "expired", "closed", "refresh-failed", "auto-off"] as const) {
    const { options, sources } = fixture();
    if (condition === "disconnected") options.connected = false;
    if (condition === "expired") options.now = new Date(Date.parse(at) + 120_001);
    if (condition === "closed")
      sources.forEach((source) => {
        source.availability = "closed";
      });
    if (condition === "refresh-failed")
      sources.forEach((source) => {
        source.refresh = { state: "failed" };
      });
    if (condition === "auto-off") options.session!.auto.enabled = false;
    const rows = componentItems(options).filter((row) => condition !== "auto-off" || row.key === "component:bookie");
    assert.ok(rows.length);
    for (const row of rows) {
      assert.ok(!row.browse && !row.previewLines);
      assert.doesNotMatch(
        [...row.briefDetails!, ...row.details].join("\n"),
        /Workshop audience|Accessible workshop forms|sha256:/,
      );
    }
    if (condition === "expired") assert.match(rows[0]!.briefDetails!.join("\n"), /Updated 2m ago/);
    if (condition === "refresh-failed") assert.match(rows[0]!.label, /Status check unavailable/);
  }
});

test("opening memory is a local browse action with readable content; references require source details", () => {
  const { options, display } = fixture(80, 36);
  options.screen.selectedKey = "component:bookie";
  let frame = renderDashboardScreen(options);
  assert.match(frame, /Memory[\s\S]*Workshop Desk progress[\s\S]*Research/);
  assert.match(frame, /Enter browse/);
  assert.equal(display.key("return"), undefined);
  frame = renderDashboardScreen(options);
  assert.equal(display.screen.view, "details");
  assert.match(frame, /Workshop audience[\s\S]*Dispatchers managing the queue/);
  assert.doesNotMatch(frame, /sha256:/);
  assert.equal(display.key("x"), undefined);
  assert.match(renderDashboardScreen(options), /sha256:/);
  display.key("escape");
  assert.equal(display.screen.selectedKey, "component:bookie");
  assert.equal(options.session!.pendingApprovals.length, 0);
});

test("narrow and wide browsing preserves selection and terminal bounds, including long Unicode topics", () => {
  for (const [width, height] of [
    [38, 18],
    [64, 26],
    [110, 34],
    [180, 45],
  ]) {
    const { options, sources, display } = fixture(width!, height!);
    sources[0]!.inventory!.entries[0]!.title = "Workshop 界 " + "long topic ".repeat(12);
    sources[0]!.inventory!.entries[1]!.summary += "\x1b]52;c;c2VjcmV0\x07\x1b[31m";
    options.screen.selectedKey = "component:bookie";
    for (const view of ["overview", "browse", "returned"] as const) {
      if (view === "browse") display.key("return");
      if (view === "returned") display.key("escape");
      const frame = renderDashboardScreen(options);
      assert.equal(frame.split("\n").length, height);
      assert.ok(frame.split("\n").every((line) => cellWidth(line) <= width!));
      assert.doesNotMatch(frame, /\x1b|c2VjcmV0/);
      assert.equal(display.screen.selectedKey, "component:bookie");
    }
  }
});
