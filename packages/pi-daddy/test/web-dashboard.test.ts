/** Unit tests for standalone Side-Panel Steering & Configuration Dashboard (no Herdr; macOS/Linux/Windows). */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  startWebDashboard,
  type WebDashboardConfigUpdate,
  type WebDashboardState,
} from "../src/products/web-dashboard.ts";
import { standardWorkMode } from "../src/kernel/work-mode.ts";

test("side-panel dashboard enforces token auth and supports live steering, auto toggle, work mode, and config", async () => {
  let currentMode = standardWorkMode();
  let autoEnabled = false;
  let thinking = "low";
  const steered: Array<{ message: string; deliverAs: string }> = [];
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
  });
  try {
    // Rejects missing/bad token
    const denied = await fetch(`http://127.0.0.1:${handle.port}/api/state`);
    assert.equal(denied.status, 403);

    // Serves Side Panel HTML UI with valid token
    const htmlRes = await fetch(handle.url);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Live Steering/);
    assert.match(html, /Runtime Configuration/);

    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${handle.port}${path}?token=${handle.token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // Live steering
    assert.equal((await post("/api/steer", { message: "Focus on edge cases", deliverAs: "steer" })).status, 200);
    assert.deepEqual(steered, [{ message: "Focus on edge cases", deliverAs: "steer" }]);

    // Work mode
    assert.equal(
      (await post("/api/work-mode", { mode: "ambitious", emphases: ["depth"], scope: "session" })).status,
      200,
    );
    assert.deepEqual(currentMode, { mode: "ambitious", emphases: ["depth"] });

    // Auto toggle
    assert.equal((await post("/api/auto-mode", { enabled: true })).status, 200);
    assert.equal(autoEnabled, true);

    // Config: thinking + model tiers + tool toggle
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
    assert.equal(thinking, "high");
    assert.equal(modelTiers.strong, "fireworks/qwen3.8-max");
    assert.ok(activeTools.has("quick_review"));
  } finally {
    await handle.close();
  }
});
