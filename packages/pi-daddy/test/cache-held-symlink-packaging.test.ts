import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
test("publisher ships static unprivileged held-target leaf; recipients never compile/install/grant it capabilities", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.build, /build-cache-held-symlink\.ts/);
  const source = await readFile(new URL("../scripts/build-cache-held-symlink.ts", import.meta.url), "utf8");
  assert.match(source, /"-static"/);
  assert.match(source, /helper must be static/);
  assert.doesNotMatch(source, /execFile\)\("(?:sudo|setcap|install)"/);
});
