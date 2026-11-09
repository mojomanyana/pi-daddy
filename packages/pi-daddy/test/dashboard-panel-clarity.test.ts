import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardContribution, DashboardSourceSnapshot } from "../src/kernel/dashboard-observation.ts";
import { sessionDashboardItems, sessionNextLines, sessionPanelLines } from "../src/products/dashboard-panels.ts";
import { dashboardScreenState, type DashboardScreenOptions } from "../src/products/dashboard-screen.ts";

const instant = "2026-11-09T12:00:00.000Z";
function options(items: DashboardContribution[]): DashboardScreenOptions {
  const source: DashboardSourceSnapshot = {
    producer: "bookie",
    producerVersion: "1",
    generation: "owner-a",
    sequence: 1,
    availability: "observed",
    observedAt: instant,
    staleAfterMs: 1_000,
    items,
  };
  return {
    now: new Date(instant),
    width: 42,
    height: 18,
    connected: true,
    items: [],
    screen: dashboardScreenState(),
    session: {
      auto: { enabled: false, source: "default" },
      pendingApprovals: [],
      cost: null,
      rows: [],
      observation: {
        version: 1,
        sessionId: "s",
        cwd: "/work",
        generation: "g",
        sequence: 1,
        observedAt: instant,
        resources: { scope: "owner-process", sampledAt: instant, rssBytes: 0, hostHealth: "unknown" },
        capture: { diagnostics: false, transcripts: false },
        sources: [source],
      },
    },
  };
}
const workPath = "/projects/example/tasks/customer-update.md";
const work: DashboardContribution = { id: "work", kind: "work", state: "approval-wait", label: workPath };
const review: DashboardContribution = {
  id: "review",
  kind: "review",
  state: "approval-wait",
  label: "Ready for review: customer update",
  reference: "answer-a",
  details: [
    "Output: handoff",
    workPath,
    "Open /bookie-work review to read the saved handoff.",
    "Record your review decision for this output in the selected project.",
  ],
};
const next: DashboardContribution = {
  id: "next",
  kind: "next",
  state: "approval-wait",
  label: "Review customer update",
  reference: "answer-a",
};
function panel(o: DashboardScreenOptions): string[] {
  const items = sessionDashboardItems(o);
  o.screen.selectedKey = items[0]?.key;
  return sessionPanelLines(o, items, o.width);
}

test("compact Now has one named row per task, keeps full identity in details, and moves diagnostics into expansion", () => {
  const o = options([work, { id: "runner", kind: "work", label: "build", state: "running" }]);
  const compact = panel(o);
  assert.deepEqual(compact, ["> customer update · Awaiting decision", "  build · Running"]);
  assert.ok(sessionDashboardItems(o)[0]!.details.includes(workPath));
  o.screen.expanded = true;
  o.width = 120;
  const expanded = panel(o).join("\n");
  assert.match(expanded, /COMPONENTS/);
  assert.match(expanded, /Parent RSS/);
});

test("task names which would look identical retain their differentiating paths", () => {
  const duplicate = { ...work, id: "other", label: "/projects/other/tasks/customer_update.md" };
  const o = options([work, duplicate]);
  assert.deepEqual(
    sessionDashboardItems(o).map((x) => x.label),
    [work.label, duplicate.label],
  );
});

test("review leads with its actual read action and current owner permission takes priority", () => {
  const o = options([review, next]);
  assert.deepEqual(sessionNextLines(o), ["NEXT · [3] Reviews", "Review customer update"]);
  o.screen.destination = "reviews";
  assert.deepEqual(panel(o), ["> Ready for review: customer update"]);
  const details = sessionDashboardItems(o)[0]!.details;
  assert.match(details[0]!, /^Open \/bookie-work review/);
  assert.ok(details.includes("Reference: answer-a"));
  assert.deepEqual(sessionDashboardItems(o)[0]!.briefDetails, [
    "Open /bookie-work review to read the saved handoff.",
    "Record your review decision for this output in the selected project.",
  ]);
  o.session!.pendingApprovals.push({ id: "permit", subject: "build", capability: "tool:write" });
  assert.match(sessionNextLines(o).join(" "), /permission request in the parent Pi session/);
  o.connected = false;
  assert.match(sessionNextLines(o).join(" "), /Reconnect/);
  assert.deepEqual(panel(o), ["> Last seen · Ready for review: customer update"]);
  assert.match(sessionDashboardItems(o)[0]!.details[0]!, /Current state is unknown/);
  assert.doesNotMatch(
    sessionDashboardItems(o)[0]!.details.join(" "),
    /Open \/bookie-work review|Record your review decision/,
  );
});

test("aggregate judgments remain available when the operator expands reviews or only totals are reported", () => {
  const totals: DashboardContribution = {
    id: "reviews",
    label: "Selected output judgment observations",
    kind: "review",
    state: "approval-wait",
    details: ["Accepted: 1; unverified: 2"],
  };
  const o = options([totals, review, next]);
  o.screen.destination = "reviews";
  assert.deepEqual(
    sessionDashboardItems(o).map((x) => x.label),
    [review.label],
  );
  o.screen.expanded = true;
  assert.deepEqual(
    sessionDashboardItems(o).map((x) => x.label),
    [review.label, "Review totals"],
  );
  o.screen.expanded = false;
  const unboundNext: DashboardContribution = {
    id: "work-next",
    kind: "next",
    label: "Check selected output",
    state: "approval-wait",
  };
  o.session!.observation!.sources[0]!.items = [totals, unboundNext];
  assert.deepEqual(sessionNextLines(o), ["NEXT", "Check selected output"]);
  const rows = sessionDashboardItems(o);
  assert.equal(rows[0]!.label, "Review totals");
  assert.equal(rows[0]!.briefDetails, undefined);
  assert.ok(rows[0]!.details.includes("Accepted: 1; unverified: 2"));
  o.session!.observation!.sources[0]!.items.push(review);
  assert.deepEqual(sessionNextLines(o), ["NEXT · [3] Reviews", "Check selected output"]);
});

test("a mismatched review reference or expired source cannot advertise a current review action", () => {
  const o = options([next, { ...review, reference: "different-answer" }]);
  assert.doesNotMatch(sessionNextLines(o).join(" "), /Review customer update|\[3\]/);
  o.now = new Date(Date.parse(instant) + 1_001);
  assert.match(sessionNextLines(o)[1], /current status/);
  o.screen.destination = "reviews";
  const stale = panel(o);
  assert.match(stale.join(" "), /Last seen/);
});
