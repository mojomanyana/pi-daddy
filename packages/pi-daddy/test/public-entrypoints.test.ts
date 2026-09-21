import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("daily steering and measured orders have explicit package entrypoints", async () => {
  const root = await import("../src/index.ts");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(typeof root.startDailyDashboardHost, "function");
  assert.equal(typeof root.discoverDailyIntentActions, "function");
  assert.equal(typeof root.createMeasuredOrder, "function");
  assert.deepEqual(manifest.exports["./dashboard"], {
    types: "./dist/products/dashboard-public.d.ts",
    default: "./dist/products/dashboard-public.js",
  });
  assert.deepEqual(manifest.exports["./work"], {
    types: "./dist/products/work-public.d.ts",
    default: "./dist/products/work-public.js",
  });
  assert.equal(Object.keys(manifest.exports).length, 9, "ADR-0076 PR 3b: the export map names layers, under ten keys");
});
