/** Cross-package Daddy -> real Harness harvest interop test (runs when sibling skill-harness checkout is built). */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  classifyHarvestCandidate,
  saveHarvestedEval,
  type TurnHarvestSignals,
} from "../src/products/session-harvest.ts";

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

    const quotedSecret = "synthetic-review-value";
    const turn1: TurnHarvestSignals = {
      prompt: `${dashPrompt} with {"token":"${quotedSecret}"}`,
      thrashDetected: true,
      escalated: false,
      reviewBlockers: 0,
      userSteered: false,
      toolFailedAndEdited: true,
      failureSummary: `First turn retry defect {"token":"${quotedSecret}"}`,
      editedFiles: ["src/queue.ts"],
      verifyCommands: [`TOKEN=synthetic-interop-secret-4242 npm test -- queue '{"token":"${quotedSecret}"}'`],
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

    // Verify stubbed classifier request redacts quoted JSON credential
    let classifierSeen = "";
    const fastModel = { provider: "google", id: "gemini-3.5-flash-lite" };
    const classified = await classifyHarvestCandidate({
      signals: turn1,
      fallbackModel: fastModel,
      env,
      registry: {
        find: () => fastModel,
        hasConfiguredAuth: () => true,
        streamSimple: (_m, ctx) => {
          classifierSeen = ctx.messages[0].content[0].text;
          return {
            result: async () => ({
              stopReason: "stop",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    harvest: true,
                    category: "thrash",
                    confidence: 0.9,
                    scenarioId: maxId,
                    reason: `Queue bug {"token":"${quotedSecret}"}`,
                  }),
                },
              ],
            }),
          };
        },
      },
    });
    assert.equal(classified.harvest, true);
    assert.ok(!classifierSeen.includes(quotedSecret), "quoted JSON credential must be absent from classifier request");
    assert.ok(
      !classified.reason.includes(quotedSecret),
      "quoted JSON credential must be absent from classifier reason",
    );

    // 1) Real Harness CLI handoff (plus direct JSON output check)
    const r1 = saveHarvestedEval({
      cwd: repo,
      scenarioId: maxId,
      signals: turn1,
      reason: `Queue ordering bug {"token":"${quotedSecret}"}`,
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

    // 2) Built-in writer spec check for the same quoted JSON secret
    const b1 = saveHarvestedEval({
      cwd: repo,
      scenarioId: maxId,
      signals: turn1,
      reason: `Queue ordering bug {"token":"${quotedSecret}"}`,
      env,
      outDirOverride: outSpaces,
      preferCli: false,
    });

    assert.equal(r1.saved, true);
    assert.equal(r2.saved, true);
    assert.equal(b1.saved, true);
    assert.equal(r1.via, "skill-harness-cli");
    assert.equal(r2.via, "skill-harness-cli");
    assert.equal(b1.via, "builtin");
    assert.ok(r1.path && r2.path && b1.path && new Set([r1.path, r2.path, b1.path]).size === 3);
    assert.ok(r1.path.includes("harvested evals dir"));
    assert.ok(!JSON.stringify(r1).includes("synthetic-interop-secret-4242"));
    assert.ok(!JSON.stringify(r1).includes(quotedSecret), "Harness JSON output must not contain quoted JSON secret");
    assert.ok(!readFileSync(r1.path, "utf8").includes("synthetic-interop-secret-4242"));
    assert.ok(
      !readFileSync(r1.path, "utf8").includes(quotedSecret),
      "Harness CLI YAML must not contain quoted JSON secret",
    );
    assert.ok(
      !readFileSync(b1.path, "utf8").includes(quotedSecret),
      "Built-in YAML must not contain quoted JSON secret",
    );

    const spec1 = harnessCore.loadSpec(r1.path);
    const spec2 = harnessCore.loadSpec(r2.path);
    const specB1 = harnessCore.loadSpec(b1.path);
    assert.equal(spec1.scenarios[0].id, maxId);
    assert.ok(spec1.scenarios[0].turns[0].startsWith(dashPrompt));
    assert.ok(!spec1.scenarios[0].turns[0].includes(quotedSecret));
    assert.ok(spec1.scenarios[0].checklist.join("\n").includes("npm test -- queue"));
    assert.ok(!spec1.scenarios[0].checklist.join("\n").includes("backoff.test.ts"));
    assert.ok(!specB1.scenarios[0].turns[0].includes(quotedSecret));
    assert.ok(!specB1.scenarios[0].checklist.join("\n").includes(quotedSecret));

    assert.equal(spec2.scenarios[0].id, maxId);
    assert.equal(spec2.scenarios[0].turns[0], dashPrompt);
    assert.ok(spec2.scenarios[0].checklist.join("\n").includes("vitest run backoff.test.ts"));
    assert.ok(!spec2.scenarios[0].checklist.join("\n").includes("queue"));
  },
);
