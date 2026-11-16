import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DASHBOARD_INVENTORY_BYTES,
  validDashboardInventory,
  validDashboardSourceUpdate,
  type DashboardInventory,
} from "../src/kernel/dashboard-observation.ts";

const inventory = (): DashboardInventory => ({
  scope: "Current workspace",
  state: "available",
  summary: "A bounded selection of saved research",
  count: 20,
  limited: true,
  entries: [
    { id: "one", title: "Print layout", summary: "Landscape pages fit the chart", reference: "saved/brief.json" },
  ],
});

test("inventory distinguishes exact empty, bounded content and unavailable scope", () => {
  assert.equal(validDashboardInventory(inventory()), true);
  const partial = inventory();
  delete partial.count;
  assert.equal(validDashboardInventory(partial), true);
  assert.equal(
    validDashboardInventory({ ...inventory(), entries: [], state: "empty", count: 0, limited: false }),
    true,
  );
  for (const state of ["unavailable", "unknown"]) {
    assert.equal(validDashboardInventory({ ...partial, state, entries: [] }), true);
    assert.equal(validDashboardInventory({ ...partial, state }), false);
    assert.equal(validDashboardInventory({ ...partial, state, entries: [], count: 0 }), false);
  }
  for (const value of [
    { ...inventory(), state: "empty", count: 0 },
    { ...inventory(), state: "empty", entries: [], count: 0 },
    { ...inventory(), state: "empty", entries: [], limited: false },
    { ...inventory(), count: -1 },
    { ...inventory(), count: 0 },
    { ...inventory(), count: 1.5 },
    { ...inventory(), action: "open" },
  ])
    assert.equal(validDashboardInventory(value), false);
});

test("inventory has a separate bounded UTF-8 budget and retains the legacy item and byte caps", () => {
  const contents = inventory();
  contents.entries = Array.from({ length: 12 }, (_, index) => ({
    id: `entry-${index}`,
    title: `Topic ${index}`,
    summary: "x".repeat(400),
  }));
  const update = { sequence: 1, items: [], inventory: contents };
  assert.ok(Buffer.byteLength(JSON.stringify(contents)) > 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(contents)) < DASHBOARD_INVENTORY_BYTES);
  assert.equal(validDashboardSourceUpdate(update), true);
  assert.equal(
    validDashboardSourceUpdate({
      ...update,
      items: Array.from({ length: 9 }, (_, i) => ({
        id: `${i}`,
        kind: "work",
        label: "a",
        state: "observed",
      })),
    }),
    false,
  );
  const rows = Array.from({ length: 8 }, (_, i) => ({
    id: `${i}`,
    kind: "work",
    label: "x".repeat(240),
    state: "observed",
    details: ["x".repeat(240)],
  }));
  assert.equal(validDashboardSourceUpdate({ ...update, items: rows }), false);
  assert.equal(
    validDashboardInventory({ ...contents, entries: [...contents.entries, { ...contents.entries[0], id: "13" }] }),
    false,
  );
  assert.equal(validDashboardInventory({ ...contents, entries: [contents.entries[0], contents.entries[0]] }), false);
  assert.equal(
    validDashboardInventory({
      ...contents,
      entries: contents.entries.map((entry) => ({ ...entry, summary: "界".repeat(400) })),
    }),
    false,
  );
  assert.equal(
    validDashboardInventory({ ...contents, entries: [{ ...contents.entries[0], title: "x".repeat(161) }] }),
    false,
  );
  assert.equal(
    validDashboardInventory({ ...contents, entries: [{ ...contents.entries[0], reference: "x".repeat(513) }] }),
    false,
  );
  assert.equal(
    validDashboardInventory({ ...contents, entries: [{ ...contents.entries[0], details: Array(7).fill("line") }] }),
    false,
  );
  assert.equal(validDashboardInventory({ ...contents, entries: [{ ...contents.entries[0], action: "run" }] }), false);
});
