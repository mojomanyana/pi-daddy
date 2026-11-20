// Readme pins come from the most recently verified full-stack install. Updated packages
// outside that tested combination can still be installed individually.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL(".github/beta-release.json", root), "utf8"));
const readme = new URL("README.md", root);
const text = readFileSync(readme, "utf8");
const start = "<!-- verified-beta-install:start -->";
const end = "<!-- verified-beta-install:end -->";
const bounds = [text.indexOf(start), text.indexOf(end)];
assert.ok(bounds[0] >= 0 && bounds[1] > bounds[0], "Missing installation block in README");
assert.equal(text.lastIndexOf(start), bounds[0], "Multiple installation blocks in README");
assert.equal(text.lastIndexOf(end), bounds[1], "Multiple installation blocks in README");
const pins = manifest.publicVersions;
const names = manifest.normalCliInstalls;
assert.ok(names.length > 0 && new Set(names).size === names.length, "Expected distinct, published Pi packages");
assert.deepEqual([...names].sort(), Object.keys(pins).sort());
assert.match(manifest.piSdk, /^\d+\.\d+\.\d+$/);
assert.ok(text.slice(0, bounds[0]).includes(`Pi ${manifest.piSdk}`), "Name the tested Pi version in Start here");

const commands = names.map((name) => {
  assert.match(name, /^[a-z][a-z0-9-]*$/);
  assert.match(pins[name], /^\d+\.\d+\.\d+$/);
  return `pi install npm:${name}@${pins[name]}`;
});
const block = ["", "```bash", ...commands, "```", ""].join("\n");
const updated = text.slice(0, bounds[0] + start.length) + block + text.slice(bounds[1]);

if (process.argv[2] === "--write") {
  writeFileSync(readme, updated);
} else {
  assert.equal(process.argv.length, 2, "Usage: node beta-start.mjs [--write]");
  assert.ok(text === updated, "The beta install block differs from the verified manifest. Run beta-start.mjs --write.");
}
