import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("daily steering and measured orders have explicit package entrypoints", async () => {
  const root = await import("../src/index.ts");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(typeof root.startDailyDashboardHost, "function");
  assert.equal(typeof root.discoverDailyIntentActions, "function");
  assert.equal(typeof root.createMeasuredOrder, "function");
  assert.deepEqual(manifest.exports["./daily-dashboard-host"], {
    types: "./dist/daily-dashboard-host.d.ts",
    default: "./dist/daily-dashboard-host.js",
  });
  assert.deepEqual(manifest.exports["./measured-order"], {
    types: "./dist/measured-order.d.ts",
    default: "./dist/measured-order.js",
  });
});
