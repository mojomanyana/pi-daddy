/** Unit tests for 5-tab Side-Panel Steering & Configuration Dashboard (cross-OS: macOS/Linux/Windows). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleConnectedCommand } from "../extensions/grants-connected-command.ts";
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
  } finally {
    await handle.close();
  }
});

test("/grants dashboard notifies with standalone Side Panel guidance for string and fallback results", async () => {
  const notices: Array<{ message: string; level: "info" | "error" }> = [];
  const ui = { notify: (message: string, level: "info" | "error") => notices.push({ message, level }) };
  assert.equal(
    await handleConnectedCommand("dashboard", undefined, {
      openDashboard: async () => "Use `/dashboard open` or `/dashboard split` for the standalone Side Panel.",
      ui,
    }),
    true,
  );
  assert.equal(
    await handleConnectedCommand("dashboard", undefined, {
      openDashboard: async () => ({ kind: "fallback", frame: "FALLBACK_FRAME", visibleBesideCaller: false }),
      ui,
    }),
    true,
  );
  assert.equal(
    await handleConnectedCommand("dashboard", undefined, {
      openDashboard: async () => {
        throw new Error("socket closed");
      },
      ui,
    }),
    true,
  );
  assert.equal(await handleConnectedCommand("other", undefined, { openDashboard: async () => "x", ui }), false);
  assert.deepEqual(notices, [
    { message: "Use `/dashboard open` or `/dashboard split` for the standalone Side Panel.", level: "info" },
    { message: "FALLBACK_FRAME", level: "info" },
    { message: "grants: dashboard unavailable — socket closed", level: "error" },
  ]);
});
