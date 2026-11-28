/** End-to-end unit coverage for the Turn-1 specialist, mode-fanout, scoped-review, model-recovery, and tournament contracts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createCapacityAllocator } from "../src/kernel/capacity.ts";
import { AMBITIOUS_FANOUT_BUDGET, MAX_CHILDREN_PER_CALL, STANDARD_FANOUT_BUDGET } from "../src/kernel/fanout.ts";
import { DEFAULT_MAX_DEPTH, MAX_SELECTABLE_DEPTH } from "../src/kernel/propagation.ts";
import { planDelegation } from "../src/kernel/delegate.ts";
import { parentProxiedTools } from "../src/kernel/parent-tools.ts";
import { readEcosystemConfig, saveEcosystemConfig } from "../src/kernel/ecosystem-config.ts";
import { runWorktreeTournament } from "../src/executors/worktree-tournament.ts";
import { collectReviewDiff, resolveReviewScope, syncModeFanout } from "../extensions/work-mode.ts";
import { recoverUnavailableRoleModel } from "../extensions/model-recovery.ts";
import { parseConfiguredModel } from "../extensions/definition-runtime.ts";
import { extractAttachedBriefSha256, resolveChildExtensionsFor } from "../extensions/specialist-helpers.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("mode fanout switches dynamically between Standard 8 and Ambitious 24 while depth defaults to 4 (selectable up to 8)", () => {
  assert.equal(STANDARD_FANOUT_BUDGET, 8);
  assert.equal(AMBITIOUS_FANOUT_BUDGET, 24);
  assert.equal(MAX_CHILDREN_PER_CALL, 8);
  assert.equal(DEFAULT_MAX_DEPTH, 4);
  assert.equal(MAX_SELECTABLE_DEPTH, 8);

  const capacity = createCapacityAllocator(STANDARD_FANOUT_BUDGET);
  const fakeSession = { depth: 0, fanoutBudget: 8, maxDepth: 6, capacity } as never;
  const r1 = capacity.reserve("exec-1", 0);
  assert.equal(r1.ok, true);
  assert.equal(capacity.available, 7);

  syncModeFanout(fakeSession, { mode: "ambitious", emphases: [] });
  assert.equal(capacity.total, 24);
  assert.equal(capacity.available, 23);
  assert.equal((fakeSession as { maxDepth: number }).maxDepth, 6, "depth survives mode switch");

  // Reserve 10 more active slots under Ambitious (11 total active)
  for (let i = 2; i <= 11; i++) {
    assert.equal(capacity.reserve(`exec-${i}`, 0).ok, true);
  }
  assert.equal(capacity.peakActive, 11);

  // Switch back to Standard (8): restores ceiling to 8 without dropping live reservations
  syncModeFanout(fakeSession, { mode: "standard", emphases: [] });
  assert.equal(capacity.total, 8);
  assert.equal(capacity.available, 0);
  assert.equal(capacity.reserve("exec-over", 0).ok, false);
  assert.equal((fakeSession as { maxDepth: number }).maxDepth, 6, "depth survives switching back to Standard");
});

test("assigned specialists can read Scout briefs and Bookie across configured/local models while scout_research stays same-model", () => {
  const descriptors = [
    "scout_research",
    "scout_brief_read",
    "bookie_search",
    "bookie_read",
    "bookie_propose_memory",
  ].map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } }));
  const facts = {
    depth: 0,
    autoModeRef: { socketPath: "/tmp/sock", token: "a".repeat(48), ownerId: "b".repeat(32) },
    parentToolExtensionPath: "/ext/parent-tool-proxy.ts",
    parentTools: descriptors,
    rootModel: { provider: "google", id: "gemini-4-neon" },
    childModel: "ollama/qwen3:32b",
  };
  const cross = parentProxiedTools(
    [
      "tool:scout_research",
      "tool:scout_brief_read",
      "tool:bookie_search",
      "tool:bookie_read",
      "tool:bookie_propose_memory",
    ],
    facts,
  ).map((d) => d.name);
  assert.deepEqual(cross, ["scout_brief_read", "bookie_search", "bookie_read", "bookie_propose_memory"]);
});

test("scoped automatic review restricts git diff and untracked files to nested workspace unless widened by prompt", async () => {
  const repo = await tempDir("scoped-review-");
  const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@local"]);
  git(["config", "user.name", "Test"]);
  mkdirSync(join(repo, "app"), { recursive: true });
  mkdirSync(join(repo, "unrelated"), { recursive: true });
  writeFileSync(join(repo, "app", "a.txt"), "base\n");
  writeFileSync(join(repo, "unrelated", "b.txt"), "base\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);

  // Edit both nested workspace and sibling unrelated folder
  writeFileSync(join(repo, "app", "a.txt"), "changed-in-app\n");
  writeFileSync(join(repo, "unrelated", "b.txt"), "changed-in-unrelated\n");
  writeFileSync(join(repo, "unrelated", "stray.md"), "stray untracked note\n");

  const nested = join(repo, "app");
  const defaultScope = resolveReviewScope(nested, "fix the bug in a.txt");
  assert.equal(defaultScope.mode, "workspace");
  const scopedDiff = await collectReviewDiff(nested, defaultScope.mode);
  assert.match(scopedDiff, /changed-in-app/);
  assert.doesNotMatch(scopedDiff, /changed-in-unrelated/);
  assert.doesNotMatch(scopedDiff, /stray untracked note/);

  const widenedScope = resolveReviewScope(nested, "review the whole repo changes");
  assert.equal(widenedScope.mode, "whole-repo");
  const fullDiff = await collectReviewDiff(nested, widenedScope.mode);
  assert.match(fullDiff, /changed-in-app/);
  assert.match(fullDiff, /changed-in-unrelated/);
});

test("explicit model outage recovery offers Use session model once or Choose a new default and preserves other settings", async () => {
  const profile = await tempDir("model-recovery-");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = profile;
  try {
    saveEcosystemConfig({
      models: { strong: "google/gemini-4-neon" },
      harvest: { mode: "suggest", thresholds: { "google/gemini-flash-latest": 0.82 } },
      delegation: { maxDepth: 6 },
    });
    const registry = {
      find: () => ({}),
      getAvailable: () => [
        { provider: "google", id: "gemini-flash-latest" },
        { provider: "ollama", id: "qwen3:32b" },
      ],
      hasConfiguredAuth: () => true,
    };

    const once = await recoverUnavailableRoleModel({
      role: "investigate",
      failedModel: "missing/model",
      sessionModel: "google/gemini-flash-latest",
      registry,
      ctx: {
        hasUI: true,
        ui: {
          select: async (_title, options) => {
            assert.deepEqual(options, ["Use session model once (google/gemini-flash-latest)", "Choose a new default"]);
            return options[0];
          },
        },
      },
    });
    assert.deepEqual(once, { model: "google/gemini-flash-latest", mode: "once" });

    let step = 0;
    const saved = await recoverUnavailableRoleModel({
      role: "investigate",
      failedModel: "missing/model",
      sessionModel: "google/gemini-flash-latest",
      registry,
      ctx: {
        hasUI: true,
        ui: {
          select: async (_title, options) =>
            ++step === 1 ? "Choose a new default" : options.find((o) => o === "ollama/qwen3:32b"),
        },
      },
    });
    assert.deepEqual(saved, { model: "ollama/qwen3:32b", mode: "default" });
    const persisted = readEcosystemConfig();
    assert.equal(persisted?.delegation?.roleModels?.investigate, "ollama/qwen3:32b");
    assert.equal(persisted?.delegation?.maxDepth, 6, "preserves existing delegation depth");
    assert.equal(
      persisted?.harvest?.thresholds?.["google/gemini-flash-latest"],
      0.82,
      "preserves classifier threshold",
    );
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test("tournament preserves completed patches on timeout, retries missing candidate once, enforces comparative evidence & Auto-off ask", async () => {
  const repo = await tempDir("tournament-recovery-");
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@local"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "calc.mjs"), "export const v = 0;\n");
  writeFileSync(
    join(repo, "verify.mjs"),
    "import { v } from './calc.mjs'; const want = Number(process.argv[2]); if (v !== want) process.exit(1);\n",
  );
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);

  // 1) Non-comparative task: candidate 1 passes, candidate 2 times out; surviving patch preserved & applied when Auto ON
  let attempts = [0, 0];
  const outcomeAutoOn = await runWorktreeTournament({
    repoRoot: repo,
    task: "Implement v = 42 in calc.mjs",
    approaches: ["approach A", "approach B"],
    verifyCommand: "node verify.mjs 42",
    autoApplyAllowed: true,
    runCandidate: async ({ index, worktree }) => {
      attempts[index]++;
      if (index === 0) {
        writeFileSync(join(worktree, "calc.mjs"), "export const v = 42;\n");
        return { ok: true, summary: "done" };
      }
      return { ok: false, summary: "", error: "candidate timed out after 30s" };
    },
  });
  assert.equal(outcomeAutoOn.winnerIndex, 0);
  assert.equal(outcomeAutoOn.applied, true);
  assert.ok(outcomeAutoOn.preservedPatchesDir && existsSync(outcomeAutoOn.preservedPatchesDir));
  assert.match(readFileSync(join(repo, "calc.mjs"), "utf8"), /v = 42/);

  // 2) Comparative task ("which candidate is faster"): retries timed-out candidate once; if still only 1 passes, does NOT falsely pick a winner
  writeFileSync(join(repo, "calc.mjs"), "export const v = 0;\n");
  attempts = [0, 0];
  const comparative = await runWorktreeTournament({
    repoRoot: repo,
    task: "Compare speed and determine which candidate is faster for calc.mjs",
    approaches: ["fast path", "lookup table"],
    verifyCommand: "node verify.mjs 7",
    autoApplyAllowed: true,
    runCandidate: async ({ index, worktree }) => {
      attempts[index]++;
      if (index === 0) {
        writeFileSync(join(worktree, "calc.mjs"), "export const v = 7;\n");
        return { ok: true, summary: "fast" };
      }
      return { ok: false, summary: "", error: "candidate timed out after 30s" };
    },
  });
  assert.deepEqual(attempts, [1, 2], "only the timed-out candidate is retried once");
  assert.equal(comparative.applied, false);
  assert.equal(comparative.inconclusive, true);
  assert.equal(comparative.needsDecision, true);
  assert.equal(comparative.comparativeRequired, true);

  // 3) Auto OFF: preserves winning patch and asks before applying
  const autoOff = await runWorktreeTournament({
    repoRoot: repo,
    task: "Set v = 9 in calc.mjs",
    approaches: ["direct", "helper"],
    verifyCommand: "node verify.mjs 9",
    autoApplyAllowed: false,
    runCandidate: async ({ index, worktree }) => {
      writeFileSync(join(worktree, "calc.mjs"), `export const v = ${index === 0 ? 9 : 0};\n`);
      return { ok: true, summary: "done" };
    },
  });
  assert.equal(autoOff.winnerIndex, 0);
  assert.equal(autoOff.applied, false);
  assert.equal(autoOff.needsDecision, true);
  assert.equal(autoOff.preservedPatches?.length, 1);
  assert.equal(autoOff.preservedPatches?.[0]?.candidateIndex, 0);
  assert.match(readFileSync(join(repo, "calc.mjs"), "utf8"), /v = 0/, "workspace untouched when Auto is off");
});

test("parseConfiguredModel accepts both provider/model and provider:model; specialist helpers attach verify extension & brief hashes", () => {
  assert.equal(parseConfiguredModel("ollama/qwen3:32b"), "ollama/qwen3:32b");
  assert.equal(parseConfiguredModel("google:gemini-flash-latest"), "google/gemini-flash-latest");
  const sha = "a".repeat(64);
  assert.deepEqual(
    extractAttachedBriefSha256({
      task: `Read brief {"version":1,"producer":"pi-scout-research","kind":"research-brief","session":"${"b".repeat(64)}","sha256":"${sha}","bytes":120}`,
    }),
    [sha],
  );
  // Plan with childExtensions injects -e for trusted verification
  const plan = planDelegation(
    { task: "build step", tools: ["read", "edit", "edit-diff", "bash"] },
    {
      ownGrant: ["tool:*"],
      gated: [],
      depth: 0,
      maxDepth: 4,
      contextFiles: true,
      childExtensions: ["/principal/extensions/verify-before-settle.ts"],
    },
  );
  assert.equal(plan.ok, true);
  assert.ok(!plan.args.includes("--no-context-files"), "trusted workspace inherits AGENTS.md");
  assert.ok(plan.args.includes("/principal/extensions/verify-before-settle.ts"));
  assert.ok(plan.effective.includes("tool:edit-diff"));
  // Untrusted workspace returns no child extensions
  assert.deepEqual(resolveChildExtensionsFor({ projectTrusted: false, cwd: "/tmp" } as never, undefined), []);
});
