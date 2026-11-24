/** Unit tests for parallel git-worktree tournament executor. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { runWorktreeTournament } from "../src/executors/worktree-tournament.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

async function makeRepo() {
  const dir = await tempDir("wt-tournament-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  await writeFile(join(dir, "math.mjs"), "export const add = (a, b) => a - b;\n");
  await writeFile(
    join(dir, "check.mjs"),
    'import assert from "node:assert/strict";\nimport { add } from "./math.mjs";\nassert.equal(add(2, 3), 5);\n',
  );
  git("add", "-A");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "init");
  return dir;
}

test("parallel tournament runs isolated worktrees, selects passing winner, applies changes, and cleans up", async () => {
  const repo = await makeRepo();
  const seenWorktrees: string[] = [];

  const outcome = await runWorktreeTournament({
    repoRoot: repo,
    task: "Fix add(a, b) to return a + b",
    approaches: ["buggy candidate", "correct candidate"],
    verifyCommand: "node check.mjs",
    applyWinner: true,
    runCandidate: async ({ index, worktree }) => {
      seenWorktrees.push(worktree);
      if (index === 0) {
        await writeFile(join(worktree, "math.mjs"), "export const add = (a, b) => a * b;\n");
      } else {
        await writeFile(join(worktree, "math.mjs"), "export const add = (a, b) => a + b;\n");
      }
      return { ok: true, summary: `cand ${index}` };
    },
  });

  assert.equal(outcome.candidates.length, 2);
  assert.equal(outcome.candidates[0].verifyPassed, false);
  assert.equal(outcome.candidates[1].verifyPassed, true);
  assert.equal(outcome.winnerIndex, 1);
  assert.equal(outcome.applied, true);

  // Winner applied cleanly to parent repo
  const finalContent = await readFile(join(repo, "math.mjs"), "utf8");
  assert.equal(finalContent, "export const add = (a, b) => a + b;\n");

  // All temporary worktrees removed
  for (const wt of seenWorktrees) {
    assert.equal(existsSync(wt), false, `worktree ${wt} must be cleaned up`);
  }
  const worktreeList = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
  assert.equal(worktreeList.trim().split(/\r?\n/).length, 1, "only main worktree should remain");
});

test("cold judge breaks ties when multiple parallel candidates pass verification", async () => {
  const repo = await makeRepo();
  let judgedCount = 0;

  const outcome = await runWorktreeTournament({
    repoRoot: repo,
    task: "Fix add(a, b)",
    approaches: ["verbose", "minimal"],
    verifyCommand: "node check.mjs",
    applyWinner: true,
    runCandidate: async ({ index, worktree }) => {
      const code =
        index === 0
          ? "// verbose comment\nexport function add(a, b) {\n  const result = a + b;\n  return result;\n}\n"
          : "export const add = (a, b) => a + b;\n";
      await writeFile(join(worktree, "math.mjs"), code);
      return { ok: true, summary: `cand ${index}` };
    },
    judgeWinner: async (passing) => {
      judgedCount = passing.length;
      return { winnerIndex: 1, rationale: "Candidate 2 is cleaner and minimal." };
    },
  });

  assert.equal(judgedCount, 2);
  assert.equal(outcome.winnerIndex, 1);
  assert.match(outcome.rationale, /Candidate 2/);
  assert.equal(await readFile(join(repo, "math.mjs"), "utf8"), "export const add = (a, b) => a + b;\n");
});

test("tournament retains candidates that git commit and prevents overwriting pre-existing verifier files", async () => {
  const repo = await makeRepo();
  // Add an untracked verifier file in parent workspace
  await writeFile(
    join(repo, "verify.mjs"),
    'import assert from "node:assert/strict";\nimport { add } from "./math.mjs";\nassert.equal(add(10, 5), 15);\n',
  );

  const outcome = await runWorktreeTournament({
    repoRoot: repo,
    task: "Fix add(a, b)",
    approaches: ["commits fix", "tries to tamper verifier"],
    verifyCommand: "node verify.mjs",
    applyWinner: true,
    runCandidate: async ({ index, worktree }) => {
      if (index === 0) {
        await writeFile(join(worktree, "math.mjs"), "export const add = (a, b) => a + b;\n");
        execFileSync("git", ["-C", worktree, "add", "math.mjs"]);
        execFileSync("git", [
          "-C",
          worktree,
          "-c",
          "user.name=Cand",
          "-c",
          "user.email=cand@example.invalid",
          "commit",
          "-q",
          "-m",
          "fix",
        ]);
      } else {
        // Candidate 2 tries to make verify.mjs trivially pass without fixing math.mjs!
        await writeFile(join(worktree, "verify.mjs"), "process.exit(0);\n");
      }
      return { ok: true, summary: `cand ${index}` };
    },
  });

  assert.equal(outcome.candidates[0].verifyPassed, true, "committed candidate must not be disqualified");
  assert.ok(outcome.candidates[0].changedFiles.includes("math.mjs"));
  assert.equal(outcome.candidates[1].verifyPassed, false, "tampered verifier must be restored and fail");
  assert.equal(outcome.winnerIndex, 0);
  assert.equal(await readFile(join(repo, "math.mjs"), "utf8"), "export const add = (a, b) => a + b;\n");
});
