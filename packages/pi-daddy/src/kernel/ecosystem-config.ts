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

export interface EcosystemModelsConfig {
  fast?: string;
  work?: string;
  strong?: string;
}

export interface EcosystemConfig {
  setupPreset?: { name: string; defaults: EcosystemModelsConfig };
  models?: EcosystemModelsConfig;
  dashboard?: { autoStart?: boolean; autoSplit?: boolean };
  escalation?: { auto?: boolean };
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
  for (const section of ["models", "dashboard", "escalation", "scout", "bookie", "setupPreset"]) {
    if (section in parsed && !record(parsed[section])) throw new Error(`Expected an object for ${section} in ${file}.`);
  }
  if (record(parsed.models)) {
    for (const tier of ["fast", "work", "strong"]) {
      if (tier in parsed.models && typeof parsed.models[tier] !== "string") {
        throw new Error(`Expected a string for models.${tier} in ${file}.`);
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

export function resolveEcosystemModelTier(
  tier: "fast" | "work" | "strong",
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const envKey = tier === "fast" ? "PI_ECO_MODEL_FAST" : tier === "work" ? "PI_ECO_MODEL_WORK" : "PI_ECO_MODEL_STRONG";
  const fromEnv = env[envKey]?.trim();
  if (fromEnv) return fromEnv;
  const cfg = loadEcosystemConfig(env);
  const fromFile = cfg.models?.[tier]?.trim();
  return fromFile || undefined;
}

export function panelLocatorPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const hash = createHash("sha256").update(resolve(cwd), "utf8").digest("hex").slice(0, 20);
  return join(userStateDir(env), "panels", `${hash}.json`);
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
