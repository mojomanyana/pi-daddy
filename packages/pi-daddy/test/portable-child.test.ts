/** Unit tests for portable cross-OS child runner (macOS/Windows) and ecosystem.json config/locator. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPortableChild } from "../src/executors/portable-child.ts";
import {
  loadEcosystemConfig,
  readPanelLocator,
  removePanelLocator,
  resolveEcosystemModelTier,
  saveEcosystemConfig,
  writePanelLocator,
} from "../src/kernel/ecosystem-config.ts";

test("runPortableChild executes commands cross-platform and streams stdout to onObservation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-daddy-portable-"));
  try {
    let observed = "";
    const res = await runPortableChild({
      executionId: "ex-1",
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello-portable')"],
      cwd: dir,
      env: process.env,
      ownershipDir: join(dir, "own"),
      captureStdout: true,
      onObservation: (stream, bytes) => {
        if (stream === "stdout") observed += Buffer.from(bytes).toString("utf8");
      },
    });
    assert.equal(res.code, 0);
    assert.equal(res.text, "hello-portable");
    assert.equal(observed, "hello-portable");
    assert.equal(res.cleanup.state, "settled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ecosystem.json config & panel auto-attach locator round-trip cleanly with env precedence", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-daddy-eco-cfg-"));
  const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: dir };
  try {
    saveEcosystemConfig({ models: { fast: "f/fast", strong: "f/strong" }, escalation: { auto: true } }, env);
    assert.equal(loadEcosystemConfig(env).models?.strong, "f/strong");
    assert.equal(resolveEcosystemModelTier("strong", env), "f/strong");
    assert.equal(
      resolveEcosystemModelTier("strong", { ...env, PI_ECO_MODEL_STRONG: "override/model" }),
      "override/model",
    );

    writePanelLocator(
      {
        url: "http://127.0.0.1:45123/?token=abc",
        port: 45123,
        pid: process.pid,
        cwd: dir,
        startedAt: "2026-11-24T00:00:00Z",
      },
      env,
    );
    const found = readPanelLocator(dir, env);
    assert.equal(found?.url, "http://127.0.0.1:45123/?token=abc");
    removePanelLocator(dir, process.pid, env);
    assert.equal(readPanelLocator(dir, env), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
