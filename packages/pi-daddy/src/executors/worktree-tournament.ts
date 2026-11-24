/**
 * Isolated parallel git-worktree tournament executor (Layer 2: executors).
 *
 * - Captures `baseSha` before spawning so candidates that run `git commit` are never disqualified.
 * - Copies dirty tracked & untracked parent files into each worktree and snapshots pre-existing
 *   test/verifier files so candidates cannot pass by modifying the verifier.
 * - Supports cross-candidate test cross-pollination when >=2 candidates pass `verifyCommand`.
 * - Always cleans up every temporary worktree in `finally`.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isUnderPiProjectDir } from "../kernel/project-paths.ts";

const execFileAsync = promisify(execFile);
const TEST_FILE_RE = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|verify[^/]*\.[cm]?[jt]s$/i;

export interface CandidateRunResult {
  readonly index: number;
  readonly approach: string;
  readonly worktree: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly diff: string;
  readonly changedFiles: string[];
  readonly verifyPassed: boolean;
  readonly verifyExitCode: number | null;
  readonly verifyOutput: string;
  readonly crossTestsPassed?: number;
  readonly error?: string;
}

export interface TournamentOptions {
  readonly repoRoot: string;
  readonly task: string;
  readonly approaches: readonly string[];
  readonly verifyCommand?: string;
  readonly verifyTimeoutMs?: number;
  readonly applyWinner?: boolean;
  readonly signal?: AbortSignal;
  readonly runCandidate: (input: {
    index: number;
    approach: string;
    worktree: string;
    signal?: AbortSignal;
  }) => Promise<{ ok: boolean; summary: string; error?: string }>;
  readonly judgeWinner?: (
    passing: readonly CandidateRunResult[],
    signal?: AbortSignal,
  ) => Promise<{ winnerIndex: number; rationale: string }>;
}

export interface TournamentOutcome {
  readonly candidates: readonly CandidateRunResult[];
  readonly winnerIndex: number | null;
  readonly rationale: string;
  readonly applied: boolean;
}

async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout,
    maxBuffer: 512 * 1024,
  });
  return stdout;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function snapshotParentWorkspace(repoRoot: string): Promise<{
  dirtyFiles: Map<string, Buffer>;
  protectedFiles: Map<string, Buffer>;
}> {
  const root = resolve(repoRoot);
  const dirtyFiles = new Map<string, Buffer>();
  const protectedFiles = new Map<string, Buffer>();
  try {
    const out = await git(root, ["status", "--porcelain", "-uall"]);
    for (const line of out.split(/\r?\n/)) {
      if (line.length < 4) continue;
      const rel = line.slice(3).trim().replace(/^"|"$/g, "");
      if (!rel || isUnderPiProjectDir(rel) || rel.startsWith(".principal/")) continue;
      const abs = resolve(root, rel);
      if (!abs.startsWith(root)) continue;
      try {
        const info = await stat(abs);
        if (!info.isFile() || info.size > 512 * 1024) continue;
        const buf = await readFile(abs);
        dirtyFiles.set(rel, buf);
        if (TEST_FILE_RE.test(rel)) protectedFiles.set(rel, buf);
      } catch {
        /* Skip deleted or unreadable path. */
      }
    }
  } catch {
    /* Non-git or empty status. */
  }
  return { dirtyFiles, protectedFiles };
}

export async function createDetachedWorktree(
  repoRoot: string,
  index: number,
  dirtyFiles?: ReadonlyMap<string, Buffer>,
): Promise<string> {
  const root = resolve(repoRoot);
  const base = await mkdtemp(join(tmpdir(), `pi-daddy-wt-${index}-`));
  const worktree = join(base, "wt");
  await git(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
  if (dirtyFiles) {
    for (const [rel, buf] of dirtyFiles) {
      const dst = resolve(worktree, rel);
      if (!dst.startsWith(resolve(worktree))) continue;
      await mkdir(dirname(dst), { recursive: true });
      await writeFile(dst, buf);
    }
  }
  return worktree;
}

export async function removeDetachedWorktree(repoRoot: string, worktree: string): Promise<void> {
  const root = resolve(repoRoot);
  try {
    await git(root, ["worktree", "remove", "--force", worktree]);
  } catch {
    /* Fall through to forced directory cleanup + prune. */
  }
  await rm(dirname(worktree), { recursive: true, force: true }).catch(() => {});
  await git(root, ["worktree", "prune"]).catch(() => {});
}

export async function collectWorktreeChanges(
  worktree: string,
  baseSha = "HEAD",
  preSnapshot?: ReadonlyMap<string, Buffer>,
): Promise<{ diff: string; changedFiles: string[] }> {
  const parts: string[] = [];
  const files = new Set<string>();
  const unchangedFromPre = async (rel: string): Promise<boolean> => {
    const prev = preSnapshot?.get(rel);
    if (!prev) return false;
    try {
      const cur = await readFile(join(worktree, rel));
      return sha256(cur) === sha256(prev);
    } catch {
      return false;
    }
  };
  try {
    const diff = (await git(worktree, ["diff", "--no-color", baseSha])).trim();
    if (diff) parts.push(diff);
    const names = (await git(worktree, ["diff", "--name-only", baseSha]))
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const f of names) {
      if (!(await unchangedFromPre(f))) files.add(f);
    }
  } catch {
    /* Empty or invalid diff. */
  }
  try {
    const untracked = (await git(worktree, ["ls-files", "--others", "--exclude-standard"]))
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 24);
    let extra = 0;
    for (const rel of untracked) {
      if (rel.startsWith(".") || rel.endsWith(".log")) continue;
      if (await unchangedFromPre(rel)) continue;
      files.add(rel);
      if (extra >= 12_000) continue;
      try {
        const full = join(worktree, rel);
        const info = await stat(full);
        if (!info.isFile() || info.size === 0 || info.size > 32 * 1024) continue;
        const text = await readFile(full, "utf8");
        if (text.includes("\0")) continue;
        const snippet = text.slice(0, Math.min(text.length, 12_000 - extra));
        extra += snippet.length;
        parts.push(`--- /dev/null\n+++ b/${rel}\n${snippet}`);
      } catch {
        /* Skip unreadable untracked file. */
      }
    }
  } catch {
    /* Ignore untracked scan error. */
  }
  const combined = parts.join("\n\n").trim();
  const clipped = combined.length > 32_000 ? `${combined.slice(0, 32_000)}\n...[truncated]` : combined;
  return { diff: clipped, changedFiles: [...files].sort() };
}

export async function runVerifyCommand(
  worktree: string,
  command: string,
  signal?: AbortSignal,
  timeoutMs = 45_000,
): Promise<{ passed: boolean; exitCode: number | null; output: string }> {
  const shell = process.platform === "win32" ? "cmd" : "sh";
  const flag = process.platform === "win32" ? "/c" : "-c";
  try {
    const { stdout, stderr } = await execFileAsync(shell, [flag, command], {
      cwd: worktree,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      signal,
    });
    const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
    return { passed: true, exitCode: 0, output: combined.slice(-4000) };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const exitCode = typeof err.code === "number" ? err.code : 1;
    const combined = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`.trim();
    return { passed: false, exitCode, output: combined.slice(-4000) };
  }
}

export async function applyWorktreeChanges(
  repoRoot: string,
  worktree: string,
  changedFiles: readonly string[],
): Promise<boolean> {
  if (changedFiles.length === 0) return false;
  const root = resolve(repoRoot);
  for (const rel of changedFiles) {
    const src = resolve(worktree, rel);
    const dst = resolve(root, rel);
    if (!dst.startsWith(root)) continue;
    try {
      const info = await stat(src);
      if (!info.isFile()) continue;
      await mkdir(dirname(dst), { recursive: true });
      await cp(src, dst, { force: true });
    } catch {
      await rm(dst, { force: true }).catch(() => {});
    }
  }
  return true;
}

async function crossPollinateTests(
  passing: CandidateRunResult[],
  verifyCommand: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<CandidateRunResult[]> {
  if (passing.length < 2) return passing;
  const scores = new Map<number, number>(passing.map((c) => [c.index, 0]));
  for (const donor of passing) {
    const donorTests = donor.changedFiles.filter((f) => TEST_FILE_RE.test(f));
    if (donorTests.length === 0) continue;
    for (const target of passing) {
      if (target.index === donor.index) continue;
      const backups = new Map<string, Buffer | null>();
      try {
        for (const rel of donorTests) {
          const dst = resolve(target.worktree, rel);
          try {
            backups.set(rel, await readFile(dst));
          } catch {
            backups.set(rel, null);
          }
          await mkdir(dirname(dst), { recursive: true });
          await cp(resolve(donor.worktree, rel), dst, { force: true });
        }
        const check = await runVerifyCommand(target.worktree, verifyCommand, signal, timeoutMs);
        if (check.passed) scores.set(target.index, (scores.get(target.index) ?? 0) + 1);
      } catch {
        /* Best-effort cross-pollination. */
      } finally {
        for (const [rel, orig] of backups) {
          const dst = resolve(target.worktree, rel);
          if (orig === null) await rm(dst, { force: true }).catch(() => {});
          else await writeFile(dst, orig).catch(() => {});
        }
      }
    }
  }
  return passing.map((c) => ({ ...c, crossTestsPassed: scores.get(c.index) ?? 0 }));
}

export async function runWorktreeTournament(options: TournamentOptions): Promise<TournamentOutcome> {
  const approaches = options.approaches.slice(0, 3);
  if (approaches.length === 0) {
    throw new Error("Tournament requires at least one candidate approach");
  }
  const baseSha = (await git(options.repoRoot, ["rev-parse", "HEAD"])).trim();
  const { dirtyFiles, protectedFiles } = await snapshotParentWorkspace(options.repoRoot);
  const created: Array<string | undefined> = new Array(approaches.length).fill(undefined);
  try {
    const settled = await Promise.all(
      approaches.map(async (approach, index): Promise<CandidateRunResult> => {
        let worktree = "";
        try {
          worktree = await createDetachedWorktree(options.repoRoot, index, dirtyFiles);
          created[index] = worktree;
          const run = await options.runCandidate({
            index,
            approach,
            worktree,
            signal: options.signal,
          });
          // Restore pre-existing verifier/test files so candidates cannot game verifyCommand.
          for (const [rel, orig] of protectedFiles) {
            const dst = resolve(worktree, rel);
            await mkdir(dirname(dst), { recursive: true });
            await writeFile(dst, orig);
          }
          const { diff, changedFiles } = await collectWorktreeChanges(worktree, baseSha, dirtyFiles);
          const verify = options.verifyCommand
            ? await runVerifyCommand(worktree, options.verifyCommand, options.signal, options.verifyTimeoutMs)
            : { passed: run.ok && changedFiles.length > 0, exitCode: run.ok ? 0 : 1, output: "" };
          return {
            index,
            approach,
            worktree,
            ok: run.ok,
            summary: run.summary,
            diff,
            changedFiles,
            verifyPassed: verify.passed,
            verifyExitCode: verify.exitCode,
            verifyOutput: verify.output,
            ...(run.error ? { error: run.error } : {}),
          };
        } catch (error) {
          return {
            index,
            approach,
            worktree,
            ok: false,
            summary: "",
            diff: "",
            changedFiles: [],
            verifyPassed: false,
            verifyExitCode: null,
            verifyOutput: "",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    let passing = settled.filter((c) => c.ok && c.verifyPassed && c.changedFiles.length > 0);
    if (passing.length > 1 && options.verifyCommand) {
      passing = await crossPollinateTests(passing, options.verifyCommand, options.signal, options.verifyTimeoutMs);
    }

    let winnerIndex: number | null = null;
    let rationale = "No candidate passed objective verification with code changes.";
    if (passing.length === 1) {
      winnerIndex = passing[0].index;
      rationale = `Candidate ${winnerIndex + 1} (${passing[0].approach}) was the sole passing candidate.`;
    } else if (passing.length > 1) {
      if (options.judgeWinner) {
        const picked = await options.judgeWinner(passing, options.signal);
        const valid = passing.find((c) => c.index === picked.winnerIndex);
        winnerIndex = valid ? valid.index : passing[0].index;
        rationale = picked.rationale;
      } else {
        const sorted = [...passing].sort(
          (a, b) => (b.crossTestsPassed ?? 0) - (a.crossTestsPassed ?? 0) || a.diff.length - b.diff.length,
        );
        winnerIndex = sorted[0].index;
        rationale = `Selected Candidate ${winnerIndex + 1} (cross-tests & smallest passing diff).`;
      }
    }

    let applied = false;
    if (winnerIndex !== null && options.applyWinner !== false) {
      const winner = settled[winnerIndex];
      if (winner && winner.worktree) {
        applied = await applyWorktreeChanges(options.repoRoot, winner.worktree, winner.changedFiles);
      }
    }
    return { candidates: settled, winnerIndex, rationale, applied };
  } finally {
    await Promise.all(
      created.filter((wt): wt is string => Boolean(wt)).map((wt) => removeDetachedWorktree(options.repoRoot, wt)),
    );
  }
}
