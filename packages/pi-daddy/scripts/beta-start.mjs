// Readme pins come from the most recently verified full-stack install. Updated packages
// outside that tested combination can still be installed individually.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { compareStableVersions } from "../src/kernel/stable-version.ts";

const root = new URL("../../../", import.meta.url);
const manifestFile = new URL("../src/products/ecosystem-release.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
const readme = new URL("README.md", root);
const text = readFileSync(readme, "utf8");
const start = "<!-- verified-beta-install:start -->";
const end = "<!-- verified-beta-install:end -->";
const bounds = [text.indexOf(start), text.indexOf(end)];
assert.ok(bounds[0] >= 0 && bounds[1] > bounds[0], "Missing installation block in README");
assert.equal(text.lastIndexOf(start), bounds[0], "Multiple installation blocks in README");
assert.equal(text.lastIndexOf(end), bounds[1], "Multiple installation blocks in README");
const command = process.argv[2];
assert.ok(process.argv.length <= 3 && [undefined, "--write", "--check-latest", "--refresh"].includes(command),
  "Usage: node beta-start.mjs [--write | --check-latest | --refresh]");
const originalPins = manifest.publicVersions;
const names = manifest.normalCliInstalls;
assert.ok(names.length > 0 && new Set(names).size === names.length, "Expected distinct, published Pi packages");
assert.deepEqual([...names].sort(), Object.keys(originalPins).sort());
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const minimum = manifest.minimumRuntime;
assert.match(manifest.piSdk, stable);
assert.match(minimum.pi, stable);
assert.ok(Number.isSafeInteger(minimum.nodeMajor) && minimum.nodeMajor > 0, "Expected a positive minimum Node major");
assert.ok(compareStableVersions(manifest.piSdk, minimum.pi) >= 0, "Tested Pi SDK is below the supported minimum");
for (const name of names) {
  assert.match(name, /^[a-z][a-z0-9-]*$/);
  assert.match(originalPins[name], stable);
}

// Network access is limited to release maintenance. Setup and ordinary PR checks use the recorded pins.
let pins = originalPins;
if (command === "--check-latest" || command === "--refresh") {
  const candidates = await Promise.all(names.map(async (name) => {
    const response = await fetch(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, `${name}: npm latest lookup returned HTTP ${response.status}`);
    const metadata = await response.json();
    assert.equal(metadata.name, name, `${name}: unexpected registry package identity`);
    assert.equal(typeof metadata.version, "string", `${name}: missing latest version`);
    assert.match(metadata.version, stable, `${name}: latest must be a stable release, got ${metadata.version}`);
    assert.ok(compareStableVersions(metadata.version, originalPins[name]) >= 0,
      `${name}: npm latest moved back from ${originalPins[name]} to ${metadata.version}. Review the tag before changing pins.`);
    return [name, metadata.version];
  }));
  pins = Object.fromEntries(candidates);
  const changes = names.filter((name) => originalPins[name] !== pins[name]);
  for (const name of changes) console.log(`${name}: ${originalPins[name]} -> ${pins[name]}`);
  if (changes.length === 0) console.log("The tested ecosystem matches npm latest.");
  // Fresh setup installs the extension matching its launcher. The manifest's Daddy
  // pin is the published reproduction baseline and can be refreshed separately.
  if (command === "--check-latest" && changes.length === 1 && changes[0] === "pi-daddy") {
    console.log(`Fresh setup uses the launcher-matched Daddy ${pins["pi-daddy"]}. Published reproduction uses ${originalPins["pi-daddy"]}; run beta-start.mjs --refresh to update it.`);
  } else if (command === "--check-latest" && changes.length) {
    console.error("Prepare a candidate with node packages/pi-daddy/scripts/beta-start.mjs --refresh and run the public install check on its PR.");
    process.exitCode = 1;
  }
}
const commands = names.map((name) => `pi install npm:${name}@${pins[name]}`);
const cli = `pi-daddy@${pins["pi-daddy"]}`;
const block = [
  "",
  `Requires Node ${minimum.nodeMajor}+ and stable Pi ${minimum.pi}+. Tested with Pi ${manifest.piSdk}.`,
  "",
  "```bash",
  ...commands,
  "",
  "# Optional on a fresh profile without ecosystem.json: initialize the open-weight preset (or use --preset google).",
  `# npx ${cli} setup --skip-install --preset open-weight`,
  "# Optional: put the matching standalone CLI on PATH for /dashboard split and pi-daddy panel.",
  `# npm install -g ${cli}`,
  "```",
  "",
].join("\n");
const updated = text.slice(0, bounds[0] + start.length) + block + text.slice(bounds[1]);

if (command === "--refresh" || command === "--write") {
  // Render and validate both outputs before replacing either tracked file.
  if (text !== updated) replaceFile(readme, updated);
  if (command === "--refresh" && names.some((name) => originalPins[name] !== pins[name])) {
    try {
      replaceFile(manifestFile, JSON.stringify({ ...manifest, publicVersions: pins }, null, 2) + "\n");
    } catch (error) {
      if (text !== updated) replaceFile(readme, text);
      throw error;
    }
  }
} else if (command === undefined) {
  assert.ok(text === updated, "The beta install block differs from the verified manifest. Run beta-start.mjs --write.");
}

function replaceFile(target, contents) {
  const temporary = new URL(target.href + "." + randomUUID() + ".tmp");
  try {
    writeFileSync(temporary, contents, { flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
