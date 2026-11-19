import assert from "node:assert/strict";
import { test } from "node:test";
import type { GrantsSession } from "../extensions/session.ts";
import { initializeSessionAutoMode, closeSessionAutoMode } from "../extensions/session-auto-mode.ts";
import { initializeWorkMode, workModeSnapshot, beginWorkModeRequest } from "../extensions/work-mode.ts";
import { ensureDashboardSessionServer } from "../extensions/dashboard-session-server.ts";
import { dashboardSessionRequest, type DashboardSessionAction } from "../src/products/dashboard-session-client.ts";
import { createCapacityAllocator } from "../src/kernel/capacity.ts";
import { newEpisodeId } from "../src/kernel/episode-id.ts";

test("work mode transport requires current owner and explicit valid selection without changing other controls", async () => {
  const owner = { sessionId: "work-mode-native-session", cwd: "/work", generation: "generation-one" };
  let sequence = 0;
  const session = {
    episodeId: newEpisodeId(),
    ownerBound: true,
    depth: 0,
    reloadLifecycle: { root: {} },
    definitions: new Map(),
    definitionRuntimeSettings: { definitions: new Map(), defaults: {} },
    definitionRuntimeOverrides: new Map(),
    capacity: createCapacityAllocator(8),
    maxDepth: 2,
    dashboardObservations: () => ({
      version: 1,
      ...owner,
      sequence: ++sequence,
      observedAt: new Date().toISOString(),
      capture: { transcripts: false, diagnostics: false },
      resources: { scope: "owner-process", sampledAt: new Date().toISOString(), rssBytes: 0, hostHealth: "unknown" },
      activity: [],
      artifacts: [],
      sources: [],
    }),
  } as unknown as GrantsSession;
  await initializeSessionAutoMode(session, {}, owner.sessionId);
  const records: unknown[] = [];
  initializeWorkMode(
    {
      appendEntry: (...args) => {
        records.push(args);
      },
    },
    session,
    {
      sessionManager: { getSessionId: () => owner.sessionId, getEntries: () => [], getBranch: () => [] },
      ui: {},
    } as unknown as Parameters<typeof initializeWorkMode>[2],
    "startup",
    {},
  );
  const endpoint = await ensureDashboardSessionServer(session);
  try {
    const request = (action: DashboardSessionAction) =>
      dashboardSessionRequest(endpoint.socketPath, endpoint.token, action);
    const initial = await request({ action: "get" });
    const selection = { mode: "ambitious" as const, emphases: ["depth" as const, "range" as const] };
    const valid = { action: "set-work-mode" as const, selection, scope: "session" as const, expectedOwner: owner };
    await assert.rejects(dashboardSessionRequest(endpoint.socketPath, "bad-token", valid), /unauthorised/);
    await assert.rejects(request({ ...valid, expectedOwner: undefined }), /owner changed/);
    await assert.rejects(request({ ...valid, expectedOwner: { ...owner, generation: "old" } }), /owner changed/);
    await assert.rejects(request({ ...valid, extra: true } as unknown as DashboardSessionAction), /Invalid work mode/);
    await assert.rejects(
      request({ ...valid, selection: { mode: "ambitious", emphases: ["depth", "depth"] } }),
      /valid emphases/,
    );
    assert.equal(records.length, 0, "refusals cannot persist a mode");
    const applied = await request(valid);
    assert.equal(applied.workModeApplied, true);
    assert.deepEqual(applied.settings?.workMode?.selection, selection);
    assert.deepEqual(applied.auto, initial.auto);
    assert.deepEqual(applied.settings?.jev, initial.settings?.jev);
    assert.equal(applied.settings?.wallSeconds, initial.settings?.wallSeconds);
    assert.equal(applied.settings?.idleSeconds, initial.settings?.idleSeconds);
    assert.equal(applied.settings?.descendants, initial.settings?.descendants);
    assert.deepEqual(applied.rows, initial.rows);
    assert.equal(records.length, 1);
    beginWorkModeRequest(session);
    const queued = await request({ ...valid, selection: { mode: "standard", emphases: [] }, scope: "next-request" });
    assert.deepEqual(queued.settings?.workMode?.active, selection, "active request keeps captured guidance");
    assert.deepEqual(queued.settings?.workMode?.nextRequest, { mode: "standard", emphases: [] });
    assert.equal(records.length, 2);
    session.reloadLifecycle.workMode!.inherited = true;
    await assert.rejects(request(valid), /owning parent/);
    assert.equal(records.length, 2);
    assert.deepEqual(workModeSnapshot(session).selection, selection);
  } finally {
    await endpoint.close();
    await closeSessionAutoMode(session);
  }
});
