import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadEcosystemConfig, saveEcosystemConfig } from "../src/kernel/ecosystem-config.ts";
import release from "../src/products/ecosystem-release.json" with { type: "json" };
import { runEcosystemDoctor, runEcosystemSetup } from "../src/products/setup-doctor.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "daddy-setup-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const oldEnv = { ...process.env };
  const node = Object.getOwnPropertyDescriptor(process.versions, "node")!;
  Object.defineProperty(process.versions, "node", { ...node, value: `${release.minimumRuntime.nodeMajor}.0.0` });
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PATH = bin + delimiter + (process.env.PATH ?? "");
  const calls = join(root, "calls.log");
  process.env.DADDY_TEST_CALLS = calls;
  process.env.DADDY_TEST_PI = release.piSdk;
  process.env.DADDY_TEST_STATUS = "0";
  if (process.platform === "win32") {
    writeFileSync(
      join(bin, "pi.cmd"),
      '@echo off\r\nif "%1"=="--offline" (echo PI_DADDY_CATALOG {"providers":{},"models":{}} & exit /b 0)\r\nif "%1"=="--version" (echo %DADDY_TEST_PI% & exit /b 0)\r\necho %*>>"%DADDY_TEST_CALLS%"\r\nexit /b %DADDY_TEST_STATUS%\r\n',
    );
  } else {
    writeFileSync(
      join(bin, "pi"),
      '#!/bin/sh\nif [ "$1" = "--offline" ]; then echo \'PI_DADDY_CATALOG {"providers":{},"models":{}}\'; exit 0; fi\nif [ "$1" = "--version" ]; then echo "$DADDY_TEST_PI"; exit 0; fi\nprintf "%s\\n" "$*" >> "$DADDY_TEST_CALLS"\nexit "$DADDY_TEST_STATUS"\n',
      { mode: 0o700 },
    );
  }
  t.after(() => {
    Object.defineProperty(process.versions, "node", node);
    for (const key of [
      "PI_CODING_AGENT_DIR",
      "PATH",
      "PI_ECO_MODEL_FAST",
      "DADDY_TEST_CALLS",
      "DADDY_TEST_PI",
      "DADDY_TEST_STATUS",
    ]) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  const output: string[] = [];
  t.mock.method(console, "log", (message: string) => output.push(message));
  t.mock.method(console, "error", (message: string) => output.push(message));
  return { file: join(root, "ecosystem.json"), settings: join(root, "settings.json"), calls, output };
}

test("malformed config survives setup, skip-install and panel writes byte for byte", (t) => {
  const { file, calls, output } = fixture(t);
  const original = '{"models":{"fast":"local/test-cheap"},"bookie":{"autoRecall":false},}';
  writeFileSync(file, original);
  assert.equal(runEcosystemSetup({ preset: "google" }), 1);
  assert.equal(runEcosystemSetup({ skipInstall: true }), 1);
  assert.throws(() => saveEcosystemConfig({}), /Invalid JSON/);
  assert.equal(runEcosystemDoctor(), 1);
  assert.ok(output.some((s) => s.includes(file) && s.includes("Invalid JSON")));
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(existsSync(calls), false);
});

test("unsupported runtimes stop before package install or config creation", (t) => {
  const { file, calls, output } = fixture(t);
  for (const version of ["1.4.0", "1.6.0-rc.2", "unknown"]) {
    process.env.DADDY_TEST_PI = version;
    assert.equal(runEcosystemSetup(), 1);
    assert.equal(runEcosystemDoctor(), 1);
    assert.ok(output.some((s) => s.includes(version) && s.includes(release.minimumRuntime.pi)));
  }
  process.env.DADDY_TEST_PI = release.piSdk;
  Object.defineProperty(process.versions, "node", {
    configurable: true,
    value: `${release.minimumRuntime.nodeMajor - 1}.0.0`,
  });
  assert.equal(runEcosystemSetup(), 1);
  assert.equal(runEcosystemDoctor(), 1);
  assert.equal(existsSync(calls), false);
  assert.equal(existsSync(file), false);
});

test("setup and doctor honor a patch-level minimum independently of the qualified SDK", (t) => {
  const { file, output } = fixture(t);
  const previous = release.minimumRuntime.pi;
  release.minimumRuntime.pi = "3.2.15";
  t.after(() => {
    release.minimumRuntime.pi = previous;
  });
  process.env.DADDY_TEST_PI = "3.2.14";
  assert.equal(runEcosystemSetup(), 1);
  assert.equal(runEcosystemDoctor(), 1);
  assert.ok(output.some((line) => line.includes("pi CLI") && line.includes("3.2.14") && line.includes(">=3.2.15")));
  assert.equal(existsSync(file), false);
  process.env.DADDY_TEST_PI = "v3.2.15+build.12";
  assert.equal(runEcosystemSetup(), 0);
  process.env.DADDY_TEST_PI = "3.3.0";
  assert.equal(runEcosystemSetup(), 0);
});

test("an interrupted package update leaves existing settings intact and can be retried on newer Pi", (t) => {
  const { file, calls } = fixture(t);
  const original = '{"models":{"fast":"local/custom"},"extra":{"keep":true}}';
  writeFileSync(file, original);
  process.env.DADDY_TEST_PI = `${Number(release.minimumRuntime.pi.split(".")[0]) + 1}.0.0`;
  process.env.DADDY_TEST_STATUS = "9";
  assert.equal(runEcosystemSetup({ preset: "google" }), 1);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(readFileSync(calls, "utf8").trim().split(/\r?\n/).length, 1);
  process.env.DADDY_TEST_STATUS = "0";
  assert.equal(runEcosystemSetup({ preset: "google" }), 0);
  assert.equal(loadEcosystemConfig().models?.fast, "local/custom");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).extra, { keep: true });
  assert.equal(readFileSync(calls, "utf8").trim().split(/\r?\n/).length, 1 + release.normalCliInstalls.length);
});

test("normal setup uses the updateable Pi sources for every package", (t) => {
  const { calls, output } = fixture(t);
  assert.equal(runEcosystemSetup(), 0);
  assert.deepEqual(
    readFileSync(calls, "utf8").trim().split(/\r?\n/),
    release.normalCliInstalls.map((name) => `install npm:${name}`),
  );
  assert.ok(output.some((line) => line.includes("pi update --extensions")));
});

test("pinned setup uses this launcher for Daddy and tested release pins for all companions", (t) => {
  const { calls } = fixture(t);
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const previous = release.publicVersions["pi-daddy"];
  release.publicVersions["pi-daddy"] = "0.0.0";
  t.after(() => {
    release.publicVersions["pi-daddy"] = previous;
  });
  assert.equal(runEcosystemSetup({ pinned: true }), 0);
  const expected: Record<string, string> = { ...release.publicVersions, "pi-daddy": version };
  assert.deepEqual(
    readFileSync(calls, "utf8").trim().split(/\r?\n/),
    release.normalCliInstalls.map((name) => `install npm:${name}@${expected[name]}`),
  );
});

test("doctor reports exact ecosystem pins alongside their migration commands", (t) => {
  const { settings, output } = fixture(t);
  writeFileSync(
    settings,
    JSON.stringify({
      packages: [
        { source: "npm:pi-daddy@1.0.2", extensions: [] },
        "npm:pi-bookie",
        "npm:skill-harness@^1.0.1",
        "npm:unrelated@1.0.2",
      ],
    }),
  );
  runEcosystemDoctor();
  const pins = output.filter((line) => line.includes("Pinned source"));
  assert.equal(pins.length, 1);
  assert.ok(pins[0].includes(settings));
  assert.match(pins[0], /pi-daddy@1\.0\.2.*pi install npm:pi-daddy/);
});

test("explicit preset changes update managed tiers and preserve deliberate per-tier and boolean overrides", (t) => {
  const { file, calls, output } = fixture(t);
  assert.equal(runEcosystemSetup({ preset: "goggle", skipInstall: true }), 1);
  assert.equal(existsSync(file), false);
  assert.equal(runEcosystemSetup({ preset: "open-weight", skipInstall: true }), 0);
  const existing = loadEcosystemConfig();
  saveEcosystemConfig({
    ...existing,
    models: { ...existing.models, work: "local/my-work" },
    bookie: { autoRecall: false },
  });
  process.env.PI_ECO_MODEL_FAST = "local/environment";
  assert.equal(runEcosystemSetup({ preset: "google", skipInstall: true }), 0);
  assert.deepEqual(loadEcosystemConfig().models, {
    fast: "google/gemini-3.5-flash-lite",
    work: "local/my-work",
    strong: "google/gemini-3.8-flash",
  });
  assert.equal(loadEcosystemConfig().bookie?.autoRecall, false);
  assert.ok(output.some((s) => s.includes("fast=local/environment") && s.includes("work=local/my-work")));
  const settings = readFileSync(file, "utf8");
  assert.equal(runEcosystemSetup({ skipInstall: true }), 0);
  assert.equal(readFileSync(file, "utf8"), settings);
  assert.equal(existsSync(calls), false);
});

test("setup migrates untagged legacy presets when requested and preserves existing custom tiers", (t) => {
  const { file } = fixture(t);
  writeFileSync(
    file,
    JSON.stringify({ models: { fast: "fireworks/accounts/fireworks/models/glm-5p3-flash", work: "local/pinned" } }),
  );
  assert.equal(runEcosystemSetup({ preset: "google", skipInstall: true }), 0);
  assert.equal(loadEcosystemConfig().models?.fast, "google/gemini-3.5-flash-lite");
  assert.equal(loadEcosystemConfig().models?.work, "local/pinned");
});

test("fresh default setup follows the session model without assuming Fireworks credentials", (t) => {
  fixture(t);
  assert.equal(runEcosystemSetup({ skipInstall: true }), 0);
  const config = loadEcosystemConfig();
  assert.equal(config.setupPreset?.name, "session");
  assert.deepEqual(config.models, {});
});
