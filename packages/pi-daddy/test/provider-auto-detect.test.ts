/** Unit tests for Bucket 2A: provider auto-detection, ordered tier fallback arrays, and --preset auto/session. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  parseModelSpec,
  readEcosystemConfig,
  resolveEcosystemModelCandidates,
  resolveEcosystemModelTier,
  saveEcosystemConfig,
  selectRegistryModel,
} from "../src/kernel/ecosystem-config.ts";
import { buildAutoPreset, detectConfiguredProviders } from "../src/products/provider-detect.ts";
import { runEcosystemSetup } from "../src/products/setup-doctor.ts";
import release from "../src/products/ecosystem-release.json" with { type: "json" };

function tempAgent(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-daddy-auto-provider-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("parseModelSpec handles both slash and colon-with-nested-slash model identifiers", () => {
  assert.deepEqual(parseModelSpec("fireworks/accounts/fireworks/models/glm-5p3-flash"), {
    provider: "fireworks",
    modelId: "accounts/fireworks/models/glm-5p3-flash",
  });
  assert.deepEqual(parseModelSpec("openrouter:google/gemini-3.5-flash"), {
    provider: "openrouter",
    modelId: "google/gemini-3.5-flash",
  });
  assert.equal(parseModelSpec("bare-model-id"), undefined);
});

test("modelFallbacks validate strictly and resolve in priority order across env, primary, and fallback chain", (t) => {
  const dir = tempAgent(t);
  const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: dir };

  saveEcosystemConfig(
    {
      models: { fast: "fireworks/glm-fast" },
      modelFallbacks: { fast: ["google/gemini-3.5-flash-lite", "session"] },
    },
    env,
  );
  assert.deepEqual(resolveEcosystemModelCandidates("fast", env), [
    "fireworks/glm-fast",
    "google/gemini-3.5-flash-lite",
    "session",
  ]);
  assert.equal(resolveEcosystemModelTier("fast", env), "fireworks/glm-fast");

  // Comma-separated env override takes precedence
  const envWithList: NodeJS.ProcessEnv = {
    ...env,
    PI_ECO_MODEL_FAST: "openrouter/z-ai/glm-5.3-flash, google/gemini-3.5-flash-lite",
  };
  assert.deepEqual(resolveEcosystemModelCandidates("fast", envWithList), [
    "openrouter/z-ai/glm-5.3-flash",
    "google/gemini-3.5-flash-lite",
    "fireworks/glm-fast",
    "session",
  ]);

  // selectRegistryModel picks first available model and honors "session" sentinel
  const googleModel = { provider: "google", id: "gemini-3.5-flash-lite" };
  const sessionModel = { provider: "anthropic", id: "claude-sonnet" };
  const registry = {
    find: (p: string, id: string) => (p === "google" && id === "gemini-3.5-flash-lite" ? googleModel : undefined),
  };
  assert.deepEqual(selectRegistryModel(registry, resolveEcosystemModelCandidates("fast", env), sessionModel), {
    model: googleModel,
    label: "google/gemini-3.5-flash-lite",
  });
  assert.deepEqual(
    selectRegistryModel(registry, ["missing/one", "session", "google/gemini-3.5-flash-lite"], sessionModel),
    { model: sessionModel, label: "anthropic/claude-sonnet" },
  );

  // selectRegistryModel skips catalogued primary lacking auth and picks authenticated fallback
  const unauthedFireworks = { provider: "fireworks", id: "glm-fast" };
  const authAwareRegistry = {
    find: (p: string, id: string) => {
      if (p === "fireworks" && id === "glm-fast") return unauthedFireworks;
      if (p === "google" && id === "gemini-3.5-flash-lite") return googleModel;
      return undefined;
    },
    hasConfiguredAuth: (model: unknown) => model === googleModel,
  };
  assert.deepEqual(selectRegistryModel(authAwareRegistry, resolveEcosystemModelCandidates("fast", env), sessionModel), {
    model: googleModel,
    label: "google/gemini-3.5-flash-lite",
  });
  // Also skips via getAvailable() when hasConfiguredAuth is absent
  const availableOnlyRegistry = {
    find: authAwareRegistry.find,
    getAvailable: () => [googleModel],
  };
  assert.deepEqual(
    selectRegistryModel(availableOnlyRegistry, ["fireworks/glm-fast", "google/gemini-3.5-flash-lite"], sessionModel),
    { model: googleModel, label: "google/gemini-3.5-flash-lite" },
  );

  // Malformed modelFallbacks fails closed
  writeFileSync(join(dir, "ecosystem.json"), JSON.stringify({ modelFallbacks: { fast: "not-an-array" } }));
  assert.throws(() => readEcosystemConfig(env), /Expected an array of non-empty strings for modelFallbacks\.fast/);
});

test("detectConfiguredProviders and buildAutoPreset detect auth.json and env providers without exposing secrets", (t) => {
  const dir = tempAgent(t);
  const empty = buildAutoPreset({ PI_CODING_AGENT_DIR: dir });
  assert.equal(empty.preset, "session");
  assert.deepEqual(empty.detected, []);
  assert.deepEqual(empty.fallbacks, {});

  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ "google-gemini-cli": { access: "secret-oauth-token" }, anthropic: { key: "sk-ant-secret" } }),
  );
  const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: dir, OPENROUTER_API_KEY: "sk-or-secret" };
  const detected = detectConfiguredProviders(env);
  assert.deepEqual(
    detected.map((d) => [d.label, d.source]),
    [
      ["openrouter", "env"],
      ["google", "auth.json"],
      ["anthropic", "auth.json"],
    ],
  );
  assert.ok(!JSON.stringify(detected).includes("secret"));

  const auto = buildAutoPreset(env);
  assert.equal(auto.preset, "openrouter");
  assert.deepEqual(auto.fallbacks.fast, ["google/gemini-3.5-flash-lite", "anthropic/claude-haiku-4-5", "session"]);
  assert.deepEqual(auto.fallbacks.strong, ["google/gemini-3.8-flash", "anthropic/claude-sonnet-4-5", "session"]);
});

test("pi-daddy setup --preset auto writes detected primary + fallback chain or session-only when none configured", (t) => {
  const dir = tempAgent(t);
  const savedEnv = { ...process.env };
  const nodeDesc = Object.getOwnPropertyDescriptor(process.versions, "node")!;
  Object.defineProperty(process.versions, "node", { ...nodeDesc, value: `${release.minimumRuntime.nodeMajor}.0.0` });
  t.after(() => {
    Object.defineProperty(process.versions, "node", nodeDesc);
    for (const k of [
      "PI_CODING_AGENT_DIR",
      "FIREWORKS_API_KEY",
      "OPENROUTER_API_KEY",
      "DEEPSEEK_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });
  for (const k of [
    "FIREWORKS_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ]) {
    delete process.env[k];
  }
  process.env.PI_CODING_AGENT_DIR = dir;
  t.mock.method(console, "log", () => {});

  // 0 providers -> session preset (empty models so Bookie/Scout use active session model cleanly)
  assert.equal(runEcosystemSetup({ preset: "auto", skipInstall: true }), 0);
  const sessionCfg = JSON.parse(readFileSync(join(dir, "ecosystem.json"), "utf8"));
  assert.equal(sessionCfg.setupPreset.name, "session");
  assert.deepEqual(sessionCfg.models, {});

  // Multi-provider env -> auto-selects top provider + populates fallbacks
  process.env.GEMINI_API_KEY = "test-gemini";
  process.env.ANTHROPIC_API_KEY = "test-anthropic";
  assert.equal(runEcosystemSetup({ preset: "auto", skipInstall: true }), 0);
  const autoCfg = JSON.parse(readFileSync(join(dir, "ecosystem.json"), "utf8"));
  assert.equal(autoCfg.setupPreset.name, "google");
  assert.equal(autoCfg.models.fast, "google/gemini-3.5-flash-lite");
  assert.deepEqual(autoCfg.modelFallbacks.fast, ["anthropic/claude-haiku-4-5", "session"]);
});

test("Issue #3: Codex-only OAuth auth.json selects openai-codex subscription model rather than metered openai API", (t) => {
  const dir = tempAgent(t);
  const savedEnv = { ...process.env };
  const nodeDesc = Object.getOwnPropertyDescriptor(process.versions, "node")!;
  Object.defineProperty(process.versions, "node", { ...nodeDesc, value: `${release.minimumRuntime.nodeMajor}.0.0` });
  const envKeys = [
    "PI_CODING_AGENT_DIR",
    "FIREWORKS_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ];
  t.after(() => {
    Object.defineProperty(process.versions, "node", nodeDesc);
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });
  for (const k of envKeys) delete process.env[k];
  process.env.PI_CODING_AGENT_DIR = dir;
  t.mock.method(console, "log", () => {});

  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-codex": { access: "synthetic-codex-oauth" } }));
  const detected = detectConfiguredProviders({ PI_CODING_AGENT_DIR: dir });
  assert.deepEqual(detected, [{ preset: "openai-codex", label: "openai-codex", source: "auth.json" }]);

  assert.equal(runEcosystemSetup({ preset: "auto", skipInstall: true }), 0);
  const cfg = JSON.parse(readFileSync(join(dir, "ecosystem.json"), "utf8"));
  assert.equal(cfg.setupPreset.name, "openai-codex");
  assert.equal(cfg.models.fast, "openai-codex/gpt-5.6-sol");
  assert.equal(cfg.models.work, "openai-codex/gpt-5.6-sol");
  assert.equal(cfg.models.strong, "openai-codex/gpt-5.6-sol");

  // Direct OPENAI_API_KEY stays distinct from openai-codex OAuth
  const apiDir = tempAgent(t);
  const apiDetected = detectConfiguredProviders({ PI_CODING_AGENT_DIR: apiDir, OPENAI_API_KEY: "synthetic-api-key" });
  assert.deepEqual(apiDetected, [{ preset: "openai", label: "openai", source: "env" }]);
});
