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

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { skillDirs } from "./catalog.ts";
import type { Capability } from "./resolve.ts";

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

    fields.set(key, value);
  }

  const description = fields.get("description");
  if (description === undefined) return null;

  return {
    // Identity comes from the PATH. ADR-0013 learned this the hard way on the other format: pi keys
    // skills by their directory, so trusting a frontmatter `name` lets our view and the loader's
    // disagree about which file a name refers to. The spec requires `name` to match the parent
    // directory anyway, so a mismatch is the file's defect and not something to honour.
    name: nameFromPath(source),
    description,
    allowedTools: fields.get("allowed-tools"),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    body: text.slice(match[0].length).trim(),
    source,
  };
}

/** `/skills/review/SKILL.md` -> `review`; `/skills/triage.md` -> `triage`. */
function nameFromPath(source: string): string {
  const parts = source.split("/").filter((p) => p.length > 0);
  const last = parts.at(-1) ?? "";
  if (last.toLowerCase() === "skill.md") return parts.at(-2) ?? "";
  return last.replace(/\.md$/i, "");
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
    if (entry.startsWith("ext:") || entry.startsWith("skill:") || entry.startsWith("agent:")) {
      capabilities.add(entry);
      continue;
    }
    capabilities.add(`tool:${entry.toLowerCase()}`);
  }

  return { capabilities: [...capabilities].sort(), patterns, undeclared: false };
}

/**
 * Discover `SKILL.md` definitions under pi's skill roots.
 *
 * Deliberately the SAME roots and the same convention the catalog uses (`skillDirs`): a directory
 * containing `SKILL.md` is one definition named after the directory, and a top-level `.md` is one named
 * after the file. If discovery and the catalog disagreed, a definition could be spawnable but not
 * grantable, or listed but unspawnable.
 *
 * Earlier directories win on a name collision, matching pi's own precedence — project before global.
 */
export async function loadDefinitions(cwd: string): Promise<Map<string, SkillDefinition>> {
  const definitions = new Map<string, SkillDefinition>();
  for (const dir of skillDirs(cwd)) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue; // an absent skill root is normal
    }
    for (const name of [...names].sort()) {
      // A directory holding SKILL.md, or a top-level .md — try the former first, exactly as the
      // catalog does, so the two cannot disagree about what exists.
      const candidates = [join(dir, name, "SKILL.md"), ...(name.endsWith(".md") ? [join(dir, name)] : [])];
      for (const path of candidates) {
        let text: string;
        try {
          text = await readFile(path, "utf8");
        } catch {
          continue; // not this shape; try the next candidate
        }
        const parsed = parseSkillDefinition(path, text);
        // First writer wins, so project definitions shadow global ones rather than the reverse.
        if (parsed && !definitions.has(parsed.name)) definitions.set(parsed.name, parsed);
        break;
      }
    }
  }
  return definitions;
}
