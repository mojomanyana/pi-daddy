/** Compute durable episode outcomes from Git, CI metadata, and the next recorded operator turn. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { appendLedgerEvent, buildEpisodeOutcomeEvent } from "../governance/ledger.ts";
import { readRecords } from "../governance/record.ts";
import { isEpisodeId } from "../kernel/episode-id.ts";
import { readActivityContent, type ContentReference } from "./activity-timeline.ts";

const execFileAsync = promisify(execFile);
const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1_000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1_000;
export const CORRECTION_PREFIXES = ["no,", "that's wrong", "undo", "revert"] as const;

type CiSignal = "green" | "red" | "none";
type OutcomeLabel = "positive" | "negative" | "unknown";
export interface EpisodeOutcomeSignals {
  episodeId: string;
  commit: string;
  survived: boolean;
  ci: CiSignal;
  amended: boolean;
  corrected: boolean;
  label: OutcomeLabel;
}
interface CommitFact {
  sha: string;
  parents: string[];
  authoredMs: number;
  message: string;
  episodes: string[];
}
export interface GitCommandResult {
  stdout: string;
  code: number;
}
export type GitRunner = (args: string[]) => Promise<GitCommandResult>;
export type GhRunner = (sha: string) => Promise<string | null>;

async function command(cwd: string, file: string, args: string[]): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync(file, args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return { stdout: result.stdout, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number | string };
    return { stdout: failure.stdout ?? "", code: typeof failure.code === "number" ? failure.code : 127 };
  }
}

function commitsFromLog(log: string): CommitFact[] {
  const commits: CommitFact[] = [];
  for (const entry of log.split("\u001e")) {
    const [sha, parentText, authored, ...messageParts] = entry.trim().split("\u001f");
    if (!/^[a-f0-9]{40}$/i.test(sha ?? "")) continue;
    const parents = parentText.split(" ").filter((parent) => /^[a-f0-9]{40}$/i.test(parent));
    const message = messageParts.join("\u001f");
    const episodes = [...message.matchAll(/^Pi-Episode:\s*(\S+)\s*$/gim)]
      .map((match) => (match[1].startsWith("episode:") ? match[1] : `episode:${match[1]}`))
      .filter(isEpisodeId);
    commits.push({ sha, parents, authoredMs: Date.parse(authored), message, episodes });
  }
  return commits;
}

function absentOrThrow(result: GitCommandResult, operation: string): boolean {
  if (result.code === 1) return true;
  if (result.code !== 0) throw new Error(`pi-daddy outcomes: git ${operation} failed`);
  return false;
}

async function defaultBranch(runGit: GitRunner): Promise<string> {
  const remote = await runGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remote.code === 0 && remote.stdout.trim()) return remote.stdout.trim();
  absentOrThrow(remote, "symbolic-ref");
  for (const name of ["main", "master"]) {
    const local = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    if (local.code === 0) return name;
    absentOrThrow(local, "show-ref");
  }
  const current = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (current.code === 0 && current.stdout.trim()) return current.stdout.trim();
  absentOrThrow(current, "symbolic-ref");
  throw new Error("pi-daddy outcomes: no default branch could be resolved");
}

export async function gitIsAncestor(
  cwd: string,
  older: string,
  newer: string,
  runGit: GitRunner = (args) => command(cwd, "git", args),
): Promise<boolean> {
  const result = await runGit(["merge-base", "--is-ancestor", older, newer]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`pi-daddy outcomes: git merge-base failed for ${older} and ${newer}`);
}

async function filesFor(runGit: GitRunner, sha: string): Promise<Set<string>> {
  const result = await runGit(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha]);
  if (result.code !== 0) throw new Error(`pi-daddy outcomes: could not read files for ${sha}`);
  return new Set(result.stdout.split("\n").filter(Boolean));
}

async function diffFor(runGit: GitRunner, from: string, to: string): Promise<string> {
  const result = await runGit(["diff", "--binary", from, to, "--"]);
  if (result.code !== 0) throw new Error(`pi-daddy outcomes: git diff failed for ${from} and ${to}`);
  return result.stdout;
}

async function commitDiff(runGit: GitRunner, commit: CommitFact): Promise<string> {
  if (commit.parents[0]) return diffFor(runGit, commit.parents[0], commit.sha);
  const result = await runGit(["show", "--format=", "--binary", "--root", commit.sha, "--"]);
  if (result.code !== 0) throw new Error(`pi-daddy outcomes: git show failed for ${commit.sha}`);
  return result.stdout;
}

function commitChildren(commits: CommitFact[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const commit of commits)
    for (const parent of commit.parents) children.set(parent, [...(children.get(parent) ?? []), commit.sha]);
  return children;
}

function laterDescendants(
  candidate: CommitFact,
  commits: Map<string, CommitFact>,
  children: Map<string, string[]>,
): CommitFact[] {
  const later: CommitFact[] = [];
  const pending = [...(children.get(candidate.sha) ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const sha = pending.pop()!;
    if (visited.has(sha)) continue;
    visited.add(sha);
    const commit = commits.get(sha);
    if (commit) later.push(commit);
    pending.push(...(children.get(sha) ?? []));
  }
  return later;
}

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const value = load();
  cache.set(key, value);
  return value;
}

async function wasReverted(
  runGit: GitRunner,
  candidate: CommitFact,
  later: CommitFact[],
  commitDiffs: Map<string, Promise<string>>,
  inverseDiffs: Map<string, Promise<string>>,
): Promise<boolean> {
  const named = later.some((commit) => {
    const lower = commit.message.toLowerCase();
    return lower.includes(candidate.sha.toLowerCase()) || lower.includes(candidate.sha.slice(0, 12).toLowerCase());
  });
  if (named) return true;
  const original = await cached(commitDiffs, candidate.sha, () => commitDiff(runGit, candidate));
  for (const commit of later) {
    const inverse = await cached(inverseDiffs, commit.sha, () => diffFor(runGit, commit.sha, `${commit.sha}^`));
    if (inverse === original) return true;
  }
  return false;
}

async function wasAmended(
  runGit: GitRunner,
  candidate: CommitFact,
  later: CommitFact[],
  filesByCommit: Map<string, Promise<Set<string>>>,
): Promise<boolean> {
  const files = await cached(filesByCommit, candidate.sha, () => filesFor(runGit, candidate.sha));
  if (files.size === 0) return false;
  for (const commit of later) {
    const elapsed = commit.authoredMs - candidate.authoredMs;
    if (elapsed < 0 || elapsed > TWENTY_FOUR_HOURS) continue;
    if (!/^(fix|fixup|amend)(?:\b|:)/i.test(commit.message.trim())) continue;
    const touched = await cached(filesByCommit, commit.sha, () => filesFor(runGit, commit.sha));
    if ([...touched].some((file) => files.has(file))) return true;
  }
  return false;
}

async function defaultGh(cwd: string, sha: string): Promise<string | null> {
  if ((await command(cwd, "gh", ["--version"])).code !== 0) return null;
  const result = await command(cwd, "gh", ["run", "list", "--commit", sha, "--json", "conclusion", "--limit", "100"]);
  if (result.code !== 0) throw new Error(`pi-daddy outcomes: gh run list failed for ${sha}`);
  return result.stdout;
}

function ciFrom(value: string | null): CiSignal {
  if (value === null) return "none";
  try {
    const conclusions = (JSON.parse(value) as Array<{ conclusion?: unknown }>).map((run) =>
      String(run.conclusion ?? ""),
    );
    if (
      conclusions.some((item) =>
        ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(item),
      )
    )
      return "red";
    return conclusions.some((item) => ["success", "neutral", "skipped"].includes(item)) ? "green" : "none";
  } catch {
    throw new Error("pi-daddy outcomes: gh run list returned invalid JSON");
  }
}

async function corrections(activityPath: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(activityPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  const parsed = readRecords(text);
  if (parsed.damage) throw new Error(`activity ledger damaged at line ${parsed.damage.line}: ${parsed.damage.reason}`);
  const turns = new Map<string, Array<{ at: number; prompt?: ContentReference }>>();
  for (const record of parsed.records) {
    const body = record.body as Record<string, unknown>;
    if (record.kind !== "activity" || body.kind !== "task_started" || body.agentId !== undefined) continue;
    if (!isEpisodeId(body.episodeId)) continue;
    const list = turns.get(body.episodeId) ?? [];
    list.push({ at: Date.parse(String(body.at)), prompt: body.prompt as ContentReference | undefined });
    turns.set(body.episodeId, list);
  }
  const corrected = new Set<string>();
  for (const [episode, entries] of turns) {
    const next = entries.sort((a, b) => a.at - b.at)[1];
    if (!next?.prompt?.ref) continue;
    const prompt = (await readActivityContent(activityPath, next.prompt)).trimStart().toLowerCase();
    if (CORRECTION_PREFIXES.some((prefix) => prompt.startsWith(prefix))) corrected.add(episode);
  }
  return corrected;
}

function priorSignals(ledgerText: string): Map<string, EpisodeOutcomeSignals> {
  const parsed = readRecords(ledgerText);
  if (parsed.damage) throw new Error(`grants ledger damaged at line ${parsed.damage.line}: ${parsed.damage.reason}`);
  const prior = new Map<string, EpisodeOutcomeSignals>();
  for (const record of parsed.records) {
    const body = record.body as Partial<EpisodeOutcomeSignals> & { event?: unknown };
    if (body.event === "episode_outcome" && body.episodeId) prior.set(body.episodeId, body as EpisodeOutcomeSignals);
  }
  return prior;
}

function sameSignals(left: EpisodeOutcomeSignals | undefined, right: EpisodeOutcomeSignals): boolean {
  return (
    left?.survived === right.survived &&
    left.ci === right.ci &&
    left.amended === right.amended &&
    left.corrected === right.corrected &&
    left.label === right.label
  );
}

export async function updateEpisodeOutcomes(options: {
  cwd: string;
  ledgerPath: string;
  activityPath: string;
  now?: Date;
  runGh?: GhRunner;
  runGit?: GitRunner;
}): Promise<{ appended: number; outcomes: EpisodeOutcomeSignals[] }> {
  const now = options.now ?? new Date();
  const runGit = options.runGit ?? ((args: string[]) => command(options.cwd, "git", args));
  let ledgerText = "";
  try {
    ledgerText = await readFile(options.ledgerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const log = await runGit(["log", "--all", "--reflog", "--format=%H%x1f%P%x1f%aI%x1f%B%x1e"]);
  if (log.code !== 0) throw new Error("pi-daddy outcomes: git history could not be read");
  const commits = commitsFromLog(log.stdout);
  const branch = await defaultBranch(runGit);
  const correctedEpisodes = await corrections(options.activityPath);
  const commitsBySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const children = commitChildren(commits);
  const latest = new Map<string, CommitFact>();
  for (const commit of commits)
    for (const episode of commit.episodes) if (!latest.has(episode)) latest.set(episode, commit);
  const outcomes: EpisodeOutcomeSignals[] = [];
  const commitDiffs = new Map<string, Promise<string>>();
  const inverseDiffs = new Map<string, Promise<string>>();
  const filesByCommit = new Map<string, Promise<Set<string>>>();
  for (const [episodeId, candidate] of latest) {
    const later = laterDescendants(candidate, commitsBySha, children);
    const reverted = await wasReverted(runGit, candidate, later, commitDiffs, inverseDiffs);
    const survived = (await gitIsAncestor(options.cwd, candidate.sha, branch, runGit)) && !reverted;
    const ci = ciFrom(await (options.runGh ?? ((sha) => defaultGh(options.cwd, sha)))(candidate.sha));
    const amended = await wasAmended(runGit, candidate, later, filesByCommit);
    const corrected = correctedEpisodes.has(episodeId);
    const oldEnough = now.getTime() - candidate.authoredMs >= FORTY_EIGHT_HOURS;
    const label: OutcomeLabel = !oldEnough
      ? "unknown"
      : !survived || ci === "red" || corrected
        ? "negative"
        : "positive";
    outcomes.push({ episodeId, commit: candidate.sha, survived, ci, amended, corrected, label });
  }
  const prior = priorSignals(ledgerText);
  let appended = 0;
  for (const outcome of outcomes) {
    if (sameSignals(prior.get(outcome.episodeId), outcome)) continue;
    await appendLedgerEvent({ path: options.ledgerPath }, buildEpisodeOutcomeEvent({ ...outcome, now }));
    appended += 1;
  }
  return { appended, outcomes };
}
