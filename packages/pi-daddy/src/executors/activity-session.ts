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
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { ChildUsageTotals } from "../governance/ledger-events.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ChildUsageObservation {
  usage?: ChildUsageTotals;
  unavailable?: "session-missing" | "session-invalid" | "usage-missing";
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
      usage: () => readChildUsage(newestSessionFile(dir)),
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

async function newestSessionFile(directory: string): Promise<string | undefined> {
  try {
    const entries = await Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith(".jsonl"))
        .map(async (name) => ({ path: join(directory, name), modified: (await stat(join(directory, name))).mtimeMs })),
    );
    return entries.sort((a, b) => b.modified - a.modified)[0]?.path;
  } catch {
    return undefined;
  }
}

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

async function readChildUsage(path: string | Promise<string | undefined>): Promise<ChildUsageObservation> {
  const resolved = await path;
  if (!resolved) return { unavailable: "session-missing" };
  const totals = emptyUsage();
  let found = false;
  let reasoning = 0;
  let sawReasoning = false;
  try {
    const lines = createInterface({ input: createReadStream(resolved, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        return { unavailable: "session-invalid" };
      }
      const message = object(object(entry)?.message);
      if (!message) continue;
      if (message.role === "user") {
        Object.assign(totals, emptyUsage());
        found = false;
        reasoning = 0;
        sawReasoning = false;
        continue;
      }
      if (message.role !== "assistant" && message.role !== "toolResult") continue;
      const usage = object(message.usage);
      if (message.role === "toolResult" && !usage) continue;
      const cost = object(usage?.cost);
      if (!usage || !cost) return { unavailable: "session-invalid" };
      if (!TOKEN_FIELDS.every((field) => nonNegative(usage[field]))) return { unavailable: "session-invalid" };
      if (!COST_FIELDS.every((field) => nonNegative(cost[field]))) return { unavailable: "session-invalid" };
      if (usage.reasoning !== undefined && !nonNegative(usage.reasoning)) return { unavailable: "session-invalid" };
      for (const field of TOKEN_FIELDS) totals[field] += usage[field] as number;
      for (const field of COST_FIELDS) totals.cost[field] += cost[field] as number;
      if (usage.reasoning !== undefined) {
        reasoning += usage.reasoning as number;
        sawReasoning = true;
      }
      found = true;
    }
    return found ? { usage: { ...totals, ...(sawReasoning ? { reasoning } : {}) } } : { unavailable: "usage-missing" };
  } catch {
    return { unavailable: "session-missing" };
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
