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
 *  - **definitions** — spawnable `SKILL.md` agents (ADR-0016), as `agent:<name>`.
 *
 * Provenance note: a provider payload gives tool NAMES, not owning packages, so extension tools cannot be
 * qualified as `ext:<pkg>/<tool>` from that source alone. They are catalogued as `tool:<name>` — which is
 * also how pi's `--tools` matches — and marked `kind: "extension"` for display. `ext:` ids remain
 * supported for hand-authored grants; `deriveOwnGrant` already matches them by bare name.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadDefinitions, type SkillDefinition } from "./definitions.ts";
import { PI_BUILTIN_TOOLS, WILDCARD } from "./pi-tools.ts";
import { AGENT_WILDCARD, WORKSPACE_WILDCARD, type Capability } from "./resolve.ts";
import { loadWorkspaceRegistry, type WorkspaceRegistryFile } from "./workspace.ts";
import { isSafeCapability } from "./capabilities.ts";

export type CapabilityKind = "builtin" | "extension" | "skill" | "agentType" | "workspace";

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

/**
 * Spawnable definitions, as `agent:<name>` capabilities.
 *
 * A definition is BOTH a skill (loadable into a session) and an agent (spawnable as a child) — ADR-0016
 * collapsed those into one file — so the same `SKILL.md` legitimately appears twice in the catalog under
 * two capability ids. That is not duplication: `skill:review` means "may load these instructions" and
 * `agent:review` means "may spawn a child running them", and a grant can hold either without the other.
 */
export function definitionEntries(definitions: Map<string, SkillDefinition>): CatalogEntry[] {
  return [...definitions.values()].map((d) => ({
    capability: `agent:${d.name}`,
    kind: "agentType" as const,
    source: d.source,
  }));
}

/**
 * Registered workspaces, as `workspace:<id>` capabilities (ADR-0035).
 *
 * For DISPLAY and SCAFFOLDING only — `/grants` listing what this session may route to, and `init` offering
 * the ids without choosing among them (ADR-0028). It is deliberately **not** what `unknownCapabilities`
 * checks against; see the comment there.
 *
 * The operator registry is the authority on which ids exist, exactly as it is at `resolveWorkspace`. This
 * enumerates it; it does not decide anything.
 */
export function workspaceEntries(registry: WorkspaceRegistryFile, source?: string): CatalogEntry[] {
  return Object.keys(registry.workspaces)
    .sort()
    .map((id) => ({ capability: `workspace:${id}` as Capability, kind: "workspace" as const, ...(source ? { source } : {}) }));
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
  /** Operator workspace registry (`PI_GRANTS_WORKSPACE_REGISTRY`). Absent or unreadable yields no entries. */
  registryPath?: string;
}): Promise<Catalog> {
  const [skills, definitions, workspaces] = await Promise.all([
    loadSkills(input.cwd),
    loadDefinitions(input.cwd),
    // Fails SOFT, and only because nothing here is an authority. A malformed registry must not stop a
    // session from starting — `loadWorkspaceRegistry` throws a GovernanceRefusal naming the file, and that
    // refusal is the operator's signal at the point of USE, where routing actually depends on it. Swallowing
    // it there would be unsafe; swallowing it here costs a display list.
    input.registryPath
      ? loadWorkspaceRegistry(input.registryPath).then(
          (r) => workspaceEntries(r, input.registryPath),
          () => [] as CatalogEntry[],
        )
      : Promise.resolve([] as CatalogEntry[]),
  ]);
  return makeCatalog([
    // pi's built-ins are seeded unconditionally, because they are known statically and the catalog is
    // consulted BEFORE any provider request has happened — `/grants` runs at that point. Without this,
    // every capability looked "unknown" until the first model call, so the preview refused grants that
    // enforcement would have allowed: R-28's failure shape (a diagnostic disagreeing with the enforcer)
    // reappearing through a different door.
    //
    // The trade-off, stated plainly: in a session started with `--tools read`, this still lists `bash`
    // as an existing capability, so a delegation naming it passes the *unknown* check and is refused by
    // the *grant* check instead ("this session does not hold it"). That is the better error anyway, and
    // the grant check — not this catalog — is the authority. Nothing here grants anything.
    ...PI_BUILTIN_TOOLS.map((name) => ({ capability: `tool:${name}` as const, kind: "builtin" as const })),
    ...(input.observedTools ? classifyToolNames(input.observedTools) : []),
    ...skills,
    ...definitionEntries(definitions),
    ...workspaces,
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
  // Wildcards are GRAMMAR, not entries. Nothing enumerates them into the catalog — `definitionEntries`
  // emits `agent:<name>` per discovered definition and `PI_BUILTIN_TOOLS` contains no `*` — so this check
  // reported `agent:*` as *"not present in this session's catalog (typo, or an uninstalled package?)"* and
  // refused it BEFORE `resolve` could apply ADR-0023's rule. That made the ADR's "a parent holding
  // `agent:*` may hand down `agent:*`" false, and made a definition declaring `allowed-tools: agent:*`
  // unspawnable from any grant. The wildcard is live only at the root without this.
  //
  // `workspace:` is exempt as a NAMESPACE, not merely at its wildcard, and that asymmetry is deliberate.
  // ADR-0035 minted the namespace and taught `normaliseCapability`, `resolve` and `childEnv` about it, but
  // not this line — so with a catalog present (and `delegationContext` always supplies one) every requested
  // `workspace:<id>` was refused UNKNOWN_TOOL as *"a typo, or an uninstalled package"*. A child could
  // therefore never be granted a workspace capability at all, which made routing stop dead below the root
  // instead of attenuating, and made the ADR's own "two authorities, not one" unreachable in production.
  //
  // Exempt rather than catalogued-and-checked because the operator registry is the authority and it is
  // consulted where it matters: `resolveWorkspace` refuses an unregistered id with WORKSPACE_NOT_REGISTERED,
  // naming the registry. A second, weaker check here can only turn that precise refusal into a misleading
  // one — and it would do so for reasons that have nothing to do with the id, like a registry this session
  // cannot read. `buildCatalog` still ENUMERATES workspaces, for `/grants` and for `init`'s scaffold; that
  // is display, and display is not authority. Same trade-off the built-ins comment above states and accepts.
  // The workspace exemption requires a WELL-FORMED id, not merely the prefix. A bare `workspace:` names
  // nothing, and exempting it let it reach a child's grant and the ledger as authority over no workspace at
  // all — an exemption for ids the registry is authoritative about should not also cover ids no registry
  // could contain.
  // `WORKSPACE_WILDCARD` is listed with the other two because it is GRAMMAR, and `isSafeCapability` refuses
  // wildcards by design — so folding it into the namespace test below un-exempts it. Caught by the tests for
  // the previous two fixes, which is the checklist paying for itself.
  const exempt = (c: Capability) =>
    c === WILDCARD || c === AGENT_WILDCARD || c === WORKSPACE_WILDCARD
    || (c.startsWith("workspace:") && isSafeCapability(c));
  return requested.filter((c) => !exempt(c) && !catalog.has(c)).sort();
}

/**
 * Tool names that exist in OTHER harnesses' vocabularies, mapped to the pi tool that does the same job.
 *
 * This is a hint for an error message and nothing else. `ceilingForDefinition` deliberately refuses to
 * translate names — lowercasing and no more — because a translation table there would have to decide what
 * `Glob` *means* and would either invent a grant or silently drop one. Naming a likely intent in the
 * refusal costs nothing and keeps that property: the delegation is still refused, and the author still
 * edits the file.
 *
 * Populated from the names an author actually reaches for. `allowed-tools` is an Agent Skills field, so
 * the frontmatter people copy in is usually written against Claude Code's toolset; `Glob` is the one that
 * bit a real consumer (principal-pi-skills, seven definitions), because pi's equivalent is `find`.
 */
const FOREIGN_TOOL_NAMES: Readonly<Record<string, string>> = {
  "tool:glob": "tool:find",
  "tool:searchfiles": "tool:find",
  "tool:bashtool": "tool:bash",
  "tool:readfile": "tool:read",
  "tool:writefile": "tool:write",
  "tool:str_replace_editor": "tool:edit",
  "tool:multiedit": "tool:edit",
};

/**
 * Optimal string alignment distance — Levenshtein plus adjacent transposition.
 *
 * Transposition counts as ONE edit, not two, because it is the typo people actually make: `raed` for
 * `read` is a single slip of the fingers, and plain Levenshtein scores it 2 — the same as two unrelated
 * substitutions. With the threshold this small, that difference is the whole feature.
 */
function editDistance(a: string, b: string): number {
  // Three rows, because a transposition needs the row before last.
  const rows: number[][] = [
    Array.from({ length: b.length + 1 }, (_, j) => j),
    new Array<number>(b.length + 1).fill(0),
    new Array<number>(b.length + 1).fill(0),
  ];
  let twoBack = rows[2];
  let prev = rows[0];
  let cur = rows[1];

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, twoBack[j - 2] + 1);
      }
      cur[j] = d;
    }
    const spent = twoBack;
    twoBack = prev;
    prev = cur;
    cur = spent;
  }
  return prev[b.length];
}

/**
 * The capability an unknown one was most likely meant to be, or null when nothing is close enough.
 *
 * Two sources, in order. A known foreign name wins outright — `Glob` is not a typo for `find`, so no
 * distance metric would ever connect them, and that is exactly the case worth naming. Otherwise the
 * nearest catalog entry within a small edit distance, which catches `raed`/`serach` and stops well short
 * of guessing: the threshold scales with the name's length and never exceeds two.
 */
export function suggestForUnknown(unknown: Capability, catalog: Catalog): Capability | null {
  const foreign = FOREIGN_TOOL_NAMES[unknown.toLowerCase()];
  if (foreign && catalog.has(foreign)) return foreign;

  // Only among capabilities of the same namespace: suggesting `skill:review` for a mistyped tool name
  // would be a worse message than none, because it points the author at the wrong kind of fix.
  const ns = unknown.slice(0, unknown.indexOf(":") + 1);
  if (!ns) return null;
  const bare = unknown.slice(ns.length);
  const limit = Math.min(2, Math.floor(bare.length / 3));
  if (limit < 1) return null;

  let best: Capability | null = null;
  let bestDistance = limit + 1;
  for (const candidate of catalog.all) {
    if (!candidate.startsWith(ns)) continue;
    const d = editDistance(bare, candidate.slice(ns.length));
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return bestDistance <= limit ? best : null;
}

/**
 * Skill name -> absolute path, for `planSpawn`'s `--skill` flags (R-32).
 *
 * Derived from the catalog's own `source` field rather than re-scanning, so what a child is handed
 * cannot drift from what was discovered and offered. A skill entry without a source is omitted, which
 * makes it *unresolvable* rather than silently absent — `planDelegation` refuses on that, because a
 * grant naming a skill the child never receives is a ledger line that lies.
 */
export function skillPathsFromCatalog(catalog: Catalog): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const entry of catalog.entries) {
    if (entry.kind !== "skill" || !entry.source) continue;
    paths[entry.capability.slice("skill:".length)] = entry.source;
  }
  return paths;
}
