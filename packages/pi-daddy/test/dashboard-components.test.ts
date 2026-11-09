import assert from "node:assert/strict";
import { test } from "node:test";
import {
  componentItems,
  isComponentObservation,
  publishedEvidenceItem,
  savedEvidenceItem,
  versionLines,
} from "../src/products/dashboard-components.ts";
import type {
  DashboardContribution,
  DashboardObservedState,
  DashboardSourceSnapshot,
} from "../src/kernel/dashboard-observation.ts";
import { dashboardScreenState, type DashboardScreenOptions } from "../src/products/dashboard-screen.ts";
import type { EcosystemVersionRow } from "../src/products/ecosystem-versions.ts";

const when = "2026-11-09T10:00:00.000Z";
test("published evidence titles stay readable even when a producer uses a hash or path as its label", () => {
  const ref = "7".repeat(64);
  const entry: DashboardContribution = { id: "brief", kind: "evidence", label: ref, state: "observed", reference: ref };
  const base = { key: "entry", label: ref, status: "observed", elapsed: "", details: [ref] };
  const row = publishedEvidenceItem(source("scout-worker", "settled"), entry, base);
  assert.equal(row.label, "Scout research brief");
  assert.equal(row.status, "Reference saved");
  assert.ok(row.details.includes(ref));
  for (const label of [ref, "/root/reports/brief.md", "guides/report.md"])
    assert.equal(
      publishedEvidenceItem(source("external", "observed"), { ...entry, label }, base).label,
      "Tool evidence record",
    );
  assert.equal(
    publishedEvidenceItem(source("bookie", "observed"), { ...entry, label: "Delivery receipt" }, base).label,
    "Delivery receipt",
  );
});
const bookie: EcosystemVersionRow = {
  id: "bookie-pi-skills",
  label: "Bookie",
  installedVersion: "0.1.3",
  loadedVersion: null,
  state: "not-reported",
  source: "npm:pi-bookie",
  path: "/pkg",
  commands: [],
};
function source(producer: string, state: DashboardObservedState): DashboardSourceSnapshot {
  return {
    producer,
    producerVersion: "v1",
    generation: "g",
    observedAt: when,
    staleAfterMs: 60_000,
    availability: "observed",
    sequence: 1,
    items: [{ id: "research", kind: "work", label: "Scout research", state }],
  };
}
function panel(sources: DashboardSourceSnapshot[] = [], rows: EcosystemVersionRow[] = []): DashboardScreenOptions {
  return {
    width: 52,
    height: 24,
    screen: dashboardScreenState(),
    now: new Date(when),
    items: [],
    connected: true,
    session: {
      auto: { enabled: false, source: "default" },
      pendingApprovals: [],
      rows: [],
      cost: null,
      observation: {
        version: 1,
        generation: "g",
        sequence: 1,
        sessionId: "s",
        cwd: "/a",
        observedAt: when,
        capture: { diagnostics: false, transcripts: false },
        resources: { scope: "owner-process", sampledAt: when, rssBytes: 0, hostHealth: "unknown" },
        sources,
      },
      versions: { checkedAt: when, rows },
    },
  };
}

test("Scout registration, a real run, and stale observations have distinct human readouts", () => {
  assert.deepEqual(componentItems(panel()), []);
  const local = source("scout-local", "observed"),
    worker = source("scout-worker", "observed");
  const o = panel([local, worker]);
  assert.deepEqual(
    componentItems(o).map((i) => i.label),
    ["Scout local sources · Available", "Scout research worker · Docker untested"],
  );
  for (const [state, phrase] of [
    ["running", "Preparing research"],
    ["settled", "Brief saved"],
    ["failed", "Last attempt failed"],
    ["unknown", "Outcome unknown"],
  ] as const) {
    worker.items[0]!.state = state;
    const row = componentItems(o).at(-1)!;
    assert.ok(row.label.includes(phrase));
    assert.ok(row.briefDetails?.length);
  }
  const brief: DashboardContribution = {
    id: "brief",
    kind: "evidence",
    label: "Saved research brief",
    state: "observed",
  };
  assert.equal(isComponentObservation(worker, worker.items[0]!), true);
  assert.equal(isComponentObservation(worker, brief), false);
  assert.equal(isComponentObservation(source("other", "observed"), worker.items[0]!), false);
  o.now = new Date(Date.parse(when) + 60_001);
  assert.ok(componentItems(o).every((row) => row.label.includes("Live status unknown")));
  o.now = new Date(when);
  o.connected = false;
  assert.ok(componentItems(o).every((row) => row.label.includes("Live status unknown")));
});

test("Bookie installation, live command and selected work map each make a distinct claim", () => {
  const o = panel([], [bookie]);
  assert.match(componentItems(o)[0]!.label, /Installed · no live report/);
  assert.match(versionLines(bookie, true, o).join(" "), /Installed 0\.1\.3.*not reported a running version/);
  const loaded = { ...bookie, commandAvailable: true };
  const live = panel([], [loaded]);
  assert.match(componentItems(live)[0]!.label, /Available · no project reported/);
  assert.match(componentItems(live)[0]!.briefDetails!.join(" "), /\/bookie-work/);
  assert.match(versionLines(loaded, true, live).join(" "), /Active in Pi. Running version unreported/);
  const connected = source("bookie", "observed");
  connected.items = [{ id: "scope", label: "Project", kind: "goal", state: "observed" }];
  const mapped = panel([connected], [bookie]);
  assert.match(componentItems(mapped)[0]!.label, /Project connected/);
  connected.availability = "closed";
  assert.match(componentItems(mapped)[0]!.label, /Live status unknown/);
  assert.doesNotMatch(versionLines(bookie, true, mapped).join(" "), /Active in Pi/);
});

test("Saved results show what was retained, keep opaque identifiers in details, and never claim approval", () => {
  const ref = { executionId: "e".repeat(64), operationId: "principal:" + "a".repeat(64), sha256: "8".repeat(64) };
  const old = savedEvidenceItem(ref, 1);
  assert.equal(old.label, "Run record 2");
  const fresh = savedEvidenceItem(
    {
      ...ref,
      description: {
        agent: "review",
        summary: "Check the customer update",
        content: "answer",
        observedAt: when,
        state: "settled",
      },
    },
    0,
  );
  assert.equal(fresh.label, "Review · Check the customer update");
  assert.equal(fresh.status, "Saved");
  assert.ok(fresh.details.some((line) => line.includes(ref.operationId)));
  assert.ok(fresh.details.some((line) => line.includes(ref.sha256)));
  assert.doesNotMatch(
    [...fresh.briefDetails!, ...old.briefDetails!, fresh.label, old.label].join(" "),
    /principal:|[a-f0-9]{64}|approved/i,
  );
  const uncertain = savedEvidenceItem(
    {
      ...ref,
      description: {
        agent: "customer-update",
        content: "partial",
        observedAt: when,
        state: "uncertain",
      },
    },
    0,
  );
  assert.match(uncertain.label, /partial output/);
  assert.match(uncertain.status, /uncertain/);
});
