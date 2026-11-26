/** Model tier preferences and availability as reported by Pi's local model catalog. */
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentDir } from "../kernel/project-paths.ts";
import type { EcosystemConfig, EcosystemModelFallbacks, EcosystemModelsConfig } from "../kernel/ecosystem-config.ts";

export type ProviderPresetName =
  "open-weight" | "google" | "openrouter" | "deepseek" | "anthropic" | "openai-codex" | "openai" | "session";

const COMMON_DEFAULTS = {
  dashboard: { autoStart: true, autoSplit: true },
  escalation: { auto: true },
  harvest: { mode: "auto" as const, minConfidence: 0.75 },
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
  "openai-codex": {
    models: {
      fast: "openai-codex/gpt-5.6-sol",
      work: "openai-codex/gpt-6.2-sol",
      strong: "openai-codex/gpt-6.2-sol",
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

const providerOrder = [
  "open-weight",
  "openrouter",
  "deepseek",
  "google",
  "anthropic",
  "openai-codex",
  "openai",
] as const;
const tiers = ["fast", "work", "strong"] as const;
export interface ProviderCatalog {
  providers: Record<string, { configured: boolean; source?: string }>;
  models: Record<string, string[]>;
}

/** Run the probe inside the user's Pi so npm-managed and standalone installs use the same registry as /login. */
export function loadProviderCatalog(extraModels: string[] = []): ProviderCatalog {
  const specs = [
    ...new Set([...Object.values(PROVIDER_PRESETS).flatMap((preset) => Object.values(preset.models)), ...extraModels]),
  ];
  const result = spawnSync(
    "pi",
    [
      "--offline",
      "--mode",
      "rpc",
      "--no-session",
      "--no-approve",
      "--no-extensions",
      "-e",
      "./provider-catalog-probe.ts",
    ],
    {
      cwd: fileURLToPath(new URL("../../src/products/", import.meta.url)),
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: resolve(agentDir(process.env)),
        PI_DADDY_CATALOG_REQUEST: JSON.stringify(specs),
      },
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const prefix = "PI_DADDY_CATALOG ";
  // Pi RPC can redirect extension output to stderr. Consume only our metadata record.
  const output = [result.stdout, result.stderr].join("\n");
  const line = output.split(/\r?\n/).find((row) => row.startsWith(prefix));
  if (result.status !== 0 || !line)
    throw new Error("Could not read Pi's provider catalog. Check `pi --version` and `/login`.");
  try {
    const catalog = JSON.parse(line.slice(prefix.length));
    if (catalog?.providers && catalog?.models) return catalog;
  } catch {
    // Raw diagnostic streams can include unrelated local output.
  }
  throw new Error("Pi returned an unreadable provider catalog.");
}

export function buildAutoPreset(catalog: ProviderCatalog) {
  const detected: { preset: ProviderPresetName; label: string; source: string; models: EcosystemModelsConfig }[] = [];
  const diagnostics: string[] = [];
  for (const preset of providerOrder) {
    const provider = preset === "open-weight" ? "fireworks" : preset;
    const status = catalog.providers[provider];
    if (!status) continue;
    if (!status.configured) {
      if (status.source === "stored")
        diagnostics.push(provider + ": stored credential did not resolve to available chat models");
      continue;
    }
    const preferred = PROVIDER_PRESETS[preset].models;
    const models: EcosystemModelsConfig = {};
    for (const tier of tiers) {
      const options = [preferred[tier], ...Object.values(preferred)];
      for (const spec of options) {
        if (!spec) continue;
        const efforts = catalog.models[spec] ?? [];
        if (!efforts.length || (tier === "fast" && !efforts.includes("off"))) continue;
        models[tier] = spec;
        break;
      }
      if (!models[tier])
        diagnostics.push(
          provider + ": no available preset model for " + tier + (tier === "fast" ? " with thinking off" : ""),
        );
    }
    if (Object.keys(models).length) detected.push({ preset, label: provider, source: status.source ?? "Pi", models });
  }
  const primary = detected[0];
  const fallbacks: EcosystemModelFallbacks = {};
  const models: EcosystemModelsConfig = {};
  for (const tier of tiers) {
    const candidates = [...new Set(detected.flatMap((entry) => (entry.models[tier] ? [entry.models[tier]!] : [])))];
    const first = candidates.shift();
    if (first) models[tier] = first;
    if (primary) fallbacks[tier] = [...candidates, "session"];
  }
  return { preset: primary?.preset ?? "session", models, detected, fallbacks, diagnostics };
}
