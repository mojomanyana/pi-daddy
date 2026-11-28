/**
 * Tournament timeout preservation, comparative-evidence check, and Auto-gated apply policy (Layer 2: executors).
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CandidateRunResult } from "./worktree-tournament.ts";

const COMPARATIVE_TASK_RE = new RegExp(
  [
    "\\b(which\\s+(?:candidate|approach|option|implementation|version)\\s+is\\s+(?:faster|slower|better|smaller|cleaner)",
    "compare\\s+(?:speed|latency|throughput|performance|benchmarks?)",
    "faster\\s+(?:approach|candidate|implementation)",
    "benchmark\\s+comparison)\\b",
  ].join("|"),
  "i",
);

/** True when the task explicitly requires comparative evidence across >=2 candidates. */
export function requiresComparativeEvidence(task: string): boolean {
  return COMPARATIVE_TASK_RE.test(task);
}

/** True when a candidate failed due to stalling or timing out. */
export function candidateTimedOut(candidate: Pick<CandidateRunResult, "ok" | "error">): boolean {
  return !candidate.ok && Boolean(candidate.error && /timed?\s*out|stall/i.test(candidate.error));
}

export interface PreservedCandidatePatch {
  readonly candidateIndex: number;
  readonly patchPath: string;
  readonly evidencePath: string;
  readonly changedFiles: readonly string[];
  readonly verifyPassed: boolean;
}

/** Persist completed candidate diffs and verification evidence so a stall/timeout never loses work. */
export async function preserveCompletedCandidates(
  candidates: readonly CandidateRunResult[],
): Promise<{ dir: string; patches: PreservedCandidatePatch[] } | undefined> {
  const completed = candidates.filter((c) => c.changedFiles.length > 0 && c.diff.trim().length > 0);
  if (completed.length === 0) return undefined;
  const dir = await mkdtemp(join(tmpdir(), "pi-daddy-tournament-patches-"));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const patches: PreservedCandidatePatch[] = [];
  for (const c of completed) {
    const patchPath = join(dir, `candidate-${c.index + 1}.patch`);
    const evidencePath = join(dir, `candidate-${c.index + 1}-verify.json`);
    await writeFile(patchPath, `${c.diff}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          candidate: c.index + 1,
          approach: c.approach,
          ok: c.ok,
          verifyPassed: c.verifyPassed,
          verifyExitCode: c.verifyExitCode,
          changedFiles: c.changedFiles,
          crossTestsPassed: c.crossTestsPassed ?? 0,
          verifyOutput: c.verifyOutput,
        },
        null,
        2,
      ) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    patches.push({
      candidateIndex: c.index,
      patchPath,
      evidencePath,
      changedFiles: c.changedFiles,
      verifyPassed: c.verifyPassed,
    });
  }
  return { dir, patches };
}
