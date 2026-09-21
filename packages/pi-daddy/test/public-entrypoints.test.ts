import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The big cleanup (0.31.0) removed every layer subpath: the root is the one public surface, and `contracts/*`
// is the only other export. Production change that breaks it: adding a subpath back, or dropping a delegate-path
// name from `src/index.ts`.
test("the root is the only code entrypoint and it carries the delegate path", async () => {
  const root = await import("../src/index.ts");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./contracts/*"]);
  for (const name of ["resolve", "planSpawn", "appendLedgerEvent", "readRecords", "runChild", "buildCatalog"])
    assert.equal(typeof (root as Record<string, unknown>)[name], "function", `root export missing: ${name}`);
});
