/**
 * Read agent-type definitions (`.pi/agents/*.md`, `~/.pi/agent/agents/*.md`) and derive each type's
 * capability CEILING — the declarative maximum it may ever hold.
 *
 * These files are `@tintinweb/pi-subagents`' format: YAML frontmatter, where `tools:` is an allowlist
 * and its ABSENCE means the type receives pi's full default toolset. Absence is therefore the dangerous
 * case, and it is modelled as the wildcard `tool:*` so that it can only be granted by a delegator who
 * explicitly holds the wildcard. Fail closed, not open.
 */

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Capability } from "./resolve.ts";

/** Capability held only by a delegator authorised to hand out everything. */
export const WILDCARD: Capability = "tool:*";

/** pi's built-in tools as of 0.83.0 (`packages/coding-agent/src/core/tools/`). */
export const PI_BUILTIN_TOOLS = [
  "bash", "edit", "edit-diff", "find", "grep", "ls", "read", "write",
] as const;

export interface AgentType {
  name: string;
  /** Parsed `tools:` allowlist, or undefined when the key is absent. */
  tools?: string[];
  disallowedTools?: string[];
  isolated?: boolean;
  /** `extensions:` — absent or anything but false/none means the child inherits the session's extensions. */
  inheritsExtensions?: boolean;
  /** `skills:` — same defaulting. Recorded for honesty; `--tools` cannot gate a skill (see ADR-0013). */
  inheritsSkills?: boolean;
  /** Path the definition came from, for the ledger and for error messages. */
  source: string;
}

/**
 * Minimal frontmatter reader — deliberately not a YAML parser.
 *
 * It handles the subset these files actually use: `key: value` and comma-separated scalar lists at the
 * top level of the frontmatter block. Block scalars (`description: >`) are skipped rather than
 * misparsed. If a `tools:` line ever appears in a form this cannot read, the key is treated as ABSENT,
 * which yields the wildcard ceiling and therefore denies rather than over-grants.
 */
export function parseAgentType(source: string, text: string): AgentType | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;

  const fields = new Map<string, string>();
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // Only top-level `key: value` pairs; indented continuations belong to block scalars.
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === ">" || value === "|") continue; // block scalar — genuinely not readable here

    if (value === "") {
      // ADR-0013. An empty value may introduce a YAML BLOCK LIST:
      //     tools:
      //       - read
      //       - grep
      // The old reader skipped it as "empty", so the key read as ABSENT — and absence meant the
      // wildcard, so a two-tool child was recorded as holding everything. That is the permissive
      // direction, which is the one an audit record must never fail in. pi parses the list and
      // pi-subagents `String()`s the array into "read,grep", so collecting the items and joining with
      // commas reproduces its result exactly.
      const items: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s+-\s*(.+?)\s*$/.exec(lines[j]);
        if (!item) break;
        items.push(item[1].replace(/^["']|["']$/g, ""));
      }
      if (items.length > 0) {
        fields.set(key, items.join(","));
        i += items.length;
      }
      continue;
    }
    fields.set(key, value.trim());
  }

  const list = (key: string): string[] | undefined => {
    const raw = fields.get(key);
    if (raw === undefined) return undefined;
    return raw
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0);
  };

  const isolatedRaw = fields.get("isolated");
  const extensionsRaw = fields.get("extensions");
  const skillsRaw = fields.get("skills");

  return {
    // ADR-0013: the FILENAME is the identity. `pi-subagents` keys its registry by
    // `basename(file, ".md")` and ignores the frontmatter `name` entirely, so trusting `name` meant our
    // registry and the spawner could disagree about which definition a type refers to — the root of the
    // TOCTOU finding, and a one-line fix once noticed.
    name: source.replace(/^.*\//, "").replace(/\.md$/, ""),
    tools: list("tools"),
    disallowedTools: list("disallowed_tools"),
    isolated: isolatedRaw === undefined ? undefined : isolatedRaw === "true",
    // Both default to TRUE when absent (`inheritField`), which is why a ceiling read from `tools:`
    // alone is not the child's authority.
    inheritsExtensions: extensionsRaw !== "false" && extensionsRaw !== "none",
    inheritsSkills: skillsRaw !== "false" && skillsRaw !== "none",
    source,
  };
}

export interface CeilingOptions {
  /**
   * Extension-tool capabilities this session actually has, for the types that inherit them.
   *
   * Omit it and any inheriting type resolves to the WILDCARD — see below. This is the parameter that
   * makes finding 2 ("the ceiling omits extensions and skills") representable rather than ignored.
   */
  extensionTools?: Capability[];
}

/**
 * The capability ceiling for a type — **what the child will actually receive**.
 *
 * ADR-0013. Every rule below was read from `@tintinweb/pi-subagents@0.14.3`
 * (`parseToolsField` / `csvList` in `src/custom-agents.ts`), because a ceiling that disagrees with the
 * spawner is not a conservative approximation — it is a wrong audit record, and the disagreement ran in
 * the permissive direction.
 *
 * | `tools:` | ceiling |
 * | :--- | :--- |
 * | absent | **every built-in** (`csvList` returns its defaults) — NOT the wildcard |
 * | `none` / empty | `[]` |
 * | `*` / `all` (case-insensitive) | every built-in, plus any plain entries |
 * | CSV, inline array, or block list | those entries |
 * | only `ext:` entries | zero built-ins, those selectors |
 *
 * **Then extensions.** `extensions:` defaults to true, so most types also receive the session's
 * extension tools. Passing `extensionTools` enumerates them; **omitting it yields the WILDCARD**, because
 * an un-enumerated inheritance cannot be honestly bounded and an under-counted ceiling is one that gets
 * ALLOWED. Fail closed.
 *
 * `disallowed_tools` is subtracted last, mirroring pi-subagents (deny wins).
 */
export function ceilingFor(type: AgentType, options: CeilingOptions = {}): Capability[] {
  const denied = new Set((type.disallowedTools ?? []).map((t) => `tool:${t}`));
  const builtinCaps = PI_BUILTIN_TOOLS.map((t) => `tool:${t}`);

  const entries = type.tools;
  let ceiling: Capability[];
  if (entries === undefined) {
    ceiling = [...builtinCaps];
  } else if (entries.length === 0 || (entries.length === 1 && entries[0] === "none")) {
    ceiling = [];
  } else {
    const isWildcard = (e: string) => e === "*" || e.toLowerCase() === "all";
    const plain = entries.filter((e) => !isWildcard(e) && !e.startsWith("ext:"));
    const ext = entries.filter((e) => e.startsWith("ext:"));
    const builtins = entries.some(isWildcard)
      ? [...new Set([...builtinCaps, ...plain.map((t) => `tool:${t}`)])]
      : plain.map((t) => `tool:${t}`);
    ceiling = [...builtins, ...ext];
  }

  // Inheritance is part of the ceiling, not a footnote to it.
  if (type.inheritsExtensions !== false) {
    if (options.extensionTools === undefined) return [WILDCARD];
    ceiling = [...ceiling, ...options.extensionTools];
  }

  return [...new Set(ceiling)].filter((c) => !denied.has(c)).sort();
}

/** Directories pi-subagents reads agent types from, project first. */
export function agentTypeDirs(cwd: string): string[] {
  return [join(cwd, ".pi", "agents"), join(cwd, ".agents", "agents"), join(homedir(), ".pi", "agent", "agents")];
}

/** Load all agent types; earlier directories win on name collision, matching pi-subagents' precedence. */
export async function loadAgentTypes(cwd: string): Promise<Map<string, AgentType>> {
  const types = new Map<string, AgentType>();
  for (const dir of agentTypeDirs(cwd)) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // directory absent is normal
    }
    for (const entry of entries.filter((e) => e.endsWith(".md")).sort()) {
      const path = join(dir, entry);
      try {
        const parsed = parseAgentType(path, await readFile(path, "utf8"));
        if (parsed && !types.has(parsed.name)) types.set(parsed.name, parsed);
      } catch {
        // An unreadable definition must not silently become an unbounded grant; skip it, and the
        // interceptor will treat the unknown type as wildcard-requesting.
      }
    }
  }
  return types;
}
