/** Cross-package Daddy -> real Harness harvest interop test (runs when sibling skill-harness checkout is built). */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { saveHarvestedEval, type TurnHarvestSignals } from "../src/products/session-harvest.ts";

const repoParent = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const harnessCliEntry =
  process.env.PI_DADDY_HARNESS_CLI || join(repoParent, "skill-harness", "packages", "cli", "dist", "cli.js");
const harnessCoreEntry =
  process.env.PI_DADDY_HARNESS_CORE || join(repoParent, "skill-harness", "packages", "core", "dist", "index.js");
const hasRealHarness = existsSync(harnessCliEntry) && existsSync(harnessCoreEntry);

test(
  "P1/P2 cross-package: real Harness entry point handles repeated -- prompts, TOKEN= redaction, 48-char IDs, and paths with spaces",
  { skip: !hasRealHarness && "sibling skill-harness build not present on isolated single-repo runner" },
  async (t: TestContext) => {
    const root = mkdtempSync(join(tmpdir(), "pi-daddy-harness-interop-"));
    const agent = join(root, "agent dir");
    const repo = join(root, "repo dir");
    const outSpaces = join(root, "harvested evals dir");
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const harnessCore = (await import(pathToFileURL(harnessCoreEntry).href)) as {
      loadSpec: (path: string) => {
        scenarios: Array<{ id: string; turns: string[]; checklist: string[] }>;
      };
    };

    const maxId = "m".repeat(48);
    const dashPrompt = "--strict-mode fix retry queue ordering";
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agent };

    const turn1: TurnHarvestSignals = {
      prompt: dashPrompt,
      thrashDetected: true,
      escalated: false,
      reviewBlockers: 0,
      userSteered: false,
      toolFailedAndEdited: true,
      failureSummary: "First turn retry defect",
      editedFiles: ["src/queue.ts"],
      verifyCommands: ["TOKEN=synthetic-interop-secret-4242 npm test -- queue"],
    };
    const turn2: TurnHarvestSignals = {
      prompt: dashPrompt,
      thrashDetected: false,
      escalated: true,
      reviewBlockers: 1,
      userSteered: false,
      toolFailedAndEdited: true,
      failureSummary: "Second turn backoff defect",
      editedFiles: ["src/backoff.ts"],
      verifyCommands: ["vitest run backoff.test.ts"],
    };

    const r1 = saveHarvestedEval({
      cwd: repo,
      scenarioId: maxId,
      signals: turn1,
      reason: "Queue ordering bug",
      env,
      outDirOverride: outSpaces,
      cliCommand: process.execPath,
      cliArgsPrefix: [harnessCliEntry],
    });
    const r2 = saveHarvestedEval({
      cwd: repo,
      scenarioId: maxId,
      signals: turn2,
      reason: "Backoff clamp bug",
      env,
      outDirOverride: outSpaces,
      cliCommand: process.execPath,
      cliArgsPrefix: [harnessCliEntry],
    });

    assert.equal(r1.saved, true);
    assert.equal(r2.saved, true);
    assert.equal(r1.via, "skill-harness-cli");
    assert.equal(r2.via, "skill-harness-cli");
    assert.ok(r1.path && r2.path && r1.path !== r2.path);
    assert.ok(r1.path.includes("harvested evals dir"));
    assert.ok(!JSON.stringify(r1).includes("synthetic-interop-secret-4242"));
    assert.ok(!readFileSync(r1.path, "utf8").includes("synthetic-interop-secret-4242"));

    const spec1 = harnessCore.loadSpec(r1.path);
    const spec2 = harnessCore.loadSpec(r2.path);
    assert.equal(spec1.scenarios[0].id, maxId);
    assert.equal(spec1.scenarios[0].turns[0], dashPrompt);
    assert.ok(spec1.scenarios[0].checklist.join("\n").includes("npm test -- queue"));
    assert.ok(!spec1.scenarios[0].checklist.join("\n").includes("backoff.test.ts"));

    assert.equal(spec2.scenarios[0].id, maxId);
    assert.equal(spec2.scenarios[0].turns[0], dashPrompt);
    assert.ok(spec2.scenarios[0].checklist.join("\n").includes("vitest run backoff.test.ts"));
    assert.ok(!spec2.scenarios[0].checklist.join("\n").includes("queue"));
  },
);
