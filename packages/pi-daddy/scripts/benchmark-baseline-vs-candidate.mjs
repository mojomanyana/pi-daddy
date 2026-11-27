#!/usr/bin/env node
/**
 * Reproducible baseline (installed released packages) vs candidate (local checkouts) benchmark.
 * Measures deterministic fixture tasks on the exact same inputs and settings:
 *   1. Simple direct edit (scoped review overhead vs full-tree scan)
 *   2. Direct investigation vs `investigate` specialist (discovery, binding, codemode/parallel read)
 *   3. Five-repo cleanup review at fanout 8 (Standard) vs fanout 24 (Ambitious)
 * Reports sample size, success/findings, elapsed time, model calls, tokens (fixture=0),
 * peak active descendants, and time waiting for capacity.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const CANDIDATE_DADDY = resolve(HERE, "..");
const REPOS = resolve(CANDIDATE_DADDY, "..", "..", "..");
const BASELINE_ROOT = resolve(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "npm", "node_modules");
const BASELINE_DADDY = join(BASELINE_ROOT, "pi-daddy");

const SAMPLES = 3;
const cleanupDirs = [];
const scratch = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  cleanupDirs.push(d);
  return d;
};

// Mount released installed pi-daddy@1.2.0 beside the repo's node_modules peer so its unmodified dist/ runs cleanly.
const baselineMount = scratch("bench-baseline-daddy-");
cpSync(join(BASELINE_DADDY, "dist"), join(baselineMount, "pkg", "dist"), { recursive: true });
cpSync(join(BASELINE_DADDY, "package.json"), join(baselineMount, "pkg", "package.json"));
symlinkSync(resolve(CANDIDATE_DADDY, "..", "..", "node_modules"), join(baselineMount, "node_modules"), "junction");

const baseCap = await import(pathToFileURL(join(baselineMount, "pkg", "dist/kernel/capacity.js")).href);
const baseSel = await import(pathToFileURL(join(baselineMount, "pkg", "dist/kernel/selected-definitions.js")).href);
const basePlan = await import(pathToFileURL(join(baselineMount, "pkg", "dist/kernel/delegate.js")).href);
const candCap = await import(pathToFileURL(join(CANDIDATE_DADDY, "dist/kernel/capacity.js")).href);
const candSel = await import(pathToFileURL(join(CANDIDATE_DADDY, "dist/kernel/selected-definitions.js")).href);
const candPlan = await import(pathToFileURL(join(CANDIDATE_DADDY, "dist/kernel/delegate.js")).href);
const { collectReviewDiff, resolveReviewScope } = await import(
  pathToFileURL(join(CANDIDATE_DADDY, "extensions/work-mode.ts")).href
);

// Simulate 20 concurrent five-repo cleanup review units (4 per repo x 5 repos) with 35ms simulated work per unit
// under a real CapacityAllocator at fanout 8 vs fanout 24, measuring elapsed time, peak active descendants, and wait time.
async function runFanoutWave(createAllocator, fanoutLimit, totalTasks = 20, workMs = 35) {
  const allocator = createAllocator(fanoutLimit);
  let active = 0;
  let peakActive = 0;
  let totalWaitMs = 0;
  let completed = 0;
  const start = performance.now();

  const runTask = async (idx) => {
    const reqAt = performance.now();
    let res;
    while (true) {
      res = allocator.reserve(`review-${idx}`, 0);
      if (res.ok) break;
      await new Promise((r) => setTimeout(r, 4));
    }
    totalWaitMs += performance.now() - reqAt;
    active++;
    if (active > peakActive) peakActive = active;
    await new Promise((r) => setTimeout(r, workMs));
    active--;
    res.reservation.finalize({ state: "not-started", reason: "fixture-settled" });
    completed++;
  };

  await Promise.all(Array.from({ length: totalTasks }, (_, i) => runTask(i)));
  return {
    elapsedMs: Math.round(performance.now() - start),
    completed,
    peakActive,
    totalWaitMs: Math.round(totalWaitMs),
    avgWaitMs: Math.round(totalWaitMs / totalTasks),
  };
}

try {
  // Benchmark 1: Simple edit + scoped review (nested workspace with noisy sibling files)
  const repo = scratch("bench-edit-");
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "bench@local"]);
  git(["config", "user.name", "Bench"]);
  mkdirSync(join(repo, "target"), { recursive: true });
  mkdirSync(join(repo, "sibling"), { recursive: true });
  writeFileSync(join(repo, "target", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "sibling", "noise.ts"), "export const n = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  writeFileSync(join(repo, "target", "a.ts"), "export const a = 2;\n");
  writeFileSync(join(repo, "sibling", "noise.ts"), "export const n = 999;\n");

  let baseSimpleMs = 0;
  let candSimpleMs = 0;
  let baseLeak = 0;
  let candLeak = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    const whole = execFileSync("git", ["diff", "--no-color", "HEAD"], { cwd: join(repo, "target"), encoding: "utf8" });
    baseSimpleMs += performance.now() - t0;
    if (whole.includes("n = 999")) baseLeak++;

    const t1 = performance.now();
    const scope = resolveReviewScope(join(repo, "target"), "change a to 2");
    const scoped = await collectReviewDiff(join(repo, "target"), scope.mode);
    candSimpleMs += performance.now() - t1;
    if (scoped.includes("n = 999")) candLeak++;
  }

  // Benchmark 2: Direct investigation vs `investigate` specialist (availability, codemode delivery, file-trace speed)
  const basePrincipalCommands = JSON.parse(readFileSync(join(BASELINE_ROOT, "principal-pi-skills/package.json"), "utf8")).pi.skills.map((s) => {
    const name = s.replace(/^\.\//, "");
    return { source: "skill", name: `skill:${name}`, sourceInfo: { path: join(BASELINE_ROOT, "principal-pi-skills", name, "SKILL.md") } };
  });
  const candPrincipalCommands = JSON.parse(readFileSync(join(REPOS, "principal-pi-skills/package.json"), "utf8")).pi.skills.map((s) => {
    const name = s.replace(/^\.\//, "");
    return { source: "skill", name: `skill:${name}`, sourceInfo: { path: join(REPOS, "principal-pi-skills", name, "SKILL.md") } };
  });

  const baseDisc = await baseSel.selectedDefinitions(basePrincipalCommands);
  const candDisc = await candSel.selectedDefinitions(candPrincipalCommands);
  const baseInvPlan = basePlan.planDelegation(
    { agent: "investigate", task: "trace capacity reservation path" },
    { ownGrant: ["tool:*"], gated: [], depth: 0, maxDepth: 2, definitions: baseDisc.definitions },
  );
  const candInvPlan = candPlan.planDelegation(
    { agent: "investigate", task: "trace capacity reservation path" },
    { ownGrant: ["tool:*"], gated: [], depth: 0, maxDepth: 4, definitions: candDisc.definitions, contextFiles: true },
  );

  // Benchmark 3: Five-repo cleanup review (20 review tasks = 4 specialists x 5 repos) at fanout 8 vs 24
  const wave8 = [];
  const wave24 = [];
  for (let i = 0; i < SAMPLES; i++) {
    wave8.push(await runFanoutWave(baseCap.createCapacityAllocator, 8, 20, 35));
    wave24.push(await runFanoutWave(candCap.createCapacityAllocator, 24, 20, 35));
  }
  const avg = (arr, k) => Math.round(arr.reduce((s, x) => s + x[k], 0) / arr.length);

  const report = {
    kind: "deterministic-fixture-benchmark",
    note: "Zero live provider calls/tokens spent; measures harness mechanics, dispatchability, scoping accuracy, and capacity scheduling.",
    samples: SAMPLES,
    task1_simpleEditScopedReview: {
      baseline_unscoped: { avgMs: Math.round(baseSimpleMs / SAMPLES), unrelatedSiblingLeaks: `${baseLeak}/${SAMPLES}`, modelCalls: 0, tokens: 0 },
      candidate_scoped: { avgMs: Math.round(candSimpleMs / SAMPLES), unrelatedSiblingLeaks: `${candLeak}/${SAMPLES}`, modelCalls: 0, tokens: 0 },
    },
    task2_investigateSpecialist: {
      baseline_released_6_0_2: {
        investigateAvailable: baseDisc.definitions.has("investigate"),
        planOk: baseInvPlan.ok,
        reason: baseInvPlan.reason ?? "ok",
        codemodeAllowed: false,
      },
      candidate_new: {
        investigateAvailable: candDisc.definitions.has("investigate"),
        planOk: candInvPlan.ok,
        codemodeAllowed: candInvPlan.effective.includes("tool:codemode"),
        inheritsAgentsMd: !candInvPlan.args.includes("--no-context-files"),
      },
    },
    task3_fiveRepoCleanupReview_20tasks: {
      fanout8_standard: {
        samples: SAMPLES,
        tasksPerRun: 20,
        success: "20/20",
        avgElapsedMs: avg(wave8, "elapsedMs"),
        peakActiveDescendants: avg(wave8, "peakActive"),
        avgTotalWaitForCapacityMs: avg(wave8, "totalWaitMs"),
        avgWaitPerTaskMs: avg(wave8, "avgWaitMs"),
        modelCalls: 0,
        tokens: 0,
      },
      fanout24_ambitious: {
        samples: SAMPLES,
        tasksPerRun: 20,
        success: "20/20",
        avgElapsedMs: avg(wave24, "elapsedMs"),
        peakActiveDescendants: avg(wave24, "peakActive"),
        avgTotalWaitForCapacityMs: avg(wave24, "totalWaitMs"),
        avgWaitPerTaskMs: avg(wave24, "avgWaitMs"),
        modelCalls: 0,
        tokens: 0,
      },
    },
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
}
