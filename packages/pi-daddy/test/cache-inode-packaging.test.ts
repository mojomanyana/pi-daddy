import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
test("publisher ships a static unprivileged observer, never installs or grants it host capabilities", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(manifest.scripts.build, /build-cache-inode\.ts/);
  assert.ok(manifest.files.includes("dist"));
  const source = await readFile(new URL("../scripts/build-cache-inode.ts", import.meta.url), "utf8");
  assert.match(source, /"-static"/);
  assert.match(source, /helper must be static/);
  assert.doesNotMatch(source, /execFile\)\("(?:sudo|setcap|install)"/);
});
