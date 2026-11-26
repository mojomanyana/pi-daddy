/** Unit tests for Bucket 2A: provider auto-detection, ordered tier fallback arrays, and --preset auto/session. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { buildAutoPreset, type ProviderCatalog } from "../src/products/provider-detect.ts";

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

test("automatic tiers exclude unresolved credentials, unavailable models and unsupported thinking levels", () => {
  const catalog: ProviderCatalog = {
    providers: {
      anthropic: { configured: false, source: "stored" },
      google: { configured: true, source: "environment" },
      "openai-codex": { configured: true, source: "stored" },
    },
    models: {
      "google/gemini-3.5-flash-lite": ["off", "low"],
      "openai-codex/gpt-6.2-sol": ["low", "high"],
    },
  };
  const plan = buildAutoPreset(catalog);
  assert.equal(plan.preset, "google");
  assert.deepEqual(plan.fallbacks.fast, ["session"]);
  assert.deepEqual(plan.fallbacks.work, ["openai-codex/gpt-6.2-sol", "session"]);
  assert.equal(plan.models.strong, "google/gemini-3.5-flash-lite");
  assert.ok(plan.diagnostics.some((reason) => reason.includes("anthropic: stored credential")));
  assert.ok(plan.diagnostics.some((reason) => reason.includes("openai-codex") && reason.includes("thinking off")));
  const codex = buildAutoPreset({ ...catalog, providers: { "openai-codex": catalog.providers["openai-codex"] } });
  assert.equal(codex.preset, "openai-codex");
  assert.equal(codex.models.fast, undefined);
  assert.equal(codex.models.work, "openai-codex/gpt-6.2-sol");
  assert.deepEqual(buildAutoPreset({ providers: {}, models: {} }).models, {});
});
