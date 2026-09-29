/** Read-only episode accounting over the governance ledger and activity timeline. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readRecords } from "../governance/record.ts";

const execFileAsync = promisify(execFile);
const TERMINAL = new Set(["completed", "failed"]);

export type EpisodeGroupBy = "definition" | "model" | "thinking";
export interface EpisodeReportOptions {
  since?: string;
  definition?: string;
  model?: string;
  groupBy?: EpisodeGroupBy;
}
export interface EpisodeReportRow {
  episode: string;
  started: string;
  definition: string;
  definitionHash: string;
  resolvedModel: string;
  modelSource: string;
  thinkingLevel: string;
  thinkingSource: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  cost: number;
  compactions: number;
  turns: number;
  durationMs: number;
  children: number;
  commit: string;
  outcome: "" | "positive" | "negative" | "unknown";
}
export interface EpisodeReportGroup {
  value: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  cost: number;
}
export interface EpisodeReport {
  rows: EpisodeReportRow[];
  groups?: EpisodeReportGroup[];
  groupBy?: EpisodeGroupBy;
  totals?: { episodes: number; cost: number; tokens: number; p50EpisodeCost: number; p95EpisodeCost: number };
}
interface EpisodeAccumulator {
  episode: string;
  startedMs: number;
  endedMs: number;
  definitions: Set<string>;
  hashes: Set<string>;
  models: Set<string>;
  modelIds: Set<string>;
  modelSources: Set<string>;
  thinkingLevels: Set<string>;
  thinkingSources: Set<string>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  cost: number;
  compactions: number;
  turns: number;
  children: Set<string>;
  terminalExecutions: Set<string>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const joined = (values: Set<string>): string => [...values].filter(Boolean).sort().join(",");
function timestamp(value: unknown, fallback: string): number {
  const parsed = Date.parse(typeof value === "string" ? value : fallback);
  return Number.isFinite(parsed) ? parsed : Date.parse(fallback);
}
function episodeOf(episodes: Map<string, EpisodeAccumulator>, id: string, at: number): EpisodeAccumulator {
  const existing = episodes.get(id);
  if (existing) {
    existing.startedMs = Math.min(existing.startedMs, at);
    existing.endedMs = Math.max(existing.endedMs, at);
    return existing;
  }
  const episode: EpisodeAccumulator = {
    episode: id,
    startedMs: at,
    endedMs: at,
    definitions: new Set(),
    hashes: new Set(),
    models: new Set(),
    modelIds: new Set(),
    modelSources: new Set(),
    thinkingLevels: new Set(),
    thinkingSources: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    compactions: 0,
    turns: 0,
    children: new Set(),
    terminalExecutions: new Set(),
  };
  episodes.set(id, episode);
  return episode;
}
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

export function reportEpisodes(input: {
  ledgerText: string;
  activityText: string;
  commitByEpisode: ReadonlyMap<string, string>;
  options: EpisodeReportOptions;
}): EpisodeReport {
  const episodes = new Map<string, EpisodeAccumulator>();
  const outcomes = new Map<string, "positive" | "negative" | "unknown">();
  const ledger = readRecords(input.ledgerText);
  if (ledger.damage) throw new Error(`grants ledger damaged at line ${ledger.damage.line}: ${ledger.damage.reason}`);
  for (const record of ledger.records) {
    if (!object(record.body)) continue;
    const body = record.body;
    const episodeId = text(body.episodeId);
    if (!episodeId) continue;
    if (body.event === "episode_outcome") {
      if (["positive", "negative", "unknown"].includes(text(body.label)))
        outcomes.set(episodeId, body.label as "positive" | "negative" | "unknown");
      continue;
    }
    const episode = episodeOf(episodes, episodeId, timestamp(body.ts, record.at));
    if (text(body.definitionHash)) episode.hashes.add(text(body.definitionHash).slice(0, 12));
    if (body.event === "capability_decision") {
      if (body.agentType !== "delegate") episode.definitions.add(text(body.agentType));
      continue;
    }
    if (body.event !== "child_lifecycle") continue;
    const executionId = text(body.executionId);
    if (executionId) episode.children.add(executionId);
    if (!TERMINAL.has(text(body.state)) || episode.terminalExecutions.has(executionId)) continue;
    episode.terminalExecutions.add(executionId);
    if (object(body.resolvedModel)) {
      const provider = text(body.resolvedModel.provider),
        modelId = text(body.resolvedModel.modelId);
      if (modelId) {
        episode.modelIds.add(modelId);
        episode.models.add(provider ? `${provider}/${modelId}` : modelId);
      }
    }
    if (text(body.modelSource)) episode.modelSources.add(text(body.modelSource));
    if (object(body.thinkingLevel)) {
      if (text(body.thinkingLevel.level)) episode.thinkingLevels.add(text(body.thinkingLevel.level));
      if (text(body.thinkingLevel.source)) episode.thinkingSources.add(text(body.thinkingLevel.source));
    }
    if (text(body.thinkingSource)) episode.thinkingSources.add(text(body.thinkingSource));
    const usage = object(body.usage) ? body.usage : undefined;
    if (object(body.tokenDetail)) {
      episode.inputTokens += number(body.tokenDetail.inputTokens);
      episode.outputTokens += number(body.tokenDetail.outputTokens);
      episode.cacheReadTokens += number(body.tokenDetail.cacheReadTokens);
      episode.reasoningTokens += number(body.tokenDetail.reasoningTokens);
    } else if (usage) {
      episode.inputTokens += number(usage.input);
      episode.outputTokens += number(usage.output);
      episode.cacheReadTokens += number(usage.cacheRead);
      episode.reasoningTokens += number(usage.reasoning);
    }
    if (usage && object(usage.cost)) episode.cost += number(usage.cost.total);
    episode.compactions += number(body.compactionCount);
  }
  const activity = readRecords(input.activityText);
  if (activity.damage)
    throw new Error(`activity ledger damaged at line ${activity.damage.line}: ${activity.damage.reason}`);
  for (const record of activity.records) {
    if (record.kind !== "activity" || !object(record.body)) continue;
    const event = record.body;
    const episodeId = text(event.episodeId);
    if (!episodeId) continue;
    const episode = episodeOf(episodes, episodeId, timestamp(event.at, record.at));
    if (event.kind === "task_started" && !text(event.agentId)) episode.turns += 1;
  }
  const since = input.options.since ? Date.parse(input.options.since) : Number.NEGATIVE_INFINITY;
  let rows: EpisodeReportRow[] = [...episodes.values()]
    .map((episode): EpisodeReportRow => ({
      episode: episode.episode,
      started: new Date(episode.startedMs).toISOString(),
      definition: joined(episode.definitions),
      definitionHash: joined(episode.hashes),
      resolvedModel: joined(episode.models),
      modelSource: joined(episode.modelSources),
      thinkingLevel: joined(episode.thinkingLevels),
      thinkingSource: joined(episode.thinkingSources),
      inputTokens: episode.inputTokens,
      outputTokens: episode.outputTokens,
      cacheReadTokens: episode.cacheReadTokens,
      reasoningTokens: episode.reasoningTokens,
      cost: episode.cost,
      compactions: episode.compactions,
      turns: episode.turns,
      durationMs: Math.max(0, episode.endedMs - episode.startedMs),
      children: episode.children.size,
      commit: input.commitByEpisode.get(episode.episode) ?? "",
      outcome: outcomes.get(episode.episode) ?? "",
    }))
    .filter((row) => Date.parse(row.started) >= since)
    .filter((row) => !input.options.definition || row.definition.split(",").includes(input.options.definition))
    .filter((row) => {
      if (!input.options.model) return true;
      const source = episodes.get(row.episode)!;
      return source.modelIds.has(input.options.model) || source.models.has(input.options.model);
    })
    .sort((a, b) => Date.parse(a.started) - Date.parse(b.started) || a.episode.localeCompare(b.episode));
  if (input.options.groupBy) {
    const field =
      input.options.groupBy === "thinking"
        ? "thinkingLevel"
        : input.options.groupBy === "model"
          ? "resolvedModel"
          : "definition";
    const groups = new Map<string, EpisodeReportGroup>();
    for (const row of rows) {
      const value = row[field] || "(none)";
      const group = groups.get(value) ?? {
        value,
        count: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        cost: 0,
      };
      group.count += 1;
      group.inputTokens += row.inputTokens;
      group.outputTokens += row.outputTokens;
      group.cacheReadTokens += row.cacheReadTokens;
      group.reasoningTokens += row.reasoningTokens;
      group.cost += row.cost;
      groups.set(value, group);
    }
    return {
      rows: [],
      groups: [...groups.values()].sort((a, b) => a.value.localeCompare(b.value)),
      groupBy: input.options.groupBy,
    };
  }
  const costs = rows.map((row) => row.cost);
  return {
    rows,
    totals: {
      episodes: rows.length,
      cost: costs.reduce((sum, value) => sum + value, 0),
      tokens: rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0),
      p50EpisodeCost: percentile(costs, 0.5),
      p95EpisodeCost: percentile(costs, 0.95),
    },
  };
}

const escapeCell = (value: unknown): string => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const cost = (value: number): string => value.toFixed(6).replace(/\.?0+$/, "") || "0";
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
function table(headers: string[], rows: unknown[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");
}
export function renderEpisodeReport(report: EpisodeReport, json: boolean): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  if (report.groups && report.groupBy) {
    const headers = [
      report.groupBy,
      "count",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "reasoningTokens",
      "cost",
    ];
    return `${table(
      headers,
      report.groups.map((group) => [
        group.value,
        group.count,
        group.inputTokens,
        group.outputTokens,
        group.cacheReadTokens,
        group.reasoningTokens,
        cost(group.cost),
      ]),
    )}\n`;
  }
  const headers = [
    "episode",
    "started",
    "definition",
    "definitionHash",
    "resolvedModel",
    "modelSource",
    "thinkingLevel",
    "thinkingSource",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "reasoningTokens",
    "cost",
    "compactions",
    "turns",
    "duration",
    "children",
    "commit",
    "outcome",
  ];
  const rows = report.rows.map((row) => [
    row.episode,
    row.started,
    row.definition,
    row.definitionHash,
    row.resolvedModel,
    row.modelSource,
    row.thinkingLevel,
    row.thinkingSource,
    row.inputTokens,
    row.outputTokens,
    row.cacheReadTokens,
    row.reasoningTokens,
    cost(row.cost),
    row.compactions,
    row.turns,
    duration(row.durationMs),
    row.children,
    row.commit,
    row.outcome,
  ]);
  const totals = report.totals!;
  const totalsTable = table(
    ["episodes", "cost", "tokens", "p50 episode cost", "p95 episode cost"],
    [[totals.episodes, cost(totals.cost), totals.tokens, cost(totals.p50EpisodeCost), cost(totals.p95EpisodeCost)]],
  );
  return `${table(headers, rows)}\n\n${totalsTable}\n`;
}

export function commitsFromGitLog(log: string): Map<string, string> {
  const commits = new Map<string, string>();
  for (const entry of log.split("\u001e")) {
    const [sha, ...body] = entry.trim().split("\n");
    if (!/^[a-f0-9]{8,40}$/i.test(sha ?? "")) continue;
    for (const match of body.join("\n").matchAll(/^Pi-Episode:\s*(\S+)\s*$/gim)) {
      const episode = match[1].startsWith("episode:") ? match[1] : `episode:${match[1]}`;
      if (!commits.has(episode)) commits.set(episode, sha.slice(0, 8));
    }
  }
  return commits;
}
export async function commitsForRepo(cwd: string): Promise<Map<string, string>> {
  const { stdout } = await execFileAsync("git", ["log", "--format=%H%n%B%x1e"], { cwd, maxBuffer: 16 * 1024 * 1024 });
  return commitsFromGitLog(stdout);
}
