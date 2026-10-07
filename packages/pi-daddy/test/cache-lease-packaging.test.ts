import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("normal publisher build ships the static helper without installing or granting capabilities", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(manifest.scripts.build, /build-cache-lease\.ts/);
  assert.ok(manifest.files.includes("dist"));
  const source = await readFile(new URL("../scripts/build-cache-lease.ts", import.meta.url), "utf8");
  assert.match(source, /"-static"/);
  assert.match(source, /helper must be static/);
  assert.doesNotMatch(source, /execFile\)\("(?:sudo|setcap|install)"/);
});
