import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "daddy-release-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, "packages", "pi-daddy");
  mkdirSync(join(pkg, "scripts"), { recursive: true });
  mkdirSync(join(pkg, "src", "products"), { recursive: true });
  mkdirSync(join(pkg, "src", "kernel"), { recursive: true });
  copyFileSync(
    new URL("../src/kernel/stable-version.ts", import.meta.url),
    join(pkg, "src", "kernel", "stable-version.ts"),
  );
  const script = join(pkg, "scripts", "beta-start.mjs");
  copyFileSync(new URL("../scripts/beta-start.mjs", import.meta.url), script);
  const manifest = join(pkg, "src", "products", "ecosystem-release.json");
  const readme = join(root, "README.md");
  const initialPins = { "pi-daddy": "1.0.2", "pi-bookie": "1.9.0" };
  writeFileSync(
    manifest,
    JSON.stringify({
      piSdk: "1.7.0",
      minimumRuntime: { pi: "1.6.5", nodeMajor: 24 },
      normalCliInstalls: Object.keys(initialPins),
      publicVersions: initialPins,
    }),
  );
  writeFileSync(readme, "<!-- verified-beta-install:start -->\n<!-- verified-beta-install:end -->\n");
  const stub = join(root, "registry.mjs");
  writeFileSync(
    stub,
    `globalThis.fetch = async (url) => {
    const match = /^https:\\/\\/registry\\.npmjs\\.org\\/(pi-daddy|pi-bookie)\\/latest$/.exec(url);
    if (!match) throw new Error("unexpected registry URL");
    const data = JSON.parse(process.env.REGISTRY_FIXTURE)[match[1]];
    return data ? Response.json(data) : new Response(null, { status: 404 });
  };`,
  );
  function run(mode: string, metadata: Record<string, unknown>) {
    return spawnSync(process.execPath, ["--import", pathToFileURL(stub).href, script, mode], {
      encoding: "utf8",
      env: { ...process.env, REGISTRY_FIXTURE: JSON.stringify(metadata) },
    });
  }
  assert.equal(run("--write", {}).status, 0);
  const snapshot = () => [readFileSync(manifest, "utf8"), readFileSync(readme, "utf8")];
  return { run, snapshot, manifest };
}

test("minimum host requirements and the tested SDK are independently checked and rendered", (t) => {
  const { run, snapshot, manifest } = fixture(t);
  const [before, guide] = snapshot();
  assert.match(guide, /Requires Node 24\+ and stable Pi 1\.6\.5\+\. Tested with Pi 1\.7\.0\./);
  const bad = JSON.parse(before);
  bad.piSdk = "1.6.4";
  writeFileSync(manifest, JSON.stringify(bad));
  const invalid = run("--write", {});
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Tested Pi SDK is below the supported minimum/);
  assert.equal(snapshot()[1], guide);
});

test("a stale check is read-only; a refresh stages the proposed pins and matching quickstart", (t) => {
  const { run, snapshot } = fixture(t);
  const latest = {
    "pi-daddy": { name: "pi-daddy", version: "1.0.3" },
    "pi-bookie": { name: "pi-bookie", version: "1.10.0" },
  };
  const before = snapshot();
  const check = run("--check-latest", latest);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /pi-bookie: 1\.9\.0 -> 1\.10\.0/);
  assert.deepEqual(snapshot(), before);
  const refresh = run("--refresh", latest);
  assert.equal(refresh.status, 0, refresh.stderr);
  const after = snapshot();
  assert.deepEqual(JSON.parse(after[0]).publicVersions, { "pi-daddy": "1.0.3", "pi-bookie": "1.10.0" });
  assert.ok(after[1].includes("pi install npm:pi-bookie@1.10.0"));
  assert.equal(run("--check-latest", latest).status, 0);
  assert.equal(run("--refresh", latest).status, 0);
  assert.deepEqual(snapshot(), after);
});

test("a newer launcher alone is informational and can be explicitly qualified", (t) => {
  const { run, snapshot } = fixture(t);
  const registry = {
    "pi-daddy": { name: "pi-daddy", version: "1.0.3" },
    "pi-bookie": { name: "pi-bookie", version: "1.9.0" },
  };
  const before = snapshot();
  const check = run("--check-latest", registry);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /launcher-matched Daddy 1\.0\.3.*reproduction uses 1\.0\.2.*--refresh/);
  assert.deepEqual(snapshot(), before);
  const refresh = run("--refresh", registry);
  assert.equal(refresh.status, 0, refresh.stderr);
  assert.equal(JSON.parse(snapshot()[0]).publicVersions["pi-daddy"], "1.0.3");
});

test("missing, misidentified, prerelease and regressed latest tags leave the entire suite intact", (t) => {
  const { run, snapshot } = fixture(t);
  const before = snapshot();
  for (const bookie of [
    undefined,
    { name: "something-else", version: "1.10.0" },
    { name: "pi-bookie", version: "2.0.0-rc.1" },
    { name: "pi-bookie", version: "1.8.9" },
  ]) {
    const result = run("--refresh", { "pi-daddy": { name: "pi-daddy", version: "1.0.3" }, "pi-bookie": bookie });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pi-bookie/);
    assert.deepEqual(snapshot(), before);
  }
});
