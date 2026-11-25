/**
 * Shared single-file ecosystem configuration (`~/.pi/agent/ecosystem.json`) and
 * side-panel auto-attach locator helpers (Layer 0: kernel).
 *
 * Explicit environment variables always take precedence over `ecosystem.json`.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentDir, userStateDir } from "./project-paths.ts";

export type EcosystemModelTier = "fast" | "work" | "strong";

export interface EcosystemModelsConfig {
  fast?: string;
  work?: string;
  strong?: string;
}

export interface EcosystemModelFallbacks {
  fast?: string[];
  work?: string[];
  strong?: string[];
}

export interface EcosystemHarvestConfig {
  mode?: "auto" | "suggest" | "off";
  minConfidence?: number;
}

export interface EcosystemConfig {
  setupPreset?: { name: string; defaults: EcosystemModelsConfig };
  models?: EcosystemModelsConfig;
  modelFallbacks?: EcosystemModelFallbacks;
  dashboard?: { autoStart?: boolean; autoSplit?: boolean };
  escalation?: { auto?: boolean };
  harvest?: EcosystemHarvestConfig;
  scout?: { directUrls?: boolean };
  bookie?: { autoRecall?: boolean; autoDistill?: boolean };
}

export interface PanelLocator {
  readonly url: string;
  readonly port: number;
  readonly pid: number;
  readonly cwd: string;
  readonly startedAt: string;
}

export function ecosystemConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "ecosystem.json");
}

/** Distinguish a fresh profile from unreadable settings before making any changes. */
export function readEcosystemConfig(env: NodeJS.ProcessEnv = process.env): EcosystemConfig | undefined {
  const file = ecosystemConfigPath(env);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && !lstatSync(file, { throwIfNoEntry: false }))
      return undefined;
    throw new Error(`Cannot read ecosystem config at ${file}.`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${file}. Correct the existing file before saving settings.`);
  }
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!record(parsed)) throw new Error(`Expected a JSON object in ${file}.`);
  for (const section of [
    "models",
    "modelFallbacks",
    "dashboard",
    "escalation",
    "harvest",
    "scout",
    "bookie",
    "setupPreset",
  ]) {
    if (section in parsed && !record(parsed[section])) throw new Error(`Expected an object for ${section} in ${file}.`);
  }
  if (record(parsed.harvest)) {
    const mode = parsed.harvest.mode;
    if (mode !== undefined && mode !== "auto" && mode !== "suggest" && mode !== "off") {
      throw new Error(`Expected harvest.mode to be "auto", "suggest", or "off" in ${file}.`);
    }
    const minC = parsed.harvest.minConfidence;
    if (minC !== undefined && (typeof minC !== "number" || !Number.isFinite(minC) || minC < 0 || minC > 1)) {
      throw new Error(`Expected harvest.minConfidence to be a number between 0 and 1 in ${file}.`);
    }
  }
  if (record(parsed.models)) {
    for (const tier of ["fast", "work", "strong"]) {
      if (tier in parsed.models && typeof parsed.models[tier] !== "string") {
        throw new Error(`Expected a string for models.${tier} in ${file}.`);
      }
    }
  }
  if (record(parsed.modelFallbacks)) {
    for (const tier of ["fast", "work", "strong"]) {
      if (!(tier in parsed.modelFallbacks)) continue;
      const list = parsed.modelFallbacks[tier];
      if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && item.trim().length > 0)) {
        throw new Error(`Expected an array of non-empty strings for modelFallbacks.${tier} in ${file}.`);
      }
    }
  }
  return parsed as EcosystemConfig;
}

export function loadEcosystemConfig(env: NodeJS.ProcessEnv = process.env): EcosystemConfig {
  try {
    return readEcosystemConfig(env) ?? {};
  } catch {
    return {};
  }
}

export function saveEcosystemConfig(config: EcosystemConfig, env: NodeJS.ProcessEnv = process.env): string {
  const file = ecosystemConfigPath(env);
  const target = readEcosystemConfig(env) === undefined ? file : realpathSync(file);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return file;
}

export function parseModelSpec(spec: string): { provider: string; modelId: string } | undefined {
  const trimmed = spec.trim();
  const idx = trimmed.search(/[/:]/);
  if (idx < 1) return undefined;
  const provider = trimmed.slice(0, idx).trim();
  const modelId = trimmed.slice(idx + 1).trim();
  return provider && modelId ? { provider, modelId } : undefined;
}

export function resolveEcosystemModelCandidates(
  tier: EcosystemModelTier,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const envKey = tier === "fast" ? "PI_ECO_MODEL_FAST" : tier === "work" ? "PI_ECO_MODEL_WORK" : "PI_ECO_MODEL_STRONG";
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string | undefined) => {
    const clean = raw?.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  const fromEnv = env[envKey]?.trim();
  if (fromEnv) {
    for (const part of fromEnv.split(",")) push(part);
  }
  const cfg = loadEcosystemConfig(env);
  push(cfg.models?.[tier]);
  for (const fb of cfg.modelFallbacks?.[tier] ?? []) push(fb);
  return out;
}

export function resolveEcosystemModelTier(
  tier: EcosystemModelTier,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveEcosystemModelCandidates(tier, env).find((entry) => entry !== "session");
}

export function selectRegistryModel(
  registry:
    | {
        find?(provider: string, modelId: string): unknown;
        hasConfiguredAuth?(model: unknown): boolean;
        getAvailable?(): ReadonlyArray<{ provider?: string; id?: string }>;
      }
    | undefined,
  candidates: readonly string[],
  fallback: unknown,
): { model: unknown; label: string } {
  const hasAuth = (model: unknown, provider: string, modelId: string): boolean => {
    if (typeof registry?.hasConfiguredAuth === "function") return Boolean(registry.hasConfiguredAuth(model));
    if (typeof registry?.getAvailable === "function") {
      return registry.getAvailable().some((m) => m?.provider === provider && m?.id === modelId);
    }
    return true;
  };
  for (const candidate of candidates) {
    if (candidate === "session") break;
    const parsed = parseModelSpec(candidate);
    if (!parsed || typeof registry?.find !== "function") continue;
    const found = registry.find(parsed.provider, parsed.modelId);
    if (found && hasAuth(found, parsed.provider, parsed.modelId)) return { model: found, label: candidate };
  }
  const fb = fallback as { provider?: string; id?: string } | undefined;
  return {
    model: fallback,
    label: fb?.provider && fb?.id ? `${fb.provider}/${fb.id}` : "session-default",
  };
}

export function panelLocatorPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const hash = createHash("sha256").update(resolve(cwd), "utf8").digest("hex").slice(0, 20);
  return join(userStateDir(env), "panels", `${hash}.json`);
}

export function harvestOutputDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const abs = resolve(cwd);
  const slug =
    abs
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "workspace";
  const hash = createHash("sha256").update(abs, "utf8").digest("hex").slice(0, 8);
  return join(userStateDir(env), "harvested-evals", `${slug}-${hash}`);
}

export function writePanelLocator(locator: PanelLocator, env: NodeJS.ProcessEnv = process.env): string {
  const file = panelLocatorPath(locator.cwd, env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(locator)}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}

export function readPanelLocator(cwd: string, env: NodeJS.ProcessEnv = process.env): PanelLocator | undefined {
  const file = panelLocatorPath(cwd, env);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PanelLocator>;
    if (typeof parsed?.url !== "string" || typeof parsed?.pid !== "number") return undefined;
    try {
      process.kill(parsed.pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") return undefined;
    }
    return parsed as PanelLocator;
  } catch {
    return undefined;
  }
}

export function removePanelLocator(cwd: string, pid: number, env: NodeJS.ProcessEnv = process.env): void {
  const file = panelLocatorPath(cwd, env);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: number };
    if (parsed?.pid === pid) unlinkSync(file);
  } catch {
    /* Already removed or replaced by a newer session. */
  }
}
