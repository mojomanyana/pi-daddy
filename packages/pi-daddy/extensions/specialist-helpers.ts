/**
 * Specialist child-runtime helpers: ecosystem role model overrides, trusted verification & opt-in
 * child extensions, and attached Scout brief reference extraction.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SkillDefinition } from "../src/kernel/definitions.ts";
import {
  loadEcosystemConfig,
  resolveEcosystemModelCandidates,
  selectRegistryModel,
} from "../src/kernel/ecosystem-config.ts";
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
