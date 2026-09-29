import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { appendRecord } from "../src/governance/record.ts";
import { buildChildLifecycleEvent } from "../src/governance/ledger-events.ts";
import { buildRecord } from "../src/governance/ledger.ts";
import { commitsFromGitLog, renderEpisodeReport, reportEpisodes } from "../src/products/episode-report.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { parseArgs } from "../src/cli.ts";

after(cleanupTempDirs);

const EPISODE_A = "episode:00000000-0000-4000-8000-0000000000a1";
const EPISODE_B = "episode:00000000-0000-4000-8000-0000000000b2";
const result = { effective: ["tool:read"], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] };

async function fixture(): Promise<{ ledgerText: string; activityText: string }> {
  const dir = await tempDir("episode-report-");
  const ledger = `${dir}/grants.jsonl`;
  const activity = `${dir}/activity.jsonl`;
  for (const [episodeId, executionId, childId, definition, hash, model, thinking, source, at, cost] of [
    [
      EPISODE_A,
      "exec:00000000-0000-4000-8000-0000000000a1",
      "d0.1",
      "build",
      "a".repeat(64),
      "gpt-a",
      "high",
      "explicit",
      "2026-09-20T10:00:00.000Z",
      0.25,
    ],
    [
      EPISODE_B,
      "exec:00000000-0000-4000-8000-0000000000b2",
      "d0.2",
      "review",
      "b".repeat(64),
      "gpt-b",
      "medium",
      "advisor",
      "2026-09-21T11:00:00.000Z",
      0.75,
    ],
  ] as const) {
    await appendRecord(
      ledger,
      "capability",
      buildRecord({
        episodeId,
        executionId,
        parentExecutionId: null,
        parentId: "d0",
        childId,
        depth: 1,
        agentType: definition,
        requested: ["tool:read"],
        parentGrant: [`agent:${definition}`, "tool:read"],
        result,
        blocked: false,
        definitionHash: hash,
        executor: "process",
        taskDigest: "f".repeat(64),
        now: new Date(at),
      }),
    );
    await appendRecord(
      ledger,
      "lifecycle",
      buildChildLifecycleEvent({
        episodeId,
        executionId,
        parentExecutionId: null,
        childId,
        state: "completed",
        executor: "process",
        resolvedModel: { provider: "provider", modelId: model },
        modelSource: "definition",
        effectiveThinkingLevel: thinking,
        thinkingSource: source,
        tokenDetail: {
          inputTokens: definition === "build" ? 100 : 200,
          outputTokens: definition === "build" ? 20 : 40,
          cacheReadTokens: definition === "build" ? 10 : 20,
          cacheWriteTokens: null,
          reasoningTokens: definition === "build" ? 5 : 10,
        },
        usage: {
          input: definition === "build" ? 100 : 200,
          output: definition === "build" ? 20 : 40,
          cacheRead: definition === "build" ? 10 : 20,
          cacheWrite: 0,
          reasoning: definition === "build" ? 5 : 10,
          totalTokens: definition === "build" ? 125 : 250,
          cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
        },
        compactionCount: definition === "build" ? 1 : 2,
        definitionHash: hash,
        now: new Date(Date.parse(at) + 120_000),
      }),
    );
    for (let turn = 0; turn < (definition === "build" ? 1 : 2); turn += 1)
      await appendRecord(activity, "activity", {
        version: 1,
        id: `${definition}-${turn}`,
        kind: "task_started",
        at: new Date(Date.parse(at) + turn * 30_000).toISOString(),
        rootId: `root-${definition}`,
        episodeId,
        taskId: `${definition}-turn-${turn}`,
      });
  }
  return { ledgerText: await readFile(ledger, "utf8"), activityText: await readFile(activity, "utf8") };
}

test("report joins fixture ledgers into episode rows and range totals", async () => {
  const input = await fixture();
  const report = reportEpisodes({
    ...input,
    commitByEpisode: new Map([[EPISODE_A, "12345678"]]),
    options: {},
  });
  assert.equal(report.rows.length, 2);
  assert.deepEqual(report.rows[0], {
    episode: EPISODE_A,
    started: "2026-09-20T10:00:00.000Z",
    definition: "build",
    definitionHash: "aaaaaaaaaaaa",
    resolvedModel: "provider/gpt-a",
    modelSource: "definition",
    thinkingLevel: "high",
    thinkingSource: "explicit",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 10,
    reasoningTokens: 5,
    cost: 0.25,
    compactions: 1,
    turns: 1,
    durationMs: 120_000,
    children: 1,
    commit: "12345678",
    outcome: "",
  });
  assert.deepEqual(report.totals, { episodes: 2, cost: 1, tokens: 360, p50EpisodeCost: 0.25, p95EpisodeCost: 0.75 });
  const markdown = renderEpisodeReport(report, false);
  assert.match(markdown, /\| episode \| started \| definition \| definitionHash/);
  assert.match(markdown, /\| episodes \| cost \| tokens \| p50 episode cost \| p95 episode cost \|/);
});

test("filters, grouping and JSON preserve sums without a totals table", async () => {
  const input = await fixture();
  const filtered = reportEpisodes({
    ...input,
    commitByEpisode: new Map(),
    options: { since: "2026-09-21", definition: "review", model: "gpt-b" },
  });
  assert.deepEqual(
    filtered.rows.map((row) => row.definition),
    ["review"],
  );

  const grouped = reportEpisodes({
    ...input,
    commitByEpisode: new Map(),
    options: { groupBy: "thinking" },
  });
  assert.equal(grouped.totals, undefined);
  assert.deepEqual(
    grouped.groups?.map((group) => [group.value, group.count, group.inputTokens, group.cost]),
    [
      ["high", 1, 100, 0.25],
      ["medium", 1, 200, 0.75],
    ],
  );
  assert.deepEqual(JSON.parse(renderEpisodeReport(grouped, true)).groups, grouped.groups);
});

test("report CLI parses filters, grouping and JSON without accepting unknown values", () => {
  assert.deepEqual(
    parseArgs([
      "node",
      "cli",
      "report",
      "--since",
      "2026-09-20",
      "--definition",
      "review",
      "--model",
      "gpt-b",
      "--group-by",
      "model",
      "--json",
    ]),
    {
      command: "report",
      force: false,
      errors: [],
      since: "2026-09-20",
      definition: "review",
      model: "gpt-b",
      groupBy: "model",
      json: true,
    },
  );
  assert.match(parseArgs(["node", "cli", "report", "--group-by", "episode"]).errors[0], /group-by/);
  assert.match(parseArgs(["node", "cli", "report", "--since", "not-a-date"]).errors[0], /since/);
  const missing = parseArgs(["node", "cli", "report", "--definition", "--json"]);
  assert.match(missing.errors[0], /definition/);
  assert.equal(missing.json, true, "a missing value must not swallow the next flag");
});

test("Pi-Episode trailers map episodes to the newest short commit", () => {
  const commits = commitsFromGitLog(
    `abcdef1234567890\nsubject\n\nPi-Episode: ${EPISODE_A}\n\u001e99999999aaaaaaaa\nolder\n\nPi-Episode: ${EPISODE_A}\n\u001e`,
  );
  assert.equal(commits.get(EPISODE_A), "abcdef12");
});
