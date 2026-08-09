/**
 * Live capability catalog — what *can* be granted, enumerated at runtime.
 *
 * Until now grants were checked against agent-type files alone, which covers `tool:` capabilities and
 * nothing else. That leaves two gaps: extension tools are invisible (so `ext:` grants cannot be
 * validated), and **skills were ungovernable** despite "skills and tools" being half the requirement.
 *
 * Sources, and why each is trusted:
 *  - **tools** — the `tools` array of a live provider request. Authoritative: it is exactly what pi sent
 *    the model, so it includes extension-registered tools and reflects any `--tools` allowlist already in
 *    force. Nothing else can see the real surface.
 *  - **skills** — `SKILL.md` directories and top-level `.md` files under pi's skill roots.
 *  - **agent types** — the same `.md` definitions the interceptor already reads.
 *
 * Provenance note: a provider payload gives tool NAMES, not owning packages, so extension tools cannot be
 * qualified as `ext:<pkg>/<tool>` from that source alone. They are catalogued as `tool:<name>` — which is
 * also how pi's `--tools` matches — and marked `kind: "extension"` for display. `ext:` ids remain
 * supported for hand-authored grants; `deriveOwnGrant` already matches them by bare name.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAgentTypes, PI_BUILTIN_TOOLS, type AgentType } from "./agent-types.ts";
import type { Capability } from "./resolve.ts";

export type CapabilityKind = "builtin" | "extension" | "skill" | "agentType";

export interface CatalogEntry {
  capability: Capability;
  kind: CapabilityKind;
  /** Where it was found, for display and debugging. */
  source?: string;
}

export interface Catalog {
  entries: CatalogEntry[];
  /** Every capability id in the catalog. */
  all: Capability[];
  byKind(kind: CapabilityKind): Capability[];
  has(capability: Capability): boolean;
}

/** Split observed tool names into pi built-ins and extension-provided tools. */
export function classifyToolNames(observed: string[]): CatalogEntry[] {
  const builtins = new Set<string>(PI_BUILTIN_TOOLS);
  return [...new Set(observed)].sort().map((name) => ({
    capability: `tool:${name}`,
    kind: builtins.has(name) ? ("builtin" as const) : ("extension" as const),
  }));
}

/** Skill roots pi discovers, project first. */
export function skillDirs(cwd: string): string[] {
  return [join(cwd, ".pi", "skills"), join(homedir(), ".pi", "agent", "skills")];
}

/**
 * Discover skills: a directory containing `SKILL.md` is one skill named after the directory; a top-level
 * `.md` file is a skill named after the file. Mirrors pi's documented convention.
 *
 * Directories are not descended into beyond one level, matching pi's rule that a directory containing
 * `SKILL.md` is a single skill rather than a tree to explore.
 */
export async function loadSkills(cwd: string): Promise<CatalogEntry[]> {
  const found = new Map<string, CatalogEntry>();
  for (const dir of skillDirs(cwd)) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue; // absent skill root is normal
    }
    for (const name of names.sort()) {
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (info.isDirectory()) {
          const inner = await readdir(path).catch(() => [] as string[]);
          if (inner.includes("SKILL.md") && !found.has(name)) {
            found.set(name, { capability: `skill:${name}`, kind: "skill", source: path });
          }
        } else if (name.endsWith(".md")) {
          const skill = name.replace(/\.md$/, "");
          if (!found.has(skill)) {
            found.set(skill, { capability: `skill:${skill}`, kind: "skill", source: path });
          }
        }
      } catch {
        // An unreadable entry is simply not catalogued; it therefore cannot be granted, which is the
        // fail-closed direction.
      }
    }
  }
  return [...found.values()];
}

export function agentTypeEntries(types: Map<string, AgentType>): CatalogEntry[] {
  return [...types.values()].map((t) => ({
    capability: `agent:${t.name}`,
    kind: "agentType" as const,
    source: t.source,
  }));
}

/** Assemble a catalog from parts. Pure, so it is testable without a filesystem. */
export function makeCatalog(entries: CatalogEntry[]): Catalog {
  const deduped = new Map<Capability, CatalogEntry>();
  for (const entry of entries) if (!deduped.has(entry.capability)) deduped.set(entry.capability, entry);
  const list = [...deduped.values()].sort((a, b) => a.capability.localeCompare(b.capability));
  const ids = list.map((e) => e.capability);
  const idSet = new Set(ids);
  return {
    entries: list,
    all: ids,
    byKind: (kind) => list.filter((e) => e.kind === kind).map((e) => e.capability),
    has: (capability) => idSet.has(capability),
  };
}

/** Build the live catalog. `observedTools` comes from a provider payload; null when not yet seen. */
export async function buildCatalog(input: {
  cwd: string;
  observedTools: string[] | null;
}): Promise<Catalog> {
  const [skills, types] = await Promise.all([loadSkills(input.cwd), loadAgentTypes(input.cwd)]);
  return makeCatalog([
    ...(input.observedTools ? classifyToolNames(input.observedTools) : []),
    ...skills,
    ...agentTypeEntries(types),
  ]);
}

/**
 * Capabilities requested that the catalog does not contain.
 *
 * Reported separately from `denied` because the causes differ and so do the fixes: `denied` means the
 * delegator lacks authority, `unknown` means the capability does not exist here — usually a typo or a
 * stale grant referring to an uninstalled package. Silently treating unknown as denied hides that.
 */
export function unknownCapabilities(requested: Capability[], catalog: Catalog): Capability[] {
  return requested.filter((c) => !catalog.has(c)).sort();
}
