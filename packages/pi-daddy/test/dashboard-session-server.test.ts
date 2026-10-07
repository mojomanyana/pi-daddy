import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { ensureDashboardSessionServer } from "../extensions/dashboard-session-server.ts";
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
    ledgerPath,
    definitions: new Map([["review", { name: "review" }]]),
    definitionRuntimeSettings: { definitions: new Map(), defaults: {} },
    definitionRuntimeOverrides: overrides,
  } as unknown as GrantsSession;
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
  }
});

test("dashboard rejects invalid model edits without mutating the session", async () => {
  const session = {
    episodeId: newEpisodeId(),
    definitions: new Map([["review", { name: "review" }]]),
    definitionRuntimeSettings: { definitions: new Map(), defaults: {} },
    definitionRuntimeOverrides: new Map(),
  } as unknown as GrantsSession;
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
  }
});
