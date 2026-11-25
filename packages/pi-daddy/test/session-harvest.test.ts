/** Unit tests for Bucket 4 (Issues #1 & #2): fail-closed auto-harvesting, complete redaction, and Harness-compatible two-turn specs. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GrantsSession } from "../extensions/session.ts";
import { registerWebDashboard } from "../extensions/web-dashboard.ts";
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
  verifyCommands: ["API_TOKEN=sk-verify9876543210abcdef DB_PASSWORD=supersecretpass npm test"],
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
  assert.ok(
    !seenPrompt.includes("sk-verify9876543210"),
    "verifyCommands credential must be redacted before classifier",
  );
  assert.ok(!seenPrompt.includes("supersecretpass"), "password in verifyCommands must be redacted");
  assert.ok(!seenPrompt.includes("eyJhbGci"), "Bearer token must be redacted before Stage 2 classifier");

  const lowConf = await classifyHarvestCandidate({
    signals: baseSignals,
    registry,
    env,
    minConfidence: 0.95,
  });
  assert.equal(lowConf.harvest, false);
});

test("Issue #1: invalid ecosystem.json with unrelated bad field fails closed and never classifies or saves when harvest.mode is off", async (t) => {
  const { agent, repo } = tempDirs(t);
  mkdirSync(agent, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
  });

  // Unrelated invalid field (`models.fast: 123`) alongside explicit `harvest.mode: "off"`.
  writeFileSync(
    join(agent, "ecosystem.json"),
    JSON.stringify({ models: { fast: 123 }, harvest: { mode: "off" } }),
    "utf8",
  );

  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const events = new Map<string, Array<(payload: unknown) => void>>();
  let classifierCalls = 0;
  const pi = {
    on(name: string, fn: (...args: unknown[]) => unknown) {
      const list = hooks.get(name) ?? [];
      list.push(fn);
      hooks.set(name, list);
    },
    events: {
      on(name: string, fn: (payload: unknown) => void) {
        const list = events.get(name) ?? [];
        list.push(fn);
        events.set(name, list);
      },
      emit() {},
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;

  registerWebDashboard(pi, { cwd: repo, depth: 0, episodeId: "ep-1", reloadLifecycle: {} } as unknown as GrantsSession);

  const ctx = {
    cwd: repo,
    hasUI: false,
    ui: { notify() {}, setStatus() {} },
    model: { provider: "google", id: "gemini-3.5-flash-lite" },
    modelRegistry: {
      find: () => ({ provider: "google", id: "gemini-3.5-flash-lite" }),
      streamSimple: () => {
        classifierCalls++;
        return {
          result: async () => ({
            stopReason: "stop",
            content: [
              { type: "text", text: '{"harvest":true,"category":"thrash","confidence":0.99,"scenarioId":"bad"}' },
            ],
          }),
        };
      },
    },
  } as unknown as ExtensionCommandContext;

  for (const fn of hooks.get("before_agent_start") ?? []) fn({ prompt: "Fix failing unit test in auth parser" }, ctx);
  for (const fn of events.get("principal:thrash-detected:v1") ?? []) fn({ command: "npm test", signature: "fail" });
  for (const fn of hooks.get("agent_settled") ?? []) fn({}, ctx);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(classifierCalls, 0, "invalid ecosystem.json must not invoke classifier");
  assert.equal(existsSync(harvestOutputDir(repo, { PI_CODING_AGENT_DIR: agent })), false, "must not save any spec");
});

test("Issues #1 & #2: builtin and CLI save paths redact verifyCommands, preserve distinct two-turn specs, and handle paths with spaces", (t) => {
  const { root, repo, agent, env } = tempDirs(t);
  const outWithSpaces = join(root, "harvested evals with spaces");

  const turn1Signals: TurnHarvestSignals = {
    ...baseSignals,
    prompt: "Turn one: fix rate limiter burst window in src/limiter.ts",
    editedFiles: ["src/limiter.ts"],
    verifyCommands: ["API_TOKEN=sk-verify9876543210abcdef DB_PASSWORD=supersecretpass npm test"],
  };
  const turn2Signals: TurnHarvestSignals = {
    ...baseSignals,
    prompt: "Turn two: fix webhook HMAC comparison in src/webhook.ts",
    editedFiles: ["src/webhook.ts"],
    verifyCommands: ["vitest run webhook.test.ts"],
  };

  // Path A: Built-in exporter (two distinct turns into path with spaces)
  const b1 = saveHarvestedEval({
    cwd: repo,
    scenarioId: "limiter-burst-fix",
    signals: turn1Signals,
    reason: "Repeated 429 mismatch",
    env,
    outDirOverride: outWithSpaces,
    preferCli: false,
  });
  const b2 = saveHarvestedEval({
    cwd: repo,
    scenarioId: "webhook-hmac-fix",
    signals: turn2Signals,
    reason: "Timing-unsafe comparison",
    env,
    outDirOverride: outWithSpaces,
    preferCli: false,
  });

  assert.equal(b1.saved, true);
  assert.equal(b2.saved, true);
  assert.equal(b1.via, "builtin");
  assert.equal(b2.via, "builtin");
  assert.ok(b1.path && b2.path && b1.path !== b2.path, "two captures must produce distinct paths");
  assert.ok(existsSync(b1.path) && existsSync(b2.path));
  assert.ok(b1.path.includes("harvested evals with spaces"));
  assert.equal(existsSync(repo), false, "must never create files inside project workspace");

  const yaml1 = readFileSync(b1.path, "utf8");
  const yaml2 = readFileSync(b2.path, "utf8");
  assert.match(yaml1, /id: "limiter-burst-fix"/);
  assert.match(yaml1, /turns:/);
  assert.match(yaml1, /checklist:/);
  assert.match(yaml1, /Turn one: fix rate limiter burst window/);
  assert.ok(!yaml1.includes("sk-verify9876543210abcdef"), "verifyCommands API token must be redacted");
  assert.ok(!yaml1.includes("supersecretpass"), "verifyCommands password must be redacted");
  assert.match(yaml2, /id: "webhook-hmac-fix"/);
  assert.match(yaml2, /Turn two: fix webhook HMAC comparison/);
  assert.ok(!yaml2.includes("Turn one:"));

  // Path B: CLI save path using a stubbed skill-harness CLI (verifying --id, --prompt, --unique, --json, spaces in path)
  const sessionFile = join(root, "two turn session.jsonl");
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: "message", message: { role: "user", content: turn1Signals.prompt } }),
      JSON.stringify({ type: "message", message: { role: "user", content: turn2Signals.prompt } }),
    ].join("\n") + "\n",
  );
  const stubCli = join(root, "stub-harness-cli.mjs");
  writeFileSync(
    stubCli,
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const out = flag("--out"), name = flag("--name"), id = flag("--id"), prompt = flag("--prompt");
const specDir = join(out, name, "tests");
mkdirSync(specDir, { recursive: true });
const specPath = join(specDir, "specification.yaml");
writeFileSync(specPath, [
  "skill: " + JSON.stringify(name),
  'judge_persona: "senior engineer"',
  "ship_bar: { total: 1, min_pass: 1, no_critical_fail: true }",
  "critical: [" + JSON.stringify(id) + "]",
  "scenarios:",
  "  - id: " + JSON.stringify(id),
  "    title: " + JSON.stringify("CLI " + id),
  "    critical: true",
  "    turns: [" + JSON.stringify(prompt) + "]",
  '    checklist: ["Passes verification"]',
  ""
].join("\\n"), "utf8");
console.log(JSON.stringify({ skillName: name, scenarioId: id, specPath }));
`,
  );

  const c1 = saveHarvestedEval({
    cwd: repo,
    scenarioId: "cli-turn-1",
    signals: turn1Signals,
    sessionFile,
    env,
    outDirOverride: outWithSpaces,
    cliCommand: process.execPath,
    cliArgsPrefix: [stubCli],
  });
  const c2 = saveHarvestedEval({
    cwd: repo,
    scenarioId: "cli-turn-2",
    signals: turn2Signals,
    sessionFile,
    env,
    outDirOverride: outWithSpaces,
    cliCommand: process.execPath,
    cliArgsPrefix: [stubCli],
  });
  assert.equal(c1.via, "skill-harness-cli");
  assert.equal(c2.via, "skill-harness-cli");
  assert.ok(c1.path && c2.path && c1.path !== c2.path);
  assert.ok(readFileSync(c1.path, "utf8").includes("Turn one: fix rate limiter"));
  assert.ok(readFileSync(c2.path, "utf8").includes("Turn two: fix webhook HMAC"));
  assert.ok(!redactHarvestText("https://alice:topsecret@example.com/api").includes("topsecret"));
  assert.ok(harvestOutputDir(repo, env).startsWith(agent));
});
