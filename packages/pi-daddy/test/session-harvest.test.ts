/** Unit tests for Bucket 4 (Option A + Mode 2): 2-stage classifier-driven session harvesting. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  classifyHarvestCandidate,
  createTurnHarvestTracker,
  hasHarvestSignal,
  redactHarvestText,
  saveHarvestedEval,
  type TurnHarvestSignals,
} from "../src/products/session-harvest.ts";
import { harvestOutputDir, readEcosystemConfig, saveEcosystemConfig } from "../src/kernel/ecosystem-config.ts";

function tempDirs(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-daddy-harvest-"));
  const agent = join(root, "agent");
  const repo = join(root, "my-app");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, agent, repo, env: { PI_CODING_AGENT_DIR: agent } as NodeJS.ProcessEnv };
}

const baseSignals: TurnHarvestSignals = {
  prompt: "Fix auth header parsing when token=sk-1234567890abcdefghijklmno is supplied",
  thrashDetected: true,
  escalated: false,
  reviewBlockers: 0,
  userSteered: false,
  toolFailedAndEdited: true,
  failureSummary: "AssertionError: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 rejected with 401",
  editedFiles: ["src/auth.ts"],
  verifyCommands: ["npm test"],
};

test("Stage 1 filter skips clean routine turns at zero cost and passes real signals", () => {
  const tracker = createTurnHarvestTracker();
  tracker.reset("Fix typo in README");
  assert.equal(hasHarvestSignal(tracker.snapshot()), false);

  tracker.observeToolStart("edit", { path: "src/auth.ts" });
  tracker.observeToolStart("bash", { command: "npm test" });
  tracker.observeToolEnd(true);
  assert.equal(hasHarvestSignal(tracker.snapshot()), true);
});

test("Stage 2 classifier redacts secrets before dispatch, uses fast tier fallback, and enforces confidence threshold", async (t) => {
  const { env } = tempDirs(t);
  saveEcosystemConfig(
    {
      models: { fast: "missing/model" },
      modelFallbacks: { fast: ["google/gemini-3.5-flash-lite"] },
      harvest: { mode: "auto", minConfidence: 0.75 },
    },
    env,
  );
  assert.equal(readEcosystemConfig(env)?.harvest?.mode, "auto");

  const fastModel = { provider: "google", id: "gemini-3.5-flash-lite" };
  let seenPrompt = "";
  const registry = {
    find: (p: string, id: string) => (p === "google" && id === "gemini-3.5-flash-lite" ? fastModel : undefined),
    streamSimple: (model: unknown, ctx: { messages: Array<{ content: Array<{ text: string }> }> }) => {
      assert.equal(model, fastModel);
      seenPrompt = ctx.messages[0].content[0].text;
      return {
        result: async () => ({
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                harvest: true,
                category: "thrash",
                confidence: 0.91,
                scenarioId: "Auth Header Parsing Fix!",
                reason: "Repeated 401 failure on malformed bearer split",
              }),
            },
          ],
        }),
      };
    },
  };

  const decided = await classifyHarvestCandidate({ signals: baseSignals, registry, env });
  assert.equal(decided.harvest, true);
  assert.equal(decided.category, "thrash");
  assert.equal(decided.scenarioId, "auth-header-parsing-fix");
  assert.equal(decided.modelUsed, "google/gemini-3.5-flash-lite");
  assert.ok(!seenPrompt.includes("sk-1234567890"), "API key must be redacted before Stage 2 classifier");
  assert.ok(!seenPrompt.includes("eyJhbGci"), "Bearer token must be redacted before Stage 2 classifier");

  // Below minConfidence is rejected
  const lowConf = await classifyHarvestCandidate({
    signals: baseSignals,
    registry,
    env,
    minConfidence: 0.95,
  });
  assert.equal(lowConf.harvest, false);
});

test("Mode 2 auto-save writes secret-redacted specification.yaml into private user state dir (zero repo pollution)", (t) => {
  const { repo, agent, env } = tempDirs(t);
  const out = saveHarvestedEval({
    cwd: repo,
    scenarioId: "auth-header-fix",
    signals: baseSignals,
    reason: "Repeated 401 failure",
    env,
    preferCli: false,
  });
  assert.equal(out.saved, true);
  assert.equal(out.via, "builtin");
  assert.ok(out.path && existsSync(out.path));
  assert.ok(out.path!.startsWith(harvestOutputDir(repo, env)));
  assert.ok(out.path!.startsWith(agent), "must save under private agent state dir, never inside repo");
  assert.equal(existsSync(repo), false, "must never create files inside project workspace");

  const yaml = readFileSync(out.path!, "utf8");
  assert.match(yaml, /id: auth-header-fix/);
  assert.match(yaml, /npm test/);
  assert.ok(!yaml.includes("sk-1234567890"));
  assert.ok(!redactHarvestText("password=supersecret123").includes("supersecret123"));
});
