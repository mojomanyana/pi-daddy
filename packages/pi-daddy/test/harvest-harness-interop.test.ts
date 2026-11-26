/** Cross-package Daddy -> real Harness harvest interop test (runs when sibling skill-harness checkout is built). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
    const escapedHead = "synthetic-escaped-head";
    const escapedTail = "synthetic-escaped-tail";
    const escapedJson = `{"token":"${quotedSecret}","password":"${escapedHead}\\"${escapedTail}"}`;
    const turn1: TurnHarvestSignals = {
      prompt: `${dashPrompt} with ${escapedJson}`,
      thrashDetected: true,
      escalated: false,
      reviewBlockers: 0,
      userSteered: false,
      toolFailedAndEdited: true,
      failureSummary: `First turn retry defect ${escapedJson}`,
      editedFiles: ["src/queue.ts"],
      verifyCommands: [`TOKEN=synthetic-interop-secret-4242 npm test -- queue '${escapedJson}'`],
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
                    reason: `Queue bug ${escapedJson}`,
                  }),
                },
              ],
            }),
          };
        },
      },
    });
    assert.equal(classified.harvest, true);
    for (const secret of [quotedSecret, escapedHead, escapedTail]) {
      assert.ok(!classifierSeen.includes(secret), `${secret} must be absent from classifier request`);
      assert.ok(!classified.reason.includes(secret), `${secret} must be absent from classifier reason`);
    }

    // 1) Real Harness CLI handoff (plus direct raw JSON stdout check with unredacted escaped-quote input)
    const r1 = saveHarvestedEval({
      cwd: repo,
      scenarioId: maxId,
      signals: turn1,
      reason: `Queue ordering bug ${escapedJson}`,
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

    const rawCli = spawnSync(
      process.execPath,
      [harnessCliEntry, "harvest", "--turn-json", "-", "--out", outSpaces, "--unique", "--json"],
      {
        input: JSON.stringify({
          scenarioId: "raw-escaped-json-check",
          prompt: `Fix escaped password ${escapedJson}`,
          verifyCommands: [`npm test -- '${escapedJson}'`],
        }),
        encoding: "utf8",
        shell: false,
        env,
      },
    );
    assert.equal(rawCli.status, 0, rawCli.stderr);
    const rawCliParsed = JSON.parse(rawCli.stdout.trim()) as { specPath: string };
    assert.ok(existsSync(rawCliParsed.specPath));

    // 2) Built-in writer spec check for the same escaped-quote JSON secret
    const b1 = saveHarvestedEval({
      cwd: repo,
      scenarioId: maxId,
      signals: turn1,
      reason: `Queue ordering bug ${escapedJson}`,
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
    for (const secret of ["synthetic-interop-secret-4242", quotedSecret, escapedHead, escapedTail]) {
      assert.ok(!JSON.stringify(r1).includes(secret), `Daddy->Harness result must not contain ${secret}`);
      assert.ok(!rawCli.stdout.includes(secret), `Harness raw JSON stdout must not contain ${secret}`);
      assert.ok(!readFileSync(r1.path, "utf8").includes(secret), `Harness CLI YAML must not contain ${secret}`);
      assert.ok(
        !readFileSync(rawCliParsed.specPath, "utf8").includes(secret),
        `Direct Harness CLI YAML must not contain ${secret}`,
      );
      assert.ok(!readFileSync(b1.path, "utf8").includes(secret), `Built-in YAML must not contain ${secret}`);
    }

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
