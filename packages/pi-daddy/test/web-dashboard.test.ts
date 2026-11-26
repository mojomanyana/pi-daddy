/** Unit tests for 5-tab Side-Panel Steering & Configuration Dashboard (no Herdr; macOS/Linux/Windows). */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  startWebDashboard,
  type WebDashboardConfigUpdate,
  type WebDashboardState,
} from "../src/products/web-dashboard.ts";
import { renderTerminalPanel } from "../src/products/terminal-panel.ts";
import { standardWorkMode } from "../src/kernel/work-mode.ts";

test("side-panel dashboard enforces token auth and supports steering, auto, work mode, config, escalate, and 5 terminal tabs", async () => {
  let currentMode = standardWorkMode();
  let autoEnabled = false;
  let thinking = "low";
  const steered: Array<{ message: string; deliverAs: string }> = [];
  const escalations: string[] = [];
  const harvests: string[] = [];
  const activeTools = new Set(["read", "bash", "edit", "write", "delegate"]);
  const modelTiers = { fast: "", work: "", strong: "" };

  const makeState = (): WebDashboardState => ({
    sessionId: "s-1",
    cwd: "/workspace/demo",
    platform: `${process.platform}/${process.arch}`,
    model: "google/gemini-3.8-flash",
    thinking,
    autoEnabled,
    activeTools: [...activeTools],
    optionalTools: ["delegate_tournament", "quick_review"],
    modelTiers: { ...modelTiers },
    workMode: { available: true, selection: currentMode, inherited: false },
    busy: false,
    usage: {
      inputTokens: 12000,
      outputTokens: 800,
      cacheReadTokens: 36000,
      cacheHitPct: 75,
      costUsd: 0.0123,
      turns: 4,
    },
    tasks: [{ at: "2026-11-24T08:00:01.000Z", kind: "delegate_tournament", status: "done", detail: "2 candidates" }],
    memoryLines: ["Bookie memory (ready · 5 notes)"],
    researchLines: ["Scout brief (1 saved)"],
    recentEvents: [{ at: "2026-11-24T08:00:00.000Z", kind: "agent", detail: "ready" }],
  });

  const handle = await startWebDashboard({
    getState: makeState,
    onPreferences: (input) => ({action:input.action, current:"fixture/agent"}),
    onClassifierSettings: async (input) => ({ action: input.action, selected: "local/kev" }),
    onWorkModeChange: (sel) => {
      currentMode = sel;
    },
    onSteer: (message, deliverAs) => {
      steered.push({ message, deliverAs });
    },
    onAutoModeChange: (enabled) => {
      autoEnabled = enabled;
    },
    onConfigChange: (patch: WebDashboardConfigUpdate) => {
      if (patch.thinking) thinking = patch.thinking;
      if (patch.modelTiers) Object.assign(modelTiers, patch.modelTiers);
      if (patch.toggleTool) {
        if (patch.toggleTool.enabled) activeTools.add(patch.toggleTool.name);
        else activeTools.delete(patch.toggleTool.name);
      }
    },
    onEscalate: (reason) => {
      escalations.push(reason ?? "manual");
    },
    onHarvest: (reason) => {
      harvests.push(reason ?? "manual");
      return { saved: true, scenarioId: "auth-fix", path: "/tmp/spec.yaml" };
    },
  });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${handle.port}/api/state`)).status, 403);
    assert.match(await (await fetch(handle.url)).text(), /Live Steering/);

    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${handle.port}${path}?token=${handle.token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    assert.equal((await post("/api/steer", { message: "Focus on edge cases", deliverAs: "steer" })).status, 200);
    assert.deepEqual(await (await post("/api/classifiers", { action: "list" })).json(), {
      action: "list",
      selected: "local/kev",
    });
    assert.deepEqual(await (await post("/api/preferences",{action:"list"})).json(),{action:"list",current:"fixture/agent"});
    const client = await (await fetch(handle.url)).text();
    assert.match(client, /id="ecosystem-settings"/);
    assert.match(client, /id="classifier-threshold"/);
    assert.match(client, /Test with a synthetic turn/);
    assert.match(client, /id="ecosystem-activity"/);
    new Function(client.match(/<script>([\s\S]*?)<\/script>/)![1]!);
    assert.deepEqual(steered, [{ message: "Focus on edge cases", deliverAs: "steer" }]);
    assert.equal(
      (await post("/api/work-mode", { mode: "ambitious", emphases: ["depth"], scope: "session" })).status,
      200,
    );
    assert.equal((await post("/api/auto-mode", { enabled: true })).status, 200);
    assert.equal(
      (
        await post("/api/config", {
          thinking: "high",
          modelTiers: { strong: "fireworks/qwen3.8-max" },
          toggleTool: { name: "quick_review", enabled: true },
        })
      ).status,
      200,
    );
    assert.equal((await post("/api/escalate", { reason: "thrash" })).status, 200);
    assert.deepEqual(escalations, ["thrash"]);
    const harvestResp = await post("/api/harvest", { reason: "panel" });
    assert.equal(harvestResp.status, 200);
    assert.equal(((await harvestResp.json()) as { scenarioId?: string }).scenarioId, "auth-fix");
    assert.deepEqual(harvests, ["panel"]);

    // Verify all 5 terminal side-panel tabs render cleanly (including [h] harvest key)
    const s = makeState();
    assert.match(renderTerminalPanel(s, "ok", 80, 1), /\$0\.0123.*75% cache/);
    assert.match(renderTerminalPanel(s, "ok", 80, 1), /\[h\] harvest/);
    assert.match(renderTerminalPanel(s, "ok", 80, 2), /delegate_tournament/);
    assert.match(renderTerminalPanel(s, "ok", 80, 3), /Bookie memory/);
    assert.match(renderTerminalPanel(s, "ok", 80, 4), /Scout brief/);
    assert.match(renderTerminalPanel(s, "ok", 80, 5), /fireworks\/qwen3\.8-max/);
    const compact = renderTerminalPanel(s, "", 42, 5, 14);
    assert.match(compact, /\[c\] Select model/);
    assert.ok(compact.split("\n").length <= 14);
    assert.ok(compact.split("\n").every(line => [...line].length <= 42));
    assert.match(renderTerminalPanel(s, "", 42, 5, 14, 999), /Optional tools/);
  } finally {
    await handle.close();
  }
});
