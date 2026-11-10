import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardContribution, DashboardSourceSnapshot } from "../src/kernel/dashboard-observation.ts";
import { sessionDashboardItems, sessionNextLines, sessionPanelLines } from "../src/products/dashboard-panels.ts";
import {
  dashboardScreenState,
  renderDashboardScreen,
  type DashboardScreenOptions,
} from "../src/products/dashboard-screen.ts";
import { cellWidth } from "../src/products/dashboard-render.ts";

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
  assert.match(compact[0]!, /^Needs your decision  ─/);
  assert.equal(compact[1], "> customer update · Awaiting decision");
  assert.match(compact[2]!, /^In progress  ─/);
  assert.equal(compact[3], "  build · Running");
  assert.ok(sessionDashboardItems(o)[0]!.details.includes(workPath));
  o.screen.expanded = true;
  o.width = 120;
  const expanded = panel(o).join("\n");
  assert.match(expanded, /Tools/);
  assert.match(expanded, /Parent RSS/);
});

test("task names which would look identical retain their differentiating paths", () => {
  const duplicate = { ...work, id: "other", label: "/projects/other/tasks/customer_update.md" };
  const o = options([work, duplicate]);
  assert.deepEqual(
    sessionDashboardItems(o)
      .filter((x) => x.key.startsWith("source:"))
      .map((x) => x.label),
    [work.label, duplicate.label],
  );
});

test("review leads with its actual read action and current owner permission takes priority", () => {
  const o = options([review, next]);
  assert.deepEqual(sessionNextLines(o), ["NEXT · [3] Reviews", "Review customer update"]);
  o.screen.destination = "reviews";
  assert.match(panel(o)[0]!, /^Waiting for your review · 1/);
  assert.equal(panel(o)[1], "> Ready for review: customer update");
  const details = sessionDashboardItems(o)[0]!.details;
  assert.match(details[0]!, /^Open \/bookie-work review/);
  assert.ok(details.includes("Reference: answer-a"));
  assert.deepEqual(sessionDashboardItems(o)[0]!.briefDetails, [
    "In your main Pi chat, run",
    "/bookie-work review",
    "Read the output and record your decision.",
  ]);
  o.session!.pendingApprovals.push({ id: "permit", subject: "build", capability: "tool:write" });
  assert.match(sessionNextLines(o).join(" "), /permission request in the parent Pi session/);
  o.connected = false;
  assert.match(sessionNextLines(o).join(" "), /Reconnect/);
  assert.match(panel(o)[0]!, /^Review records · 1/);
  assert.equal(panel(o)[1], "> Last seen · Ready for review: customer update");
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

test("Now and Work present the selected task's saved review and keep both references in source details", () => {
  const customer = { ...work, id: "TSK-customer", reference: "sha256:customer-task-revision" };
  const draft = { ...review, id: "review-TSK-customer", reference: "customer-output" };
  const engineering = {
    ...review,
    id: "review-TSK-engineering",
    reference: "engineering-output",
    details: ["Engineering review only"],
  };
  const o = options([{ ...next, reference: engineering.reference }, engineering, customer, draft]);
  for (const destination of ["now", "work"] as const) {
    o.screen.destination = destination;
    const selected = sessionDashboardItems(o)[0]!;
    assert.ok(selected.key.endsWith(":TSK-customer"));
    const instructions = selected.briefDetails!.join("\n");
    assert.match(instructions, /main Pi chat, run\n\/bookie-work review\n/);
    assert.match(instructions, /If asked, select customer-update\.md/);
    assert.doesNotMatch(instructions, /Engineering|sha256:/);
    assert.ok(selected.details.includes("Reference: " + customer.reference));
    assert.ok(selected.details.includes("Saved handoff reference: " + draft.reference));
  }
});

test("a task cannot borrow a review from another task, producer, or stale observation", () => {
  const customer = { ...work, id: "TSK-customer", reference: "task-revision" };
  const draft = { ...review, id: "review-TSK-customer" };
  const o = options([customer]);
  const [bookie] = o.session!.observation!.sources;
  o.session!.observation!.sources.push({ ...bookie!, producer: "principal", items: [draft] });
  const noReviewAction = () => {
    const selected = sessionDashboardItems(o)[0]!;
    assert.doesNotMatch(selected.briefDetails!.join(" "), /\/bookie-work review/);
    assert.ok(!selected.details.some((detail) => detail.startsWith("Saved handoff reference:")));
  };
  for (const candidates of [
    [],
    [{ ...draft, id: "review-other" }],
    [{ ...draft, reference: undefined }],
    [draft, { ...draft, reference: "conflicting" }],
  ]) {
    bookie!.items = [customer, ...candidates];
    noReviewAction();
  }
  bookie!.items = [customer, draft];
  o.connected = false;
  noReviewAction();
  o.connected = true;
  o.now = new Date(Date.parse(instant) + 1_001);
  noReviewAction();
});

test("selection and action remain distinguishable in monochrome, narrow panes and wide scrolled lists", () => {
  const customer = { ...work, id: "customer", reference: "task-revision" };
  const queue = Array.from({ length: 22 }, (_, i) => ({ ...work, label: "Other work " + i, id: "work-" + i }));
  const o = options([
    ...queue,
    customer,
    { ...review, id: "review-customer" },
    { ...next, label: "Review the weekly queue" },
  ]);
  o.screen.selectedKey = sessionDashboardItems(o).find((x) => x.label === "customer update")!.key;
  for (const width of [42, 110, 200]) {
    o.width = width;
    const mono = renderDashboardScreen(o);
    const color = renderDashboardScreen({ ...o, color: true });
    assert.equal(color.replace(/\x1b\[[0-9;]*m/g, ""), mono);
    assert.match(color, /\x1b\[1;7m> customer update/);
    assert.match(mono, /Next step/);
    assert.match(mono, /Review the weekly queue/);
    assert.match(mono, /> customer update/);
    assert.ok(mono.split("\n").every((line) => cellWidth(line) <= width));
    assert.equal(mono.split("\n").length, o.height);
    if (width >= 110) {
      assert.match(mono, / │ Selected item/);
      assert.match(mono, / │ customer update/);
      assert.match(mono, / │ \/bookie-work review/);
    } else assert.doesNotMatch(mono, /Selected item/);
  }
});

test("Overview and Tasks show ongoing research ahead of an earlier failed request, with no operator action", () => {
  const o = options([]);
  o.width = 80;
  o.height = 32;
  o.items.push({
    key: "earlier-turn",
    label: "Pi handled your request",
    status: "failed",
    elapsed: "0:01",
    details: [],
  });
  o.session!.observation!.turn = { id: "new-turn", kind: "work", label: "Research workshop guides", state: "running" };
  for (const destination of ["now", "work"] as const) {
    o.screen.destination = destination;
    const frame = renderDashboardScreen(o);
    assert.doesNotMatch(frame, /^Needs (attention|your permission|your decision)\b/im);
    assert.match(frame, /In progress[^\n]*\n[> ]+Research workshop guides · Running/);
    assert.match(frame, /Research workshop guides · Running[\s\S]+Pi handled your request · Failed 0:01/);
    const colorFrame = renderDashboardScreen({ ...o, color: true });
    const failedLine = colorFrame.split("\n").find((line) => line.includes("Pi handled your request"))!;
    assert.doesNotMatch(failedLine, /\x1b\[(?:1;)?31m/);
    if (destination === "now") assert.match(frame, /No pending dashboard requests\./);
  }
});

test("only current permission and review requests ask for a decision alongside passive outcomes", () => {
  const o = options([work, { id: "runner", kind: "work", label: "Waiting for sources", state: "dependency-wait" }]);
  o.width = 80;
  o.height = 40;
  o.items.push(
    { key: "unfinished", label: "Earlier run", status: "incomplete", elapsed: "0:04", details: [] },
    { key: "refusal", label: "Earlier lookup", status: "refused", elapsed: "0:01", details: [] },
  );
  o.session!.pendingApprovals.push({ id: "permit", subject: "research", capability: "tool:bash" });
  for (const destination of ["now", "work"] as const) {
    o.screen.destination = destination;
    const frame = renderDashboardScreen(o);
    assert.match(frame, /Needs your permission[^\n]*\n[> ]+research needs shell access/);
    assert.match(frame, /Needs your decision[^\n]*\n[> ]+customer update · Awaiting decision/);
    assert.match(frame, /Earlier run · Incomplete/);
    assert.match(frame, /Earlier lookup · Blocked/);
    assert.match(frame, /Waiting for sources · Waiting on dependency/);
    assert.doesNotMatch(frame, /Needs attention|No pending dashboard requests/);
  }
  o.session!.pendingApprovals = [];
  o.session!.observation!.sources[0]!.availability = "closed";
  for (const destination of ["now", "work"] as const) {
    o.screen.destination = destination;
    const closed = renderDashboardScreen(o);
    assert.match(closed, /Last seen · customer update/);
    assert.doesNotMatch(
      closed,
      /Needs attention|Needs your permission|Needs your decision|research needs shell access/,
    );
  }
});

test("a settled chat turn without an explicit input event reports only the dashboard's queue", () => {
  const o = options([]);
  o.width = 80;
  o.height = 24;
  // Identical owner metadata is emitted for a final answer and for a question in ordinary chat.
  o.session!.observation!.turn = { id: "turn:1", kind: "work", state: "settled", label: "Pi finished its turn" };
  const frame = renderDashboardScreen(o);
  assert.match(frame, /No pending dashboard requests\./);
  assert.match(frame, /Pi finished its turn · Finished/);
  assert.doesNotMatch(frame, /No decision requested from you|No (?:input|response) needed|Needs your input/i);
});

test("Scout's current request for a decision is shown once alongside the other decisions", () => {
  const o = options([]);
  const scout = {
    ...o.session!.observation!.sources[0]!,
    producer: "scout-worker",
    items: [
      { id: "research", kind: "work", state: "approval-wait", label: "Research" } satisfies DashboardContribution,
    ],
  };
  o.session!.observation!.sources.push(scout);
  o.width = 80;
  o.height = 30;
  for (const destination of ["now", "work"] as const) {
    o.screen.destination = destination;
    const frame = renderDashboardScreen(o);
    assert.match(frame, /Needs your decision[^\n]*\n[> ]+Scout research worker · Waiting for you/);
    assert.equal(o.screen.items.filter((item) => item.key === "component:scout-worker").length, 1);
  }
  scout.availability = "closed";
  o.screen.destination = "now";
  const closed = renderDashboardScreen(o);
  assert.match(closed, /Scout research worker · Live status unknown/);
  assert.doesNotMatch(closed, /Needs your decision/);
});
