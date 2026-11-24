/**
 * Shared single-file ecosystem configuration (`~/.pi/agent/ecosystem.json`) and
 * side-panel auto-attach locator helpers (Layer 0: kernel).
 *
 * Explicit environment variables always take precedence over `ecosystem.json`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentDir, userStateDir } from "./project-paths.ts";

export interface EcosystemModelsConfig {
  fast?: string;
  work?: string;
  strong?: string;
}

export interface EcosystemConfig {
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

export function loadEcosystemConfig(env: NodeJS.ProcessEnv = process.env): EcosystemConfig {
  const file = ecosystemConfigPath(env);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as EcosystemConfig) : {};
  } catch {
    return {};
  }
}

export function saveEcosystemConfig(config: EcosystemConfig, env: NodeJS.ProcessEnv = process.env): string {
  const file = ecosystemConfigPath(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
