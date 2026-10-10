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
    assert.equal(changed.settings?.jev.available, false, "absence is not consent or a false ready state");
    await assert.rejects(request({ action: "set-jev", enabled: true }), /bridge unavailable/);
  } finally {
    await endpoint.close();
    await closeSessionAutoMode(session);
  }
});

test("JEV switch asks the native consent owner and exposes pending/readiness without sending consent or credentials", async () => {
  const session = await fixture();
  const events = new EventEmitter();
  const requests: Record<string, unknown>[] = [];
  let route: Record<string, unknown> = {
    selectedProvider: "typesafe",
    selectedModel: "jev-latest",
    transport: "pi-classifier",
    storageRoot: "/home/operator/.skill-harness",
  };
  events.on("skill-harness:jev-control-v1", (request) => {
    requests.push(request);
    request.reply({
      version: 1,
      requestId: request.requestId,
      sessionId: request.sessionId,
      pending: request.action === "enable",
      status: {
        enabled: false,
        mode: "disabled",
        storage: null,
        remaining: 0,
        availability: "disabled",
        providerReadiness: "missing-key",
        ...route,
      },
    });
  });
  registerDashboardSettings({ events } as unknown as ExtensionAPI, session);
  try {
    const response = await dashboardJev(session, "enable");
    assert.equal(response.pending, true);
    assert.equal(response.enabled, false, "an enable request is not consent");
    assert.equal(response.providerReadiness, "missing-key");
    assert.equal(response.selectedProvider, "typesafe");
    assert.equal(response.selectedModel, "jev-latest");
    assert.equal(response.transport, "pi-classifier");
    assert.equal(response.storageRoot, "/home/operator/.skill-harness");
    route = { selectedProvider: "\u001b[31munsafe", selectedModel: "model\nforged row", transport: "x".repeat(257) };
    const invalidRoute = await dashboardJev(session, "status");
    assert.equal(invalidRoute.selectedProvider, undefined);
    assert.equal(invalidRoute.selectedModel, undefined);
    assert.equal(invalidRoute.transport, undefined);
    assert.equal(invalidRoute.storageRoot, undefined);
    route = { selectedModel: "@cf/typesafe/jev", storageRoot: "/data/" + "long".repeat(40) };
    assert.equal((await dashboardJev(session, "status")).selectedModel, "@cf/typesafe/jev");
    assert.match((await dashboardJev(session, "status")).storageRoot!, /^\/data\/.+\.\.\.$/);
    route = { selectedProvider: "openrouter", selectedModel: "~typesafe/jev-latest" };
    assert.equal((await dashboardJev(session, "status")).selectedModel, "~typesafe/jev-latest");
    route = { storageRoot: "/data/\u001b[31munsafe" };
    assert.equal((await dashboardJev(session, "status")).storageRoot, undefined);
    route = {};
    const legacy = await dashboardJev(session, "status");
    assert.equal(legacy.available, true, "an older Harness without route fields remains connected");
    assert.equal(legacy.selectedModel, undefined);
    assert.deepEqual(Object.keys(requests[0]).sort(), ["action", "reply", "requestId", "sessionId", "version"]);
    assert.equal(requests[0].sessionId, "settings-native-session");
    assert.equal((await session.autoMode!.read()).enabled, false);
    events.removeAllListeners();
    events.on("skill-harness:jev-control-v1", (request) =>
      request.reply({
        version: 1,
        requestId: request.requestId,
        sessionId: "wrong-session",
        pending: false,
        status: { enabled: true },
      }),
    );
    await assert.rejects(dashboardJev(session, "enable"), /not acknowledged/);
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
    assert.match(frame, /Data: \/home\/operator\/.skill-harness/);
    display.key("down");
    assert.equal(display.screen.settingKey, "jev");
    assert.equal(display.key("return"), "setting");
    display.key("down");
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
    assert.match(draw(100, 30), /Auto never supplies that consent/);
    display.key("escape");
    assert.equal(display.screen.view, "main");
  } finally {
    await endpoint.close();
    await closeSessionAutoMode(session);
  }
});
