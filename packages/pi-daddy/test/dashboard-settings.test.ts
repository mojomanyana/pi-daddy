import { renderExecutionControls } from "../extensions/execution-controls.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GrantsSession } from "../extensions/session.ts";
import { initializeSessionAutoMode, closeSessionAutoMode } from "../extensions/session-auto-mode.ts";
import {
  childExecutionLimits,
  setDashboardLimit,
  dashboardJev,
  registerDashboardSettings,
} from "../extensions/dashboard-settings.ts";
import { ensureDashboardSessionServer } from "../extensions/dashboard-session-server.ts";
import { dashboardSessionRequest } from "../src/products/dashboard-session-client.ts";
import { createCapacityAllocator } from "../src/kernel/capacity.ts";
import { newEpisodeId } from "../src/kernel/episode-id.ts";
import { createDashboardDisplayControls } from "../src/products/dashboard-display-controls.ts";
import { renderDashboardScreen } from "../src/products/dashboard-screen.ts";
import { cellWidth } from "../src/products/dashboard-render.ts";
import { dashboardSettingsLines, visibleSettingKeys } from "../src/products/dashboard-settings.ts";

async function fixture() {
  const session = {
    episodeId: newEpisodeId(),
    ownerBound: true,
    reloadLifecycle: { root: {} },
    definitions: new Map(),
    definitionRuntimeSettings: { definitions: new Map(), defaults: {} },
    definitionRuntimeOverrides: new Map(),
    capacity: createCapacityAllocator(8),
    maxDepth: 2,
  } as unknown as GrantsSession;
  await initializeSessionAutoMode(session, {}, "settings-native-session");
  return session;
}

test("operator timeout edits validate exact seconds, preserve captured work/env and stay bound to the native session", async () => {
  const session = await fixture();
  try {
    const env = { PI_DADDY_CHILD_TIMEOUT: "50", PI_DADDY_CHILD_IDLE_TIMEOUT: "20" };
    const admitted = childExecutionLimits(session, env);
    assert.equal(admitted.wallMs, 50_000);
    setDashboardLimit(session, "wall", 75);
    setDashboardLimit(session, "idle", 15);
    assert.equal(childExecutionLimits(session, env).wallMs, 75_000);
    assert.equal(childExecutionLimits(session, env).idleMs, 15_000);
    assert.match(
      renderExecutionControls(undefined, env, childExecutionLimits(session, env)).join("\n"),
      /child wall 75s \(session override; future children\)/,
    );
    assert.equal(admitted.wallMs, 50_000, "already captured child limits cannot change");
    assert.deepEqual(env, { PI_DADDY_CHILD_TIMEOUT: "50", PI_DADDY_CHILD_IDLE_TIMEOUT: "20" });
    for (const value of [-1, 1.5, NaN, Infinity, "45", 2_147_484])
      assert.throws(() => setDashboardLimit(session, "wall", value), /whole seconds/);
    assert.throws(() => setDashboardLimit(session, "descendants", 20), /Only child wall and idle/);
    assert.equal(childExecutionLimits(session, env).wallMs, 75_000);
    setDashboardLimit(session, "wall", 0);
    assert.equal(childExecutionLimits(session, env).wallMs, 21_600_000);
    await initializeSessionAutoMode(session, {}, "different-native-session");
    assert.equal(childExecutionLimits(session, env).wallMs, 50_000, "another session cannot inherit the edit");
    const state = session.reloadLifecycle.autoMode!;
    const authority = state.authority;
    delete state.authority;
    assert.throws(() => setDashboardLimit(session, "wall", 90), /owning root/);
    state.authority = authority;
  } finally {
    await closeSessionAutoMode(session);
  }
});

test("authenticated Settings transport uses the owner and leaves capacity reservations intact", async () => {
  const session = await fixture();
  const endpoint = await ensureDashboardSessionServer(session);
  const held = session.capacity.reserve("settings-held-child", 3);
  assert.equal(held.ok, true);
  try {
    const request = (value: Parameters<typeof dashboardSessionRequest>[2]) =>
      dashboardSessionRequest(endpoint.socketPath, endpoint.token, value);
    await assert.rejects(
      dashboardSessionRequest(endpoint.socketPath, "wrong", { action: "set-limit", key: "wall", seconds: 40 }),
      /unauthorised/,
    );
    const changed = await request({ action: "set-limit", key: "idle", seconds: 30 });
    assert.equal(changed.settings?.idleSeconds, 30);
    assert.equal(changed.settings?.idleSource, "session");
    assert.equal(changed.settings?.descendants, 8);
    assert.equal(changed.settings?.reserved, 4);
    assert.equal(changed.settings?.perCall, 8);
    assert.equal(session.capacity.available, 4);
    assert.equal(changed.settings?.jev.available, false, "JEV support is removed");
    await assert.rejects(request({ action: "set-jev", enabled: true }), /removed/);
  } finally {
    await endpoint.close();
    await closeSessionAutoMode(session);
  }
});

test("Settings names telemetry lifecycle states and never implies unsupported live token speed", async () => {
  const session = await fixture();
  try {
    const settings = await import("../extensions/dashboard-settings.ts").then(({ dashboardSettingsSnapshot }) =>
      dashboardSettingsSnapshot(session),
    );
    settings.telemetry = { enabled: true, status: "stale" };
    const lines = dashboardSettingsLines(settings, false, "auto", 100).join("\n");
    assert.match(lines, /stale/);
    assert.match(lines, /live prompt\/generation speed are unavailable/);
    settings.telemetry = {
      enabled: true,
      status: "stopped",
      gpuPercent: 0,
      temperatureC: 39,
      ramUsedBytes: 8 * 1024 ** 3,
      ramTotalBytes: 32 * 1024 ** 3,
    };
    const observed = dashboardSettingsLines(settings, false, "telemetry", 120).join("\n");
    assert.match(observed, /RAM: 8.0 \/ 32.0 GiB/);
    assert.match(observed, /GPU: 0%.*39°C/);
    assert.doesNotMatch(observed, /Shared RAM.*unavailable/);
    const keys = visibleSettingKeys(settings.jev, true);
    assert.equal(keys.indexOf("telemetry") + 1, keys.indexOf("wall"), "navigation follows display order");
    delete settings.telemetry;
    assert.equal(visibleSettingKeys(settings.jev).includes("telemetry"), false);
    assert.doesNotMatch(dashboardSettingsLines(settings, false, "auto", 100).join("\n"), /TELEMETRY|Shared system RAM/);
    settings.telemetry = { enabled: false, status: "disabled" };
    assert.match(dashboardSettingsLines(settings, false, "auto", 100).join("\n"), /disabled/);
  } finally {
    await closeSessionAutoMode(session);
  }
});

test("JEV settings bridge stays removed and disabled", async () => {
  const session = await fixture();
  try {
    const status = await dashboardJev(session, "status");
    assert.equal(status.available, false);
    assert.equal(status.enabled, false);
    await assert.rejects(dashboardJev(session, "enable"), /removed/);
  } finally {
    await closeSessionAutoMode(session);
  }
});

test("Settings navigation fits narrow panes and distinguishes pending consent, editable timeouts and startup-only caps", async () => {
  const session = await fixture();
  const endpoint = await ensureDashboardSessionServer(session);
  try {
    const snapshot = await dashboardSessionRequest(endpoint.socketPath, endpoint.token, { action: "get" });
    snapshot.settings!.jev = {
      available: true,
      enabled: false,
      pending: true,
      storage: null,
      remaining: 0,
      availability: "missing-key",
      providerReadiness: "missing-key",
      selectedProvider: "openrouter",
      selectedModel: "typesafe/jev-1.13",
      transport: "pi-classifier",
      storageRoot: "/home/operator/.skill-harness",
    };
    const display = createDashboardDisplayControls(false, true);
    display.key("s");
    const draw = (width = 44, height = 16) =>
      renderDashboardScreen({ width, height, screen: display.screen, items: [], session: snapshot });
    let frame = draw();
    assert.match(frame, /SETTINGS.*current session/);
    assert.match(frame, /JEV: waiting for consent/);
    assert.match(frame, /missing-key/);
    assert.match(frame, /Model: openrouter\/typesafe\/jev-1.13/);
    assert.match(frame, /Via: pi-classifier/);
    assert.match(draw(44, 24), /Data: \/home\/operator\/.skill-harness/);
    display.key("down");
    assert.equal(display.screen.settingKey, "jev");
    assert.equal(display.key("return"), "setting");
    display.key("down");
    assert.equal(display.screen.settingKey, "telemetry");
    assert.match(draw(), /> Telemetry: disabled/);
    display.key("down");
    assert.equal(display.screen.settingKey, "wall");
    display.key("down");
    assert.equal(display.screen.settingKey, "idle");
    frame = draw();
    assert.match(frame, /> Child idle/);
    assert.equal(frame.split("\n").length, 16);
    assert.ok(frame.split("\n").every((line) => cellWidth(line) <= 44));
    display.key("down");
    assert.equal(display.screen.settingKey, "descendants");
    assert.match(draw(), /> Active descendants/);
    display.key("down");
    display.key("down");
    assert.equal(display.screen.settingKey, "perCall");
    assert.match(draw(), /> Children per call/);
    assert.match(draw(100, 30), /STARTUP LIMITS.*restart/);
    assert.match(draw(100, 36), /JEV: waiting for consent\n    Pi asks before paid calls or storage/);
    display.key("escape");
    assert.equal(display.screen.view, "main");
  } finally {
    await endpoint.close();
    await closeSessionAutoMode(session);
  }
});


