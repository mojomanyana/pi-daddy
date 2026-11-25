/** Unit tests for Bucket 4 & Review P1/P2: fail-closed harvesting, structured handoff, redaction, 48-char IDs, Windows .cmd shim. */
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
  resolveHarnessCliCommand,
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
  verifyCommands: ["TOKEN=synthetic-token-12345 DB_PASSWORD=supersecretpass npm test"],
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

test("Stage 2 classifier redacts secrets before dispatch, skips unauthenticated primary, and enforces confidence threshold", async (t) => {
  const { env } = tempDirs(t);
  saveEcosystemConfig(
    {
      models: { fast: "fireworks/unauthed-model" },
      modelFallbacks: { fast: ["google/gemini-3.5-flash-lite"] },
      harvest: { mode: "auto", minConfidence: 0.75 },
    },
    env,
  );
  assert.equal(readEcosystemConfig(env)?.harvest?.mode, "auto");

  const unauthedModel = { provider: "fireworks", id: "unauthed-model" };
  const fastModel = { provider: "google", id: "gemini-3.5-flash-lite" };
  let seenPrompt = "";
  const registry = {
    find: (p: string, id: string) => {
      if (p === "fireworks" && id === "unauthed-model") return unauthedModel;
      if (p === "google" && id === "gemini-3.5-flash-lite") return fastModel;
      return undefined;
    },
    hasConfiguredAuth: (model: unknown) => model === fastModel,
    streamSimple: (model: unknown, ctx: { messages: Array<{ content: Array<{ text: string }> }> }) => {
      assert.equal(model, fastModel, "must skip catalogued primary lacking auth and use authenticated fallback");
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
  assert.ok(!seenPrompt.includes("synthetic-token-12345"), "TOKEN= in verifyCommands must be redacted");
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

test("P2: built-in writer preserves uniqueness suffix for two saves with the same 48-character scenarioId and redacts TOKEN=", (t) => {
  const { root, repo, agent, env } = tempDirs(t);
  const outWithSpaces = join(root, "harvested evals with spaces");
  const maxId = "a".repeat(48);

  const turn1: TurnHarvestSignals = {
    ...baseSignals,
    prompt: "--fix-flag turn one prompt",
    editedFiles: ["src/one.ts"],
    verifyCommands: ["TOKEN=synthetic-token-value-99999 npm test -- one"],
  };
  const turn2: TurnHarvestSignals = {
    ...baseSignals,
    prompt: "--fix-flag turn one prompt",
    editedFiles: ["src/two.ts"],
    verifyCommands: ["vitest run two.test.ts"],
  };

  const b1 = saveHarvestedEval({
    cwd: repo,
    scenarioId: maxId,
    signals: turn1,
    reason: "First failure",
    env,
    outDirOverride: outWithSpaces,
    preferCli: false,
  });
  const b2 = saveHarvestedEval({
    cwd: repo,
    scenarioId: maxId,
    signals: turn2,
    reason: "Second failure",
    env,
    outDirOverride: outWithSpaces,
    preferCli: false,
  });

  assert.equal(b1.saved, true);
  assert.equal(b2.saved, true);
  assert.equal(b1.via, "builtin");
  assert.equal(b2.via, "builtin");
  assert.ok(b1.path && b2.path && b1.path !== b2.path, "48-char IDs must still receive distinct paths");
  assert.ok(existsSync(b1.path) && existsSync(b2.path));
  assert.ok(b1.path.includes("harvested evals with spaces"));
  assert.equal(existsSync(repo), false, "must never create files inside project workspace");

  const yaml1 = readFileSync(b1.path, "utf8");
  const yaml2 = readFileSync(b2.path, "utf8");
  assert.ok(yaml1.includes(`id: "${maxId}"`));
  assert.ok(yaml1.includes("--fix-flag turn one prompt"));
  assert.ok(yaml1.includes("npm test -- one"));
  assert.ok(!yaml1.includes("synthetic-token-value-99999"), "TOKEN= must be redacted");
  assert.ok(yaml2.includes(`id: "${maxId}"`));
  assert.ok(yaml2.includes("vitest run two.test.ts"));
  assert.ok(!yaml2.includes("npm test -- one"));
  assert.ok(!redactHarvestText("https://alice:topsecret@example.com/api").includes("topsecret"));
  assert.ok(harvestOutputDir(repo, env).startsWith(agent));
});

test("P1/P2: Windows installed skill-harness.cmd shim resolves to Node entrypoint with shell:false and receives structured --turn-json stdin", (t) => {
  const { root, repo, env } = tempDirs(t);
  const binDir = join(root, "win bin dir");
  const pkgDir = join(binDir, "node_modules", "skill-harness");
  mkdirSync(pkgDir, { recursive: true });

  const entryJs = join(pkgDir, "bin.js");
  writeFileSync(
    entryJs,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (argv[0] !== "harvest" || flag("--turn-json") !== "-") process.exit(2);
const turn = JSON.parse(readFileSync(0, "utf8"));
const out = flag("--out");
const dir = join(out, turn.skillName, "tests");
mkdirSync(dir, { recursive: true });
const specPath = join(dir, "specification.yaml");
writeFileSync(specPath, JSON.stringify(turn), "utf8");
console.log(JSON.stringify({ skillName: turn.skillName, scenarioId: turn.scenarioId, specPath }));
`,
    "utf8",
  );
  // Realistic npm-generated Windows .cmd shim
  const shimPath = join(binDir, "skill-harness.cmd");
  writeFileSync(shimPath, `@ECHO off\r\n"%~dp0\\node_modules\\skill-harness\\bin.js" %*\r\n`, "utf8");

  // Verify resolution explicitly for win32 on any host OS
  const resolved = resolveHarnessCliCommand({ ...env, PATH: binDir }, "win32");
  assert.deepEqual(resolved, { cmd: process.execPath, argsPrefix: [entryJs] });

  // On Windows, exercise saveHarvestedEval WITHOUT cliCommand injection (uses PATH shim resolution directly!)
  if (process.platform === "win32") {
    const outSpaces = join(root, "out with spaces");
    const res = saveHarvestedEval({
      cwd: repo,
      scenarioId: "win-shim-test",
      signals: { ...baseSignals, prompt: "--leading-dash prompt with spaces & special chars" },
      env: { ...env, PATH: binDir },
      outDirOverride: outSpaces,
    });
    assert.equal(res.saved, true);
    assert.equal(res.via, "skill-harness-cli");
    assert.ok(res.path && existsSync(res.path));
    const received = JSON.parse(readFileSync(res.path, "utf8"));
    assert.equal(received.prompt, "--leading-dash prompt with spaces & special chars");
    assert.ok(!JSON.stringify(received).includes("synthetic-token-12345"));
  }
});
