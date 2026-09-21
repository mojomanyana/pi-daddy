import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDailyPanel, learningSummary } from "../src/products/daily-panel.ts";
import { readDailyView } from "../src/products/daily-view.ts";
import { createDashboardMenu } from "../src/products/dashboard-menu.ts";
import { dashboardActionFeedback } from "../src/products/dashboard-cli.ts";

test("ordinary panel leads with outcome/state, escapes metadata, hides IDs and shows observed model/effort", async () => {
  const view = structuredClone(await readDailyView({}));
  view.scope = { kind: "scope", id: "protocol-scope", revision: 1, digest: "a".repeat(64) };
  view.attempts = [
    {
      executionId: "exec:opaque-id",
      logicalChildId: "d0.1",
      intentRuntime: "running",
      archive: null,
      sourceAvailability: [],
      issues: [],
      activeBranch: null,
      modelId: "provider/observed-model",
      effortId: "high",
    },
    {
      executionId: "exec:finished",
      logicalChildId: "d0.2",
      intentRuntime: "completed",
      archive: null,
      sourceAvailability: [],
      issues: [],
      activeBranch: null,
    },
  ];
  const text = renderDailyPanel(view, 48, {
    presentation: { outcome: "Ship a page\u001b[2J", obligations: [] },
    control: "running",
    actions: [{ choice: "1", label: "Pause new work" }],
    learning: ["Not configured"],
  });
  assert.ok(text.startsWith("PI-DADDY\nShip a page"));
  assert.match(text, /Running/);
  assert.match(text, /provider\/observed-model/);
  assert.match(text, /high/);
  assert.match(text, /Finished.*1/);
  assert.doesNotMatch(text, /exec:opaque|protocol-scope|snapshot-unknown|\u001b/);
  assert.match(text, /1\s+Pause new work/);
  assert.match(text, /Details/);
  assert.match(renderDailyPanel(view, 48, { connected: false }), /Snapshot only/);
});

test("long outcomes do not bury current choices; no ETA, acceptance or pending-exposure invention", async () => {
  const view = await readDailyView({}),
    text = renderDailyPanel(view, 32, {
      presentation: { outcome: "Long outcome ".repeat(500), obligations: [] },
      actions: [{ choice: "2", label: "Start dashboard" }],
      learning: learningSummary(null),
    });
  assert.ok(text.split("\n").findIndex((l) => l.includes("2 Start dashboard")) < 25);
  assert.doesNotMatch(text, /estimated|\bETA\b|\baccepted\b|earned questions: [1-9]/i);
  assert.match(
    learningSummary({
      cases: [],
      comparisons: [{ state: "deferred", title: "Profile trial", reason: "No independent quality judgment" }],
      trust: { reason: "bootstrap" },
    }).join("\n"),
    /No independent quality judgment/,
  );
});

test("numbered actions never acquire another meaning on repaint, and exact frame/request bindings travel with choice", () => {
  const menu = createDashboardMenu(),
    tip = "a".repeat(64),
    r = "b".repeat(64);
  const first = menu.show(tip, [
      { key: "cancel-old", label: "Cancel agent 1", operation: "ordinary-cancel", requestDigest: r },
    ]),
    number = first[0].choice;
  assert.equal(menu.select(number).key, "cancel-old");
  assert.equal(menu.select(number).tip, tip);
  assert.equal(menu.select(number).requestDigest, r);
  const next = menu.show("d".repeat(64), [
    { key: "cancel-new", label: "Cancel agent 2", operation: "ordinary-cancel", requestDigest: "c".repeat(64) },
  ]);
  assert.notEqual(next[0].choice, number);
  assert.throws(() => menu.select(number), /no longer displayed/);
  menu.show("e".repeat(64), []);
  assert.throws(() => menu.select(next[0].choice), /no longer displayed/);
});

test("host acknowledgement never becomes invented native application", () => {
  assert.match(
    dashboardActionFeedback("pause", { state: "acknowledged", result: { application: "pending-ordinary-boundary" } }),
    /pending/i,
  );
  assert.doesNotMatch(
    dashboardActionFeedback("pause", { state: "acknowledged", result: { application: "not-applied" } }),
    /^Applied/,
  );
  assert.match(dashboardActionFeedback("pause", { state: "refused", error: "changed selection" }), /changed selection/);
});
