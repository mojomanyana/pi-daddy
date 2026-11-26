/** Exercise the shipped setup CLI against a separate, real offline Pi install. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test(
  "offline Pi rejects a failed key command and routes usable Codex credentials only to Codex",
  {
    skip: Number(process.versions.node.split(".")[0]) < 24 && "setup requires Node 24",
  },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "daddy catalog "));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const profile = join(root, "relative profile");
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(profile);
    const sdk = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    const pi = process.env.DADDY_TEST_PI_CLI || join(sdk, "bundle", "cli.js");
    const win = process.platform === "win32";
    writeFileSync(
      join(bin, win ? "pi.cmd" : "pi"),
      win
        ? '@echo off\r\n@"%DADDY_TEST_NODE%" "%DADDY_TEST_CATALOG_PI%" %*\r\n'
        : '#!/bin/sh\nexec "$DADDY_TEST_NODE" "$DADDY_TEST_CATALOG_PI" "$@"\n',
      { mode: 0o700 },
    );
    const env: NodeJS.ProcessEnv = {
      PI_CODING_AGENT_DIR: "relative profile",
      PI_OFFLINE: "1",
      HOME: root,
      USERPROFILE: root,
      PATH: bin + delimiter + (process.env.PATH ?? ""),
      DADDY_TEST_NODE: process.execPath,
      DADDY_TEST_CATALOG_PI: pi,
    };
    for (const key of ["SystemRoot", "ComSpec", "TEMP", "TMP", "TMPDIR", "PATHEXT", "LOCALAPPDATA"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const cli = resolve(import.meta.dirname, "../../src/cli.ts");
    const invoke = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], { env, cwd: root, encoding: "utf8", timeout: 60000 });
    writeFileSync(
      join(profile, "auth.json"),
      JSON.stringify({
        anthropic: { type: "api_key", key: "!exit 1" },
        "openai-codex": {
          type: "oauth",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: Date.now() + 86400000,
        },
      }),
    );
    const settings = join(profile, "ecosystem.json");
    writeFileSync(settings, JSON.stringify({ models: { strong: "local/custom" } }));
    const result = invoke("setup", "--preset", "auto", "--skip-install");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const cfg = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(cfg.setupPreset.name, "openai-codex");
    assert.match(cfg.models.work, /^openai-codex\//);
    assert.equal(cfg.models.strong, "local/custom");
    assert.match(result.stdout, /anthropic: stored credential did not resolve/);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-access|synthetic-refresh/);

    env.PI_ECO_MODEL_FAST = "session,google/absent";
    const doctor = invoke("doctor");
    assert.match(doctor.stdout, /fast: active Pi session/);
    assert.match(doctor.stdout, /strong: local\/custom unavailable in Pi's offline catalog/);
    assert.match(doctor.stdout, /anthropic: stored credential did not resolve/);
    assert.doesNotMatch(doctor.stdout, /fast: google\/absent/);
    assert.equal(readFileSync(settings, "utf8").includes("synthetic-"), false);
  },
);
