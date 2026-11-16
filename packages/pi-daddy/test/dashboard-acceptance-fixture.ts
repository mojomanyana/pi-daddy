import type { DashboardSourceSnapshot } from "../src/kernel/dashboard-observation.ts";
import { createDashboardDisplayControls } from "../src/products/dashboard-display-controls.ts";
import type { DashboardScreenOptions } from "../src/products/dashboard-screen.ts";

/** Fixed observations for reviewing the shipped terminal renderer, not a claim of a live product run. */
export function dashboardAcceptanceFixture(width: number, height: number) {
  const at = "2026-11-16T12:00:00.000Z";
  const display = createDashboardDisplayControls(false, true);
  const source = (producer: string, items: DashboardSourceSnapshot["items"]): DashboardSourceSnapshot => ({
    producer,
    producerVersion: "fixture",
    generation: "current-owner",
    sequence: 1,
    observedAt: at,
    staleAfterMs: 120_000,
    availability: "observed",
    items,
  });
  const memory = source("bookie-memory", [
    { id: "project-memory", kind: "work", state: "observed", label: "Workspace memory" },
    { id: "open-choice-preview", kind: "work", state: "observed", label: "When should the preview open?" },
  ]);
  memory.inventory = {
    state: "available",
    scope: "This folder",
    limited: false,
    count: 2,
    summary: "2 saved notes",
    entries: [
      { id: "progress", title: "Workshop Desk progress", summary: "API delivered; restart persistence passed." },
      { id: "audience", title: "Customer update audience", summary: "Dispatchers managing the queue." },
    ],
  };
  const research = source("scout-worker", [
    { id: "availability", kind: "status", state: "observed", label: "Local Docker reachable" },
  ]);
  research.inventory = {
    state: "available",
    scope: "This folder",
    limited: false,
    count: 1,
    summary: "1 saved brief · partial findings",
    entries: [
      {
        id: "forms",
        title: "Accessible workshop forms",
        summary: "Visible labels and field grouping verified.",
        details: ["Useful finding: give each field a visible label.", "Gap: keyboard reordering still needs checking."],
      },
    ],
  };
  const options: DashboardScreenOptions = {
    width,
    height,
    now: new Date(at),
    connected: true,
    items: [],
    screen: display.screen,
    session: {
      auto: { enabled: true, source: "session" },
      pendingApprovals: [],
      rows: [],
      cost: null,
      observation: {
        version: 1,
        generation: "current-owner",
        sequence: 1,
        sessionId: "fixture",
        cwd: "/workshop",
        observedAt: at,
        capture: { diagnostics: false, transcripts: false },
        sources: [memory, research],
        turn: { id: "build", kind: "work", state: "running", label: "Build the workshop form" },
        resources: { scope: "owner-process", sampledAt: at, rssBytes: 0, hostHealth: "unknown" },
      },
    },
  };
  return { options, display };
}
