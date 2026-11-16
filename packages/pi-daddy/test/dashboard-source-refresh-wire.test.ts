import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { registerDashboardSources } from "../extensions/dashboard-sources.ts";
import { ensureDashboardSessionServer } from "../extensions/dashboard-session-server.ts";
import { initializeSessionAutoMode, closeSessionAutoMode } from "../extensions/session-auto-mode.ts";
import type { GrantsSession } from "../extensions/session.ts";
import { newEpisodeId } from "../src/kernel/episode-id.ts";
import {
  DASHBOARD_RESPONSE_BYTES,
  DASHBOARD_SOURCE_EVENT,
  type DashboardSourceRegistrationReply,
  type DashboardSourceUpdate,
} from "../src/kernel/dashboard-observation.ts";
import { createDashboardConnection, dashboardSessionRequest } from "../src/products/dashboard-session-client.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);

test("visible zero-choice dashboard requests authenticated bounded refresh and carries inventories beyond the legacy response budget", async () => {
  const events = new Map<string, (value: unknown) => void>();
  const owner = { sessionId: "native", cwd: "/work" };
  const sources = registerDashboardSources(
    {
      events: {
        on(name: string, fn: (value: unknown) => void) {
          events.set(name, fn);
          return () => events.delete(name);
        },
      },
    } as never,
    () => owner,
  );
  let calls = 0,
    release!: (value: DashboardSourceUpdate) => void;
  const publishers: Array<Extract<DashboardSourceRegistrationReply, { ok: true }>> = [];
  const contents: DashboardSourceUpdate = {
    sequence: 0,
    items: Array.from({ length: 8 }, (_, i) => ({
      id: `work-${i}`,
      kind: "work",
      state: "observed",
      label: "l".repeat(80),
      details: ["d".repeat(160)],
    })),
    inventory: {
      scope: "Current workspace",
      state: "available",
      summary: "Saved local project topics",
      count: 12,
      limited: false,
      entries: Array.from({ length: 12 }, (_, i) => ({
        id: `note-${i}`,
        title: `Topic ${i}`,
        summary: "s".repeat(480),
        details: ["d".repeat(60)],
      })),
    },
  };
  for (let i = 0; i < 8; i++)
    events.get(DASHBOARD_SOURCE_EVENT)!({
      version: 1,
      ...owner,
      producer: `source-${i}`,
      producerVersion: "1",
      ...(i === 0
        ? {
            refresh() {
              calls++;
              return new Promise((resolve) => {
                release = resolve;
              });
            },
          }
        : {}),
      reply(value: DashboardSourceRegistrationReply) {
        assert.ok(value.ok);
        publishers.push(value);
      },
    });
  for (const publisher of publishers.slice(1)) assert.equal(publisher.publish(contents), true);
  const session = {
    episodeId: newEpisodeId(),
    ownerBound: true,
    reloadLifecycle: { root: {} },
    definitions: new Map(),
    definitionRuntimeSettings: { definitions: new Map(), defaults: {} },
    definitionRuntimeOverrides: new Map(),
    dashboardObservations: sources.snapshot,
    dashboardChoices: sources.choices,
    dashboardRefreshSources: sources.requestRefresh,
  } as unknown as GrantsSession;
  await initializeSessionAutoMode(session, {}, "source-refresh-wire-test");
  const endpoint = await ensureDashboardSessionServer(session);
  try {
    const send = (action: Parameters<typeof dashboardSessionRequest>[2]) =>
      dashboardSessionRequest(endpoint.socketPath, endpoint.token, action);
    const connection = createDashboardConnection(send);
    await connection.refresh();
    assert.equal(calls, 0);
    await assert.rejects(
      dashboardSessionRequest(endpoint.socketPath, "wrong", { action: "get", refreshSources: true }),
      /unauthorised/,
    );
    assert.equal(calls, 0);
    await connection.refresh(undefined, true);
    await connection.refresh(undefined, true);
    assert.equal(calls, 1);
    assert.equal(connection.state.snapshot?.choiceControls, undefined);
    assert.equal(connection.state.snapshot?.observation?.sources[0].refresh?.state, "checking");
    release(contents);
    await new Promise((resolve) => setImmediate(resolve));
    await connection.refresh(undefined, true);
    assert.equal(calls, 1);
    const snapshot = connection.state.snapshot!;
    assert.equal(snapshot.observation?.sources[0].refresh?.state, "idle");
    assert.equal(snapshot.observation?.sources[0].inventory?.entries.length, 12);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 64 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < DASHBOARD_RESPONSE_BYTES);
    assert.doesNotMatch(JSON.stringify(snapshot), /sourceRefreshRequested|choiceRefreshRequested/);
    const replay = createDashboardConnection(async () => snapshot);
    await replay.refresh();
    assert.ok(replay.state.snapshot?.observation?.sources[0].inventory);
    await replay.refresh();
    assert.equal(replay.state.snapshot, undefined);
    assert.ok(replay.state.lastObserved?.observation?.sources.every((source) => source.inventory === undefined));
    publishers[0].close();
    await connection.refresh();
    assert.equal(connection.state.snapshot?.observation?.sources[0].inventory, undefined);
    await endpoint.close();
    await connection.refresh(undefined, true);
    assert.equal(connection.state.snapshot, undefined, "disconnect withdraws all cached project text");
    assert.ok(connection.state.lastObserved?.observation?.sources.every((source) => source.inventory === undefined));
    assert.ok(connection.state.lastObserved?.observation?.sources[1].items.length, "legacy evidence remains available");
  } finally {
    await endpoint.close();
    await closeSessionAutoMode(session);
    sources.close();
  }
});

test("response ceiling remains bounded in UTF-8 bytes", async () => {
  const socketPath = join(await tempDir("dashboard-response-budget"), "owner.sock");
  const output = JSON.stringify({ ok: true, padding: "界".repeat(50_000) });
  assert.ok(output.length < DASHBOARD_RESPONSE_BYTES);
  assert.ok(Buffer.byteLength(output) > DASHBOARD_RESPONSE_BYTES);
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => socket.end(output));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await assert.rejects(dashboardSessionRequest(socketPath, "fixture", { action: "get" }), /response too large/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
