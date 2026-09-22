/**
 * Agent Skills (`SKILL.md`) as this package's definition format — ADR-0016.
 *
 * A subagent is a skill you spawn: the `SKILL.md` body becomes the child's system prompt
 * (`--append-system-prompt`) and `allowed-tools` becomes its capability ceiling, enforced through
 * `--tools`. That collapses a duplication `principal-pi-skills` already strains against, where
 * `plan`/`review`/`debug` exist twice — once as a skill and once as a subagent prompt — and are
 * generated from one contract precisely so the two cannot drift.
 *
 * **The spec's own words about `allowed-tools`:** *"a space-separated string of tools that are
 * pre-approved to run"*, marked **experimental**. Pre-approved, not enforced — the field declares intent
 * and blocks nothing, and implementations differ on whether they honour it at all. Turning that
 * declaration into something structural is this package's entire value here.
 *
 * **One inversion is deliberate and load-bearing.** In pi-subagents' frontmatter an absent `tools:` key
 * means *pi's full default toolset*, so an undeclared definition was the most powerful kind and any
 * parse failure produced a wildcard — the direction that caused R-28 and review finding F18. Here an
 * absent `allowed-tools` means **undeclared, therefore not spawnable**. A typo or an unreadable YAML
 * form now costs a refusal instead of a grant.
 */

import { createHash } from "node:crypto";
import { readBoundedFile } from "./bounded-read.ts";
import { resolveSkillResources, skillResourceName } from "./skill-resources.ts";
import { CAPABILITY_NAMESPACE_PREFIXES } from "./capabilities.ts";
import type { Capability } from "./resolve.ts";

/**
 * Identifies WHICH instructions a child was given, without reproducing them (ADR-0018).
 *
 * The ledger's standing rule is *capability ids, counts and identifiers only — never prompts, tool
 * arguments or results*. A hash is an identifier: it names a version of an operator-authored file. The
 * **task** is model-assembled from the parent's context and is never recorded anywhere, by decision.
 */
export interface DefinitionDigest {
  name: string;
  /** Where the definition was read from, so a reader can go and rehash it. */
  source: string;
  /** SHA-256 of the body — the exact text passed as `--append-system-prompt`. */
  sha256: string;
}

/**
 * Digest a definition's body.
 *
 * Over the **body alone**, deliberately: that is precisely the text the child receives, so a digest that
 * also covered the frontmatter would change when `description` was reworded and report an instruction
 * change that never happened. `allowed-tools` is already recorded in full on every record.
 */
export function digestDefinition(definition: SkillDefinition): DefinitionDigest {
  return {
    name: definition.name,
    source: definition.source,
    sha256: createHash("sha256").update(definition.body, "utf8").digest("hex"),
  };
}

export interface SkillDefinition {
  /** From the path, never the frontmatter — see `parseSkillDefinition`. */
  name: string;
  description: string;
  /** Raw `allowed-tools` value. `undefined` means the key was absent; `""` means it declared none. */
  allowedTools?: string;
  /** The spec's sanctioned extension point: a map of string keys to string values. */
  metadata?: Record<string, string>;
  /** Everything after the frontmatter — the child's system prompt. */
  body: string;
  source: string;
}

export interface DefinitionCeiling {
  /** The declared capabilities, as this package's ids. */
  capabilities: Capability[];
  /**
   * Entries carrying a sub-tool pattern, e.g. `Bash(git:*)`.
   *
   * ADR-0016 refuses these rather than reinterpreting them, because every reinterpretation is wrong:
   * granting bare `bash` **widens** a deliberately narrow declaration, dropping the tool silently
   * **narrows** and yields a child that mysteriously cannot work, and matching patterns inside a wrapper
   * would be a security control implemented by string-matching a shell command. Non-empty means the
   * caller must refuse and say so.
   */
  patterns: string[];
  /** The `allowed-tools` key was absent entirely: the definition is not spawnable. */
  undeclared: boolean;
}

/**
 * Read a `SKILL.md`.
 *
 * The frontmatter reader handles the subset these files use — `key: value`, block scalars (`>` / `|`),
 * and a one-level `metadata:` map. Anything it cannot read leaves the key **absent**, which for
 * `allowed-tools` means *undeclared* and therefore refused. That is the whole reason this parser can be
 * hand-rolled without the hazard its sibling in `agent-types.ts` carries.
 */
export function parseSkillDefinition(source: string, text: string): SkillDefinition | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return null;

  const fields = new Map<string, string>();
  const metadata: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();

    // A folded/literal scalar: fold the indented continuation into one line. `principal-pi-skills`
    // writes every description this way, and the sibling parser SKIPS these — which is safe there only
    // because it never needs the value. Here a skipped `description` would be a missing required field.
    if (value === ">" || value === "|") {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (!/^\s+\S/.test(lines[j])) break;
        parts.push(lines[j].trim());
        i = j;
      }
      fields.set(key, parts.join(" "));
      continue;
    }

    // `metadata:` introduces a one-level map of string keys to string values (the spec's shape).
    if (key === "metadata" && value === "") {
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[j]);
        if (!item) break;
        metadata[item[1]] = item[2].trim().replace(/^["']|["']$/g, "");
        i = j;
      }
      continue;
    }

    // A YAML collection/block we cannot parse is not an explicit empty ceiling.
    if (key === "allowed-tools" && value === "") {
      const nextValue = lines.slice(i + 1).find((line) => line.trim() !== "" && !/^\s*#/.test(line));
      if (/^\s+\S/.test(nextValue ?? "")) continue;
    }
    fields.set(key, value);
  }

  const description = fields.get("description");
  if (description === undefined) return null;

  return {
    // Identity comes from the PATH. ADR-0013 learned this the hard way on the other format: pi keys
    // skills by their directory, so trusting a frontmatter `name` lets our view and the loader's
    // disagree about which file a name refers to. The spec requires `name` to match the parent
    // directory anyway, so a mismatch is the file's defect and not something to honour.
    name: skillResourceName(source),
    description,
    allowedTools: fields.get("allowed-tools"),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    body: text.slice(match[0].length).trim(),
    source,
  };
}

/**
 * Turn a definition's `allowed-tools` into a capability ceiling.
 *
 * Name mapping is **lowercasing and nothing else**, deliberately. A translation table from Claude
 * Code's names to pi's would have to decide what `Glob` means, and pi has no glob tool — so the table
 * would either invent a grant or quietly drop one. Lowercasing leaves `Glob` as `tool:glob`, which the
 * catalog then refuses as unknown, naming the actual problem to whoever wrote the file.
 */
export function ceilingForDefinition(definition: SkillDefinition): DefinitionCeiling {
  const raw = definition.allowedTools;
  if (raw === undefined) return { capabilities: [], patterns: [], undeclared: true };

  const capabilities = new Set<Capability>();
  const patterns: string[] = [];

  // The spec says space-separated. Commas are tolerated because `Read, Grep` is what people type, and
  // accepting them grants nothing extra — it only avoids a comma becoming part of a capability name.
  for (const entry of raw.split(/[\s,]+/).filter((e) => e.length > 0)) {
    if (entry.includes("(")) {
      patterns.push(entry);
      continue;
    }
    // Every namespaced id passes through untouched; only a BARE tool name gets the `tool:` prefix and the
    // lowercasing. `workspace:` was missing here after ADR-0035 taught `normaliseCapability` about it, so a
    // definition declaring `allowed-tools: workspace:prod` produced `tool:workspace:prod` — a capability
    // that names nothing, refused as unknown, and dropped by `init` as "probably a typo or an attack". Two
    // spellings of one grammar with this one wrong is R-28's shape; the list is now shared.
    if (CAPABILITY_NAMESPACE_PREFIXES.some((prefix) => entry.startsWith(prefix))) {
      capabilities.add(entry);
      continue;
    }
    capabilities.add(`tool:${entry.toLowerCase()}`);
  }

  return { capabilities: [...capabilities].sort(), patterns, undeclared: false };
}

/**
 * A `SKILL.md` is an operator-authored markdown file; anything approaching this is not one.
 *
 * The same order of magnitude as the registry's bound and for the same reason. Measured at `7096f78`: a
 * bare `readFile` pulled an 8 MiB `SKILL.md` into memory in 8ms without complaint, and this loop runs once
 * per discovered skill inside `session_start`.
 */
export const DEFINITION_MAX_BYTES = 1 << 20;

/** A definition read is a local file read; a second is three orders of magnitude of headroom. */
export const DEFINITION_READ_TIMEOUT_MS = 2_000;

/**
 * Read definitions from Pi's enabled resources, including installed packages and local overrides.
 * Resolver precedence and filters are shared with the capability catalog; unregistered npm packages
 * are not runtime resources until legacy init explicitly scaffolds them.
 *
 * **Bounded, and loud about what it dropped.** This used a bare `readFile` with `catch { continue }`, which
 * is both halves of what rule 8 forbids: unbounded, and silent. `resolveSkillResources` filters by
 * `statSync(...).isFile()`, so a FIFO *named* in the resource list is already dropped — but that check is by
 * NAME and the read that followed was by name too, which is the TOCTOU the registry's own comment block
 * describes swapping a regular file for a FIFO through. `readBoundedFile` makes every check against the held
 * descriptor. `skipped` exists so a caller can say which paths were dropped and why, rather than an operator
 * finding a definition absent from `/grants` with nothing anywhere explaining it.
 */
export async function loadDefinitions(
  cwd: string,
  skipped?: (path: string, reason: string) => void,
): Promise<Map<string, SkillDefinition>> {
  const definitions = new Map<string, SkillDefinition>();
  for (const { path } of (await resolveSkillResources(cwd)).skills) {
    const read = await readBoundedFile(path, {
      maxBytes: DEFINITION_MAX_BYTES,
      timeoutMs: DEFINITION_READ_TIMEOUT_MS,
    });
    if (!read.ok) {
      skipped?.(path, read.detail);
      continue;
    }
    const parsed = parseSkillDefinition(path, read.text);
    if (!parsed) skipped?.(path, `${path} has no readable frontmatter with a description`);
    // Shadowing is legitimate — a project override is SUPPOSED to win over a package's copy — but review
    // pointed out it was the one remaining drop with no word said, in the very function being made loud.
    else if (definitions.has(parsed.name))
      skipped?.(path, `${path} is shadowed by an earlier definition named ${parsed.name}`);
    else definitions.set(parsed.name, parsed);
  }
  return definitions;
}
