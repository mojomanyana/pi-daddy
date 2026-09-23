import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { ActivityTimelineRecorder, defaultActivityTimelinePath } from "../src/products/activity-timeline.ts";
import { buildChildLifecycleEvent, buildRecord, buildWorkspaceLeaseEvent } from "../src/governance/ledger.ts";
import { validateLedgerV3Event } from "../src/governance/ledger-v3-validation.ts";
import { ENV_EPISODE_ID } from "../src/kernel/env-names.ts";
import { planDelegation } from "../src/kernel/delegate.ts";
import { childEnv } from "../src/kernel/propagation.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const episodeId = "episode:00000000-0000-4000-8000-000000000099";
const executionId = "exec:00000000-0000-4000-8000-000000000001";
const now = new Date("2026-09-23T12:00:00.000Z");
const result = { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] };

test("one episode id crosses the child boundary and is written on every governance event", () => {
  assert.equal(childEnv({ ownGrant: [], depth: 0, maxDepth: 2, gated: [], episodeId })[ENV_EPISODE_ID], episodeId);
  const plan = planDelegation(
    { task: "x", tools: [] },
    {
      ownGrant: [],
      episodeId,
      depth: 0,
      maxDepth: 2,
      gated: [],
      childExecutionId: executionId,
      childSpawnId: "d0.1",
    },
  );
  assert.equal(plan.env[ENV_EPISODE_ID], episodeId, "the actual spawn plan carries the episode into the child");
  const events = [
    buildRecord({
      episodeId,
      executionId,
      parentExecutionId: null,
      parentId: "d0",
      childId: "d0.1",
      depth: 1,
      requested: [],
      parentGrant: [],
      result,
      blocked: false,
      executor: "process",
      taskDigest: "a".repeat(64),
      now,
    }),
    buildWorkspaceLeaseEvent({
      episodeId,
      executionId,
      parentExecutionId: null,
      childId: "d0.1",
      workspaceId: "work",
      root: "/work",
      access: "read",
      outcome: "uncontended",
      now,
    }),
    buildChildLifecycleEvent({
      episodeId,
      executionId,
      parentExecutionId: null,
      childId: "d0.1",
      state: "completed",
      executor: "process",
      now,
    }),
  ];
  for (const event of events) {
    const wire = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
    assert.equal(wire.episodeId, episodeId);
    assert.equal(validateLedgerV3Event(wire), null);
    const { episodeId: _oldRecordHadNone, ...old } = wire;
    assert.equal(validateLedgerV3Event(old), null, "episode identity is additive for retained records");
  }
});

test("every new activity event carries the episode id", async () => {
  const cwd = await tempDir("activity-episode-");
  const recorder = new ActivityTimelineRecorder(cwd, { [ENV_EPISODE_ID]: episodeId });
  await recorder.start("one turn");
  await recorder.finish("done");
  const events = (await readFile(defaultActivityTimelinePath(cwd), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).body);
  assert.ok(events.length > 0);
  assert.ok(events.every((event) => event.episodeId === episodeId));
});
