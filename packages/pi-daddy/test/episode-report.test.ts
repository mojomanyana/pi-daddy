import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { appendRecord } from "../src/governance/record.ts";
import { buildChildLifecycleEvent, buildEpisodeOutcomeEvent } from "../src/governance/ledger-events.ts";
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
  await appendRecord(
    ledger,
    "fact",
    buildEpisodeOutcomeEvent({
      episodeId: EPISODE_A,
      commit: "1234567890abcdef1234567890abcdef12345678",
      survived: true,
      ci: "green",
      amended: false,
      corrected: false,
      label: "positive",
      now: new Date("2026-09-23T10:00:00.000Z"),
    }),
  );
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
    observedCost: 0.25,
    costCoverage: "complete",
    compactions: 1,
    turns: 1,
    durationMs: 120_000,
    children: 1,
    commit: "12345678",
    outcome: "positive",
  });
  assert.deepEqual(report.totals, {
    episodes: 2,
    cost: 1,
    observedCost: 1,
    costCoverage: "complete",
    tokens: 360,
    p50EpisodeCost: 0.25,
    p95EpisodeCost: 0.75,
  });
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
  assert.deepEqual(parseArgs(["node", "cli", "outcomes"]), {
    command: "outcomes",
    force: false,
    errors: [],
  });
});

test("Pi-Episode trailers map episodes to the newest short commit", () => {
  const commits = commitsFromGitLog(
    `abcdef1234567890\nsubject\n\nPi-Episode: ${EPISODE_A}\n\u001e99999999aaaaaaaa\nolder\n\nPi-Episode: ${EPISODE_A}\n\u001e`,
  );
  assert.equal(commits.get(EPISODE_A), "abcdef12");
});

async function costFixture(costs: Array<number | undefined>, running = false) {
  const dir = await tempDir("episode-cost-coverage-");
  const ledger = `${dir}/ledger.jsonl`;
  for (const [index, amount] of costs.entries()) {
    const executionId = `exec:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    await appendRecord(
      ledger,
      "lifecycle",
      buildChildLifecycleEvent({
        now: new Date("2026-10-07T00:00:00Z"),
        episodeId: EPISODE_A,
        executionId,
        parentExecutionId: null,
        childId: `d0.${index}`,
        state: running && index === costs.length - 1 ? "running" : "completed",
        deadlineAt: "2026-10-07T01:00:00Z",
        executor: "process",
        ...(amount === undefined
          ? {}
          : {
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: 0,
                totalTokens: 0,
                cost: { input: amount, output: 0, cacheRead: 0, cacheWrite: 0, total: amount },
              },
            }),
      }),
    );
  }
  return { ledgerText: await readFile(ledger, "utf8"), activityText: "", commitByEpisode: new Map() };
}

test("unknown child cost is distinct from reported zero in rows, totals, JSON and text", async () => {
  const unknown = reportEpisodes({ ...(await costFixture([undefined])), options: {} });
  assert.equal(unknown.rows[0].cost, null);
  assert.equal(unknown.totals?.cost, null);
  assert.equal(unknown.totals?.p50EpisodeCost, null);
  assert.equal(JSON.parse(renderEpisodeReport(unknown, true)).rows[0].cost, null);
  assert.match(renderEpisodeReport(unknown, false), /unavailable/);
  const zero = reportEpisodes({ ...(await costFixture([0])), options: {} });
  assert.equal(zero.rows[0].cost, 0);
  assert.equal(zero.totals?.cost, 0);
});

test("mixed and unfinished child costs retain observed subtotal without claiming a complete sum or percentile", async () => {
  for (const running of [false, true]) {
    const input = await costFixture([0.5, undefined], running);
    const report = reportEpisodes({ ...input, options: {} });
    assert.equal(report.rows[0].cost, null);
    assert.equal(report.rows[0].observedCost, 0.5);
    assert.equal(report.rows[0].costCoverage, "partial");
    assert.equal(report.totals?.cost, null);
    assert.equal(report.totals?.observedCost, 0.5);
    assert.equal(report.totals?.p95EpisodeCost, null);
    const grouped = reportEpisodes({ ...input, options: { groupBy: "model" } });
    assert.equal(grouped.groups?.[0].cost, null);
    assert.equal(grouped.groups?.[0].observedCost, 0.5);
    assert.match(renderEpisodeReport(grouped, false), /partial/);
  }
});

test("an empty or activity-only report cannot claim measured zero child cost", async () => {
  const empty = reportEpisodes({ ledgerText: "", activityText: "", commitByEpisode: new Map(), options: {} });
  assert.equal(empty.totals?.cost, null);
  assert.equal(empty.totals?.costCoverage, "unavailable");
  const dir = await tempDir("root-cost-unmeasured-");
  const activity = `${dir}/activity.jsonl`;
  await appendRecord(activity, "activity", {
    version: 1,
    id: "root-only",
    kind: "task_started",
    at: "2026-10-07T00:00:00.000Z",
    rootId: "root",
    episodeId: EPISODE_A,
    taskId: "root-turn",
  });
  const report = reportEpisodes({
    ledgerText: "",
    activityText: await readFile(activity, "utf8"),
    commitByEpisode: new Map(),
    options: {},
  });
  assert.equal(report.rows[0].cost, null);
  assert.equal(report.rows[0].costCoverage, "unavailable");
  assert.equal(report.costScope, "recorded-child-executions");
  assert.match(renderEpisodeReport(report, false), /root and unrecorded work are not measured/);
});
