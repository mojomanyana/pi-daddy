import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { ensureDashboardSessionServer } from "../extensions/dashboard-session-server.ts";
import { initializeSessionAutoMode, closeSessionAutoMode } from "../extensions/session-auto-mode.ts";
import type { GrantsSession } from "../extensions/session.ts";
import { newEpisodeId } from "../src/kernel/episode-id.ts";
import { readRecords } from "../src/governance/record.ts";
import { dashboardSessionRequest } from "../src/products/dashboard-session-client.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("dashboard edits mutate the owning session map and write the ordinary session_config event", async () => {
  const ledgerPath = join(await tempDir("dashboard-session"), "grants.jsonl");
  const overrides = new Map();
  const session = {
    episodeId: newEpisodeId(),
    ownerBound: true,
    reloadLifecycle: { root: {} },
    ledgerPath,
    definitions: new Map([["review", { name: "review" }]]),
    definitionRuntimeSettings: { definitions: new Map(), defaults: {} },
    definitionRuntimeOverrides: overrides,
  } as unknown as GrantsSession;
  await initializeSessionAutoMode(session, {}, "dashboard-fixture");
  const endpoint = await ensureDashboardSessionServer(session);
  try {
    const before = await dashboardSessionRequest(endpoint.socketPath, endpoint.token, { action: "get" });
    assert.deepEqual(before.rows, [
      { definition: "review", model: "pi default", thinking: "pi default", source: "pi/pi" },
    ]);
    assert.equal(before.cost, null, "complete live episode cost is not observed");

    const afterEdit = await dashboardSessionRequest(endpoint.socketPath, endpoint.token, {
      action: "set",
      edits: "review anthropic:claude-opus-4-6 high",
    });
    assert.equal(overrides.get("review")?.model, "anthropic/claude-opus-4-6");
    assert.equal(afterEdit.rows[0]?.source, "session/session");
    const records = readRecords(await readFile(ledgerPath, "utf8")).records;
    assert.equal((records.at(-1)?.body as { event?: string }).event, "session_config");
  } finally {
    await endpoint.close();
    await closeSessionAutoMode(session);
  }
});

test("dashboard rejects invalid model edits without mutating the session", async () => {
  const session = {
    episodeId: newEpisodeId(),
    ownerBound: true,
    reloadLifecycle: { root: {} },
    definitions: new Map([["review", { name: "review" }]]),
    definitionRuntimeSettings: { definitions: new Map(), defaults: {} },
    definitionRuntimeOverrides: new Map(),
  } as unknown as GrantsSession;
  await initializeSessionAutoMode(session, {}, "dashboard-fixture");
  const endpoint = await ensureDashboardSessionServer(session);
  try {
    await assert.rejects(
      dashboardSessionRequest(endpoint.socketPath, endpoint.token, {
        action: "set",
        edits: "review not-a-provider-model high",
      }),
      /provider:model/,
    );
    assert.equal(session.definitionRuntimeOverrides.size, 0);
  } finally {
    await endpoint.close();
    await closeSessionAutoMode(session);
  }
});

test("Auto transport authenticates owner edits and returns the actual pending queue and acknowledged state", async () => {
  const session = {
    episodeId: newEpisodeId(),
    ownerBound: true,
    reloadLifecycle: { root: {} },
    definitions: new Map(),
    definitionRuntimeSettings: { definitions: new Map(), defaults: {} },
    definitionRuntimeOverrides: new Map(),
    activity: { rootId: "owner-root", taskId: "owner-task", path: "/exact/timeline" },
  } as unknown as GrantsSession;
  await initializeSessionAutoMode(session, {}, "dashboard-auto-fixture");
  const endpoint = await ensureDashboardSessionServer(session);
  try {
    const request = (action: Parameters<typeof dashboardSessionRequest>[2]) =>
      dashboardSessionRequest(endpoint.socketPath, endpoint.token, action);
    await session.autoMode!.trackPending({ id: "approval-1", subject: "build", capability: "tool:bash" });
    await new Promise<void>((resolve) => {
      const oversized = createConnection(endpoint.socketPath);
      oversized.on("error", () => {});
      oversized.once("close", () => resolve());
      oversized.once("connect", () => oversized.write("x".repeat(17 * 1024) + "\n"));
    });
    const before = await request({ action: "get" });
    assert.deepEqual(before.auto, { enabled: false, source: "default" });
    assert.deepEqual(before.pendingApprovals, [{ id: "approval-1", subject: "build", capability: "tool:bash" }]);
    assert.deepEqual(before.activity, session.activity);
    await assert.rejects(
      dashboardSessionRequest(endpoint.socketPath, "wrong-token", { action: "set-auto", enabled: true }),
      /unauthorised/,
    );
    await assert.rejects(request({ action: "set-auto", enabled: "yes" } as never), /boolean/);
    assert.equal((await request({ action: "get" })).auto.enabled, false);
    session.ecosystemVersions = () => {
      throw new Error("fixture package path unavailable");
    };
    assert.deepEqual((await request({ action: "set-auto", enabled: true })).auto, { enabled: true, source: "session" });
    assert.match((await request({ action: "get" })).versions?.note ?? "", /inventory unavailable/);
    assert.equal((await request({ action: "set-auto", enabled: false })).auto.enabled, false);
    await closeSessionAutoMode(session);
    await assert.rejects(request({ action: "set-auto", enabled: true }), /unavailable/);
  } finally {
    await endpoint.close();
    await closeSessionAutoMode(session);
  }
});
