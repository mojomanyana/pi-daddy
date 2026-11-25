/**
 * Provider auto-detection and tier preset builder for `pi-daddy setup` and `pi-daddy doctor`
 * (Layer 3: products). Reads only provider key names from `~/.pi/agent/auth.json` and env var
 * presence — never logs, copies, or returns secret values.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../kernel/project-paths.ts";
import type { EcosystemConfig, EcosystemModelFallbacks, EcosystemModelsConfig } from "../kernel/ecosystem-config.ts";

export type ProviderPresetName =
  "open-weight" | "google" | "openrouter" | "deepseek" | "anthropic" | "openai" | "session";

const COMMON_DEFAULTS = {
  dashboard: { autoStart: true, autoSplit: true },
  escalation: { auto: true },
  scout: { directUrls: true },
  bookie: { autoRecall: true, autoDistill: true },
} as const;

export const PROVIDER_PRESETS: Record<ProviderPresetName, EcosystemConfig & { models: EcosystemModelsConfig }> = {
  "open-weight": {
    models: {
      fast: "fireworks/accounts/fireworks/models/glm-5p3-flash",
      work: "fireworks/accounts/fireworks/models/deepseek-v4p1-flash",
      strong: "fireworks/accounts/fireworks/models/qwen3p8-max",
    },
    ...COMMON_DEFAULTS,
  },
  google: {
    models: {
      fast: "google/gemini-3.5-flash-lite",
      work: "google/gemini-3.5-flash-lite",
      strong: "google/gemini-3.8-flash",
    },
    ...COMMON_DEFAULTS,
  },
  openrouter: {
    models: {
      fast: "openrouter/z-ai/glm-5.3-flash",
      work: "openrouter/deepseek/deepseek-v4.1-flash",
      strong: "openrouter/qwen/qwen3.8-max",
    },
    ...COMMON_DEFAULTS,
  },
  deepseek: {
    models: {
      fast: "deepseek/deepseek-chat",
      work: "deepseek/deepseek-chat",
      strong: "deepseek/deepseek-reasoner",
    },
    ...COMMON_DEFAULTS,
  },
  anthropic: {
    models: {
      fast: "anthropic/claude-haiku-4-5",
      work: "anthropic/claude-sonnet-4-5",
      strong: "anthropic/claude-sonnet-4-5",
    },
    ...COMMON_DEFAULTS,
  },
  openai: {
    models: {
      fast: "openai/gpt-4.1-mini",
      work: "openai/gpt-4.1",
      strong: "openai/o4-mini",
    },
    ...COMMON_DEFAULTS,
  },
  session: {
    models: {},
    ...COMMON_DEFAULTS,
  },
};

const PROVIDER_PROBES: ReadonlyArray<{
  preset: Exclude<ProviderPresetName, "session">;
  label: string;
  envKeys: readonly string[];
  authKeys: readonly string[];
}> = [
  { preset: "open-weight", label: "fireworks", envKeys: ["FIREWORKS_API_KEY"], authKeys: ["fireworks"] },
  {
    preset: "openrouter",
    label: "openrouter",
    envKeys: ["OPENROUTER_API_KEY"],
    authKeys: ["openrouter"],
  },
  { preset: "deepseek", label: "deepseek", envKeys: ["DEEPSEEK_API_KEY"], authKeys: ["deepseek"] },
  {
    preset: "google",
    label: "google",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    authKeys: ["google", "google-gemini-cli", "gemini"],
  },
  { preset: "anthropic", label: "anthropic", envKeys: ["ANTHROPIC_API_KEY"], authKeys: ["anthropic"] },
  {
    preset: "openai",
    label: "openai",
    envKeys: ["OPENAI_API_KEY"],
    authKeys: ["openai", "openai-codex"],
  },
];

function readAuthProviderKeys(env: NodeJS.ProcessEnv): Set<string> {
  const keys = new Set<string>();
  const file = join(agentDir(env), "auth.json");
  if (!existsSync(file)) return keys;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return keys;
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== null && value !== undefined && value !== "") keys.add(key.toLowerCase());
    }
  } catch {
    /* Treat unreadable auth.json as no detected providers. */
  }
  return keys;
}

export interface DetectedProvider {
  readonly preset: Exclude<ProviderPresetName, "session">;
  readonly label: string;
  readonly source: "env" | "auth.json";
}

export function detectConfiguredProviders(env: NodeJS.ProcessEnv = process.env): DetectedProvider[] {
  const authKeys = readAuthProviderKeys(env);
  const found: DetectedProvider[] = [];
  for (const probe of PROVIDER_PROBES) {
    if (probe.envKeys.some((k) => Boolean(env[k]?.trim()))) {
      found.push({ preset: probe.preset, label: probe.label, source: "env" });
    } else if (probe.authKeys.some((k) => authKeys.has(k))) {
      found.push({ preset: probe.preset, label: probe.label, source: "auth.json" });
    }
  }
  return found;
}

export function buildAutoPreset(env: NodeJS.ProcessEnv = process.env): {
  preset: ProviderPresetName;
  detected: DetectedProvider[];
  fallbacks: EcosystemModelFallbacks;
} {
  const detected = detectConfiguredProviders(env);
  if (detected.length === 0) {
    return { preset: "session", detected, fallbacks: {} };
  }
  const [primary, ...secondary] = detected;
  const fallbacks: EcosystemModelFallbacks = {};
  for (const tier of ["fast", "work", "strong"] as const) {
    const chain = secondary
      .map((item) => PROVIDER_PRESETS[item.preset].models[tier])
      .filter((m): m is string => Boolean(m));
    chain.push("session");
    fallbacks[tier] = [...new Set(chain)];
  }
  return { preset: primary.preset, detected, fallbacks };
}
