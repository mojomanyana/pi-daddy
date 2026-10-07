/**
 * The activity session: a pi session file every governed child writes to, so its parent can tell working from hung.
 *
 * PR 3e (ADR-0038 note). A `pi --print` child gives its parent nothing on stdout until it exits, so a wall clock
 * cannot tell a build from a hang. pi's SessionManager appends one line to its session file for every message and
 * tool result as they happen (read from pi's `session-manager.js`: `appendFileSync` per entry), so the file's size
 * and mtime are a progress signal that costs the child nothing and needs no output-format change. When the plan
 * already carries `--session` (native-session retention), that file is the probe; otherwise a private temporary
 * file is allocated for the run and removed afterwards.
 */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { BoundedReadCleanupError, readBoundedBytes } from "../kernel/bounded-read.ts";
import type { ChildUsageTotals } from "../governance/ledger-events.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ChildUsageObservation {
  usage?: ChildUsageTotals;
  unavailable?: "session-missing" | "session-invalid" | "usage-missing";
  resolvedModel?: { provider: string; modelId: string };
  effectiveThinkingLevel?: string;
  tokenDetail?: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
  };
  compactionCount?: number;
}

export interface ActivitySession {
  /** The child argv, with `--session <file>` in place of `--no-session` when a file was allocated here. */
  readonly args: string[];
  /** The session file being watched. */
  readonly path: string;
  /** A marker that changes whenever pi appended to the file; `undefined` until the file exists. */
  probe(): Promise<string | undefined>;
  /** Aggregate only the current child turn's usage; no transcript content leaves this reader. */
  usage(): Promise<ChildUsageObservation>;
  /** Remove the temporary file, if this run allocated one. Never removes a retention target. */
  dispose(): Promise<void>;
}

/** The newest session file pi wrote into a directory we own, as a size:mtime marker. */
function probeDirectory(directory: string) {
  return async (): Promise<string | undefined> => {
    try {
      const { readdir, stat } = await import("node:fs/promises");
      const names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
      if (names.length === 0) return undefined;
      const marks = await Promise.all(
        names.map(async (name) => {
          const s = await stat(join(directory, name));
          return `${name}:${s.size}:${s.mtimeMs}`;
        }),
      );
      return marks.sort().join("|");
    } catch {
      return undefined;
    }
  };
}

export async function activitySessionFor(planArgs: string[], executionId: string): Promise<ActivitySession> {
  // A forked child (ADR-0078) has no `--session`, and adding one would make pi refuse the spawn outright: it
  // rejects `--fork` beside `--session` or `--no-session`. The fork writes exactly one session into a directory
  // that is ours, so the probe watches the directory and the argv is left exactly as planned.
  const fork = planArgs.indexOf("--fork");
  if (fork >= 0) {
    const dir = planArgs[planArgs.indexOf("--session-dir") + 1];
    return {
      args: planArgs,
      path: dir,
      probe: probeDirectory(dir),
      usage: () => readChildUsage(exactSessionFile(dir, planArgs[planArgs.indexOf("--session-id") + 1])),
      dispose: async () => undefined,
    };
  }
  const flag = planArgs.indexOf("--session");
  const probeFor = (path: string) => async () => {
    try {
      const s = await stat(path);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return undefined;
    }
  };
  if (flag >= 0 && planArgs[flag + 1]) {
    const path = planArgs[flag + 1];
    return {
      args: planArgs,
      path,
      probe: probeFor(path),
      usage: () => readChildUsage(path),
      dispose: async () => undefined,
    };
  }
  // Private to this uid (mkdtemp is 0o700) and named by the execution so a leaked directory is attributable.
  const directory = await mkdtemp(join(tmpdir(), `pi-daddy-${executionId.replace(/[^a-zA-Z0-9_-]/g, "_")}-`));
  const path = join(directory, "session.jsonl");
  const noSession = planArgs.indexOf("--no-session");
  const args =
    noSession >= 0
      ? [...planArgs.slice(0, noSession), "--session", path, ...planArgs.slice(noSession + 1)]
      : [...planArgs.slice(0, -1), "--session", path, planArgs[planArgs.length - 1]];
  return {
    args,
    path,
    probe: probeFor(path),
    usage: () => readChildUsage(path),
    dispose: () => rm(directory, { recursive: true, force: true }).catch(() => undefined),
  };
}

async function exactSessionFile(directory: string, id: string | undefined): Promise<string | undefined> {
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return undefined;
  try {
    const names = (await readdir(directory)).filter((name) => name.endsWith(`_${id}.jsonl`));
    return names.length === 1 ? join(directory, names[0]) : undefined;
  } catch {
    return undefined;
  }
}

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

// Match final capture's bound; oversized or damaged accounting stays unknown, never a partial total.
const MAX_USAGE_SESSION_BYTES = 64 * 1024 * 1024;
const ENTRY_TYPES = new Set([
  "message",
  "model_change",
  "thinking_level_change",
  "usage",
  "compaction",
  "branch_summary",
  "custom",
  "label",
  "session_info",
  "custom_message",
  "context_edit",
]);
function activeUsageBranch(source: string) {
  if (!source.endsWith("\n")) throw new Error("incomplete session record");
  const entries = source
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line));
  const header = object(entries[0]);
  if (
    !header ||
    header.type !== "session" ||
    header.version !== 3 ||
    typeof header.id !== "string" ||
    !header.id ||
    typeof header.cwd !== "string" ||
    !header.cwd
  )
    throw new Error("invalid canonical session header");
  const seen = new Set<string>();
  for (const value of entries.slice(1)) {
    const entry = object(value);
    if (
      !entry ||
      !ENTRY_TYPES.has(String(entry.type)) ||
      typeof entry.id !== "string" ||
      !entry.id ||
      seen.has(entry.id) ||
      typeof entry.timestamp !== "string" ||
      (entry.parentId !== null && (typeof entry.parentId !== "string" || !seen.has(entry.parentId)))
    )
      throw new Error("ambiguous canonical session tree");
    if (entry.type === "message" && !object(entry.message)) throw new Error("invalid session message");
    seen.add(entry.id);
  }
  // This public SDK seam reads already bounded in-memory bytes; it never reopens the path or scans other branches.
  return SessionManager.inMemory(header.cwd, undefined, entries as FileEntry[]).getBranch();
}

async function readChildUsage(path: string | Promise<string | undefined>): Promise<ChildUsageObservation> {
  const resolved = await path;
  if (!resolved) return { unavailable: "session-missing" };
  const totals = emptyUsage();
  let found = false,
    incomplete = false,
    reasoning = 0,
    sawReasoning = false;
  let resolvedModel: ChildUsageObservation["resolvedModel"];
  let effectiveThinkingLevel: string | undefined;
  let compactionCount = 0;
  try {
    const read = await readBoundedBytes(resolved, { maxBytes: MAX_USAGE_SESSION_BYTES, timeoutMs: 3000 });
    if (!read.ok)
      return { unavailable: "code" in read && read.code === "ENOENT" ? "session-missing" : "session-invalid" };
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes);
    const branch = activeUsageBranch(source);
    const userIndex = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
    for (const [index, entry] of branch.entries()) {
      if (entry.type === "model_change") {
        if (typeof entry.provider !== "string" || typeof entry.modelId !== "string")
          return { unavailable: "session-invalid" };
        resolvedModel = { provider: entry.provider, modelId: entry.modelId };
        continue;
      }
      if (entry.type === "thinking_level_change") {
        if (typeof entry.thinkingLevel !== "string") return { unavailable: "session-invalid" };
        effectiveThinkingLevel = entry.thinkingLevel;
        continue;
      }
      // Current-turn accounting excludes both inherited prior turns and abandoned branch work.
      if (userIndex < 0 || index <= userIndex) continue;
      if (entry.type === "compaction") compactionCount += 1;
      let usage: Record<string, unknown> | undefined;
      if (entry.type === "message") {
        const message = object(entry.message)!;
        if (message.role !== "assistant" && message.role !== "toolResult") continue;
        if (message.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string")
          resolvedModel = { provider: message.provider, modelId: message.model };
        usage = object(message.usage);
        if (message.role === "toolResult" && !usage) continue;
      } else if (["usage", "compaction", "branch_summary"].includes(entry.type)) {
        usage = object((entry as unknown as Record<string, unknown>).usage);
        if (!usage) {
          incomplete = true;
          continue;
        }
      } else continue;
      const cost = object(usage?.cost);
      if (
        !usage ||
        !cost ||
        !TOKEN_FIELDS.every((field) => nonNegative(usage[field])) ||
        !COST_FIELDS.every((field) => nonNegative(cost[field])) ||
        (usage.reasoning !== undefined && !nonNegative(usage.reasoning))
      )
        return { unavailable: "session-invalid" };
      for (const field of TOKEN_FIELDS) totals[field] += usage[field] as number;
      for (const field of COST_FIELDS) totals.cost[field] += cost[field] as number;
      if (usage.reasoning !== undefined) {
        reasoning += usage.reasoning as number;
        sawReasoning = true;
      }
      if (
        !TOKEN_FIELDS.every((field) => nonNegative(totals[field])) ||
        !COST_FIELDS.every((field) => nonNegative(totals.cost[field])) ||
        !nonNegative(reasoning)
      )
        return { unavailable: "session-invalid" };
      found = true;
    }
    const metadata = {
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(effectiveThinkingLevel ? { effectiveThinkingLevel } : {}),
      compactionCount,
    };
    if (!found || incomplete) return { unavailable: "usage-missing", ...metadata };
    return {
      usage: { ...totals, ...(sawReasoning ? { reasoning } : {}) },
      ...metadata,
      tokenDetail: {
        inputTokens: positiveOrNull(totals.input),
        outputTokens: positiveOrNull(totals.output),
        cacheReadTokens: positiveOrNull(totals.cacheRead),
        cacheWriteTokens: positiveOrNull(totals.cacheWrite),
        reasoningTokens: sawReasoning ? positiveOrNull(reasoning) : null,
      },
    };
  } catch (error) {
    // Preserve the exact retained descriptor capability for the initiating execution/session owner.
    if (error instanceof BoundedReadCleanupError) throw error;
    return { unavailable: "session-invalid" };
  }
}

function emptyUsage(): ChildUsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const nonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const positiveOrNull = (value: number): number | null => (value > 0 ? value : null);
