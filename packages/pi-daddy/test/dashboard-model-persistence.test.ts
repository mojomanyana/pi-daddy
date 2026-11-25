import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GrantsSession } from "../extensions/session.ts";
import { registerWebDashboard } from "../extensions/web-dashboard.ts";
import { ecosystemConfigPath, readPanelLocator } from "../src/kernel/ecosystem-config.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("dashboard model edits report a damaged profile and take effect only after a successful save", async (t) => {
  const cwd = await tempDir("daddy-panel-models-");
  const originalEnv = { ...process.env };
  t.after(() => {
    for (const key of ["PI_CODING_AGENT_DIR", "PI_ECO_MODEL_FAST", "PI_ECO_MODEL_WORK"]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });
  process.env.PI_CODING_AGENT_DIR = cwd;
  process.env.PI_ECO_MODEL_FAST = "local/original-fast";
  process.env.PI_ECO_MODEL_WORK = "local/original-work";
  const file = ecosystemConfigPath();
  const damaged = '{"models":';
  await writeFile(file, damaged);
  let dashboard!: Parameters<ExtensionAPI["registerCommand"]>[1];
  let thinking = "low";
  const pi = {
    on() {},
    registerCommand(_name: string, command: typeof dashboard) {
      dashboard = command;
    },
    setThinkingLevel(value: string) {
      thinking = value;
    },
  } as unknown as ExtensionAPI;
  const ctx = { cwd, hasUI: false, ui: { notify() {} } } as unknown as ExtensionCommandContext;
  registerWebDashboard(pi, { cwd, reloadLifecycle: {} } as unknown as GrantsSession);
  await dashboard.handler("", ctx);
  try {
    const locator = readPanelLocator(cwd);
    assert.ok(locator);
    const endpoint = new URL(locator.url);
    endpoint.pathname = "/api/config";
    const apply = () =>
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thinking: "high", modelTiers: { fast: " local/updated ", work: "" } }),
      });
    const refused = await apply();
    assert.equal(refused.status, 400);
    const { error } = (await refused.json()) as { error: string };
    assert.match(error, /Invalid JSON/);
    assert.ok(error.includes(file));
    assert.equal(await readFile(file, "utf8"), damaged);
    assert.equal(process.env.PI_ECO_MODEL_FAST, "local/original-fast");
    assert.equal(process.env.PI_ECO_MODEL_WORK, "local/original-work");
    assert.equal(thinking, "low");

    const repaired = JSON.stringify({ models: { work: "local/on-disk", strong: "local/keep" }, extra: true });
    await writeFile(file, repaired);
    const rename = t.mock.method(fs, "renameSync", () => {
      throw new Error("profile write refused");
    });
    syncBuiltinESMExports();
    try {
      const failed = await apply();
      assert.equal(failed.status, 400);
      assert.deepEqual(await failed.json(), { error: "profile write refused" });
      assert.equal(await readFile(file, "utf8"), repaired);
      assert.equal(process.env.PI_ECO_MODEL_FAST, "local/original-fast");
      assert.equal(process.env.PI_ECO_MODEL_WORK, "local/original-work");
      assert.equal(thinking, "low");
    } finally {
      rename.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal((await apply()).status, 200);
    assert.equal(process.env.PI_ECO_MODEL_FAST, "local/updated");
    assert.equal(process.env.PI_ECO_MODEL_WORK, undefined);
    assert.equal(thinking, "high");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      models: { strong: "local/keep", fast: "local/updated" },
      extra: true,
    });
  } finally {
    await dashboard.handler("stop", ctx);
  }
});
