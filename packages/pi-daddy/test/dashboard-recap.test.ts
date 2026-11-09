import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardContribution, DashboardSourceSnapshot } from "../src/kernel/dashboard-observation.ts";
import { sessionRecapLines } from "../src/products/dashboard-recap.ts";
import { dashboardScreenState, type DashboardScreenOptions } from "../src/products/dashboard-screen.ts";

const time = "2026-11-09T10:00:00Z";
const item = (
  id: string,
  label: string,
  kind: DashboardContribution["kind"] = "status",
  state: DashboardContribution["state"] = "observed",
): DashboardContribution => ({ id, label, kind, state, details: ["private output"], reference: "hidden pointer" });
const source: DashboardSourceSnapshot = {
  producer: "bookie",
  producerVersion: "1",
  sequence: 2,
  generation: "owner",
  availability: "observed",
  observedAt: time,
  staleAfterMs: 60_000,
  items: [
    item("review", "Ready for review: draft", "review", "approval-wait"),
    item("work", "Needs a dependency", "work", "dependency-wait"),
    item("next", "Review draft", "next", "approval-wait"),
  ],
};
function options(activity: DashboardContribution[], sources: DashboardSourceSnapshot[] = []): DashboardScreenOptions {
  return {
    width: 42,
    height: 16,
    screen: dashboardScreenState(),
    items: [],
    now: new Date(time),
    session: {
      auto: { enabled: false, source: "default" },
      rows: [],
      cost: null,
      pendingApprovals: [{ id: "approval", subject: "build", capability: "tool:bash" }],
      observation: {
        version: 1,
        sessionId: "session",
        generation: "owner",
        sequence: 5,
        cwd: "/project",
        observedAt: time,
        capture: { transcripts: false, diagnostics: false },
        sources,
        activity,
        resources: { scope: "owner-process", rssBytes: 1000, sampledAt: time, hostHealth: "unknown" },
      },
    },
  };
}

test("recap reports bounded observed event order and scopes counts to fresh displayed Bookie rows", () => {
  const events = [
    "old event",
    "agent_start",
    "read: tool start",
    "read: tool end",
    "\u001b[2Jwrite: tool end",
    "agent_end",
  ].map((label, n) => item(String(n), label, "status", n === 4 ? "failed" : "observed"));
  const input = options(events, [source, { ...source, producer: "another" }]);
  assert.deepEqual(sessionRecapLines(input), [
    "Pending permissions: 1",
    "Ready for review · 1 shown by Bookie",
    "Waiting on a dependency · 1 shown by Bookie",
    "Recent activity · newest first",
    "Pi finished its turn",
    "Failed · Write a file",
    "Read a project file (2 events)",
    "Pi started a turn",
    "old event",
  ]);
  assert.equal(events[0].label, "old event");
});

test("unverified aggregate judgments and unbound reviews cannot add to the ready total", () => {
  const aggregate = item("reviews", "Selected output judgment observations", "review", "approval-wait");
  const unbound = {
    ...item("review-unbound", "Awaiting a reference", "review", "approval-wait"),
    reference: undefined,
  };
  const result = sessionRecapLines(options([], [{ ...source, items: [aggregate, unbound] }]));
  assert.ok(result.every((line) => !line.startsWith("Ready for review")));
});

test("disconnected and expired observations cannot present old counts as current", () => {
  const input = options([item("last", "agent_end")], [source]);
  assert.deepEqual(sessionRecapLines({ ...input, connected: false }), [
    "Disconnected · last observed activity",
    "Recent activity · newest first",
    "Pi finished its turn",
  ]);
  const expired = { ...input, now: new Date(Date.parse(time) + source.staleAfterMs + 1) };
  assert.equal(
    sessionRecapLines(expired).some((line) => line.includes("Bookie")),
    false,
  );
  const closed = options([], [{ ...source, availability: "closed" }]);
  assert.equal(
    sessionRecapLines(closed).some((line) => line.includes("Bookie")),
    false,
  );
});

test("an empty owner event stream and absent owner do not infer activity from the ledger", () => {
  const input = options([]);
  assert.deepEqual(sessionRecapLines({ ...input, session: undefined, connected: false }), [
    "Disconnected · no observed session activity.",
  ]);
  input.items = [{ key: "old", label: "Unrelated task", status: "finished", elapsed: "", details: [] }];
  for (const lines of [sessionRecapLines(input), sessionRecapLines({ ...input, session: undefined })]) {
    assert.match(lines.join(" "), /No (recent session events recorded|session activity has been observed)/);
    assert.doesNotMatch(lines.join(" "), /Unrelated task/);
  }
});
