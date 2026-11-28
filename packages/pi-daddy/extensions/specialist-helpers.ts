/**
 * Specialist child-runtime helpers: ecosystem role model overrides, trusted verification & opt-in
 * child extensions, and attached Scout brief reference extraction.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SkillDefinition } from "../src/kernel/definitions.ts";
import {
  loadEcosystemConfig,
  resolveEcosystemModelCandidates,
  selectRegistryModel,
} from "../src/kernel/ecosystem-config.ts";
import { isUnderPiProjectDir } from "../src/kernel/project-paths.ts";
import type { GrantsSession } from "./session.ts";

const SHA256_RE = /^[a-f0-9]{64}$/;

/** Resolve an ecosystem.json per-role model or role tier override when explicit/session/project settings omit one. */
export function resolveEcosystemRoleModel(
  role: string | undefined,
  registry: { find?(p: string, id: string): unknown; hasConfiguredAuth?(m: unknown): boolean } | undefined,
  fallback: unknown,
): string | undefined {
  if (!role) return undefined;
  const cfg = loadEcosystemConfig();
  const direct = cfg.delegation?.roleModels?.[role]?.trim();
  if (direct && direct !== "session") return direct.replace(/^([^/:\s]+):(.+)$/, "$1/$2");
  const tier = cfg.delegation?.roleTiers?.[role];
  if (!tier) return undefined;
  const candidates = resolveEcosystemModelCandidates(tier);
  if (!candidates.length) return undefined;
  const picked = selectRegistryModel(registry, candidates, fallback);
  return picked.label !== "session-default" ? picked.label : undefined;
}

/** Resolve trusted verification extension (Principal verify-before-settle) and remembered opt-in child extensions. */
export function resolveChildExtensionsFor(session: GrantsSession, definition: SkillDefinition | undefined): string[] {
  if (!session.projectTrusted || !definition) return [];
  const out: string[] = [];
  const add = (p: string) => {
    const abs = resolve(p);
    if (existsSync(abs) && !out.includes(abs)) out.push(abs);
  };
  if (
    definition.metadata?.["principal-verify"] === "true" &&
    definition.selectedResources?.package?.name === "principal-pi-skills" &&
    definition.selectedResources.package.root
  ) {
    add(join(definition.selectedResources.package.root, "extensions", "verify-before-settle.ts"));
  }
  const cfg = loadEcosystemConfig();
  const byWorkspace = cfg.delegation?.childExtensions?.[session.cwd];
  const optedIn = byWorkspace?.[definition.name];
  if (Array.isArray(optedIn)) {
    for (const entry of optedIn) {
      if (typeof entry === "string" && entry.trim()) add(entry.trim());
    }
  }
  return out;
}

/** Extract attached Scout brief SHA-256 hashes from explicit `attachedBriefs` or embedded brief JSON references. */
export function extractAttachedBriefSha256(input: {
  attachedBriefs?: readonly string[];
  task?: string;
  context?: unknown;
}): string[] {
  const found = new Set<string>();
  for (const h of input.attachedBriefs ?? []) {
    if (typeof h === "string" && SHA256_RE.test(h)) found.add(h);
  }
  const scan = (text: string) => {
    if (!text.includes("research-brief")) return;
    for (const match of text.matchAll(/"sha256"\s*:\s*"([a-f0-9]{64})"/g)) {
      if (match[1]) found.add(match[1]);
    }
  };
  if (typeof input.task === "string") scan(input.task);
  if (input.context && typeof input.context === "object") {
    try {
      scan(JSON.stringify(input.context));
    } catch {
      /* Ignore unserializable context. */
    }
  }
  return [...found];
}

export interface PartialEditRecovery {
  readonly state: "retried" | "resumed" | "needs-decision";
  readonly label: "retried" | "resumed" | "needs your decision";
  readonly partialFilesModified: readonly string[];
  readonly guidance: string;
}

/** Snapshot file hashes of dirty/untracked entries under `cwd` so an interrupted mutating child's edits can be detected. */
export function snapshotWorkspaceDirtyState(cwd: string): Map<string, string> | undefined {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "-uall", "--", "."], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const map = new Map<string, string>();
    for (const line of out.split(/\r?\n/)) {
      if (line.length < 4) continue;
      const rel = line.slice(3).trim().replace(/^"|"$/g, "");
      if (!rel || isUnderPiProjectDir(rel)) continue;
      const abs = resolve(cwd, rel);
      try {
        const digest = createHash("sha256").update(readFileSync(abs)).digest("hex");
        map.set(rel, `${line.slice(0, 2)}:${digest}`);
      } catch {
        map.set(rel, `${line.slice(0, 2)}:deleted`);
      }
    }
    return map;
  } catch {
    return undefined;
  }
}

/** Determine whether a failed mutating specialist left partial edits and surface explicit resume/decision guidance. */
export function assessPartialEditRecovery(
  cwd: string,
  before: ReadonlyMap<string, string> | undefined,
  outcome: { ok: boolean; retry?: unknown; cleanup?: { state?: string }; granted: readonly string[] },
): PartialEditRecovery | undefined {
  if (outcome.retry) {
    return {
      state: "retried",
      label: "retried",
      partialFilesModified: [],
      guidance: "Replay-safe specialist failed without answering and was automatically retried once.",
    };
  }
  if (outcome.ok || !before) return undefined;
  const after = snapshotWorkspaceDirtyState(cwd);
  if (!after) return undefined;
  const modified: string[] = [];
  for (const [rel, stamp] of after) {
    if (before.get(rel) !== stamp) modified.push(rel);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) modified.push(rel);
  }
  modified.sort();
  if (modified.length > 0) {
    return {
      state: "needs-decision",
      label: "needs your decision",
      partialFilesModified: modified,
      guidance:
        `Specialist disconnected after modifying ${modified.join(", ")}. Do not replay blindly; inspect the completed ` +
        "changes and resume from the first identifiable unfinished step, or ask the operator before repeating an uncertain action.",
    };
  }
  return undefined;
}
