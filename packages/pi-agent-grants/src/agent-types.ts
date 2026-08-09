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
  for (const rawLine of match[1].split(/\r?\n/)) {
    // Only top-level `key: value` pairs; indented continuations belong to block scalars.
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(rawLine);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === ">" || value === "|" || value === "") continue; // block scalar or empty
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

  const name = fields.get("name");
  const isolatedRaw = fields.get("isolated");

  return {
    name: name ?? source.replace(/^.*\//, "").replace(/\.md$/, ""),
    tools: list("tools"),
    disallowedTools: list("disallowed_tools"),
    isolated: isolatedRaw === undefined ? undefined : isolatedRaw === "true",
    source,
  };
}

/**
 * The capability ceiling for a type.
 *
 * - `tools: read, grep`      -> ["tool:grep", "tool:read"]
 * - `tools: "*"` / `all`     -> [WILDCARD]
 * - `tools: none`            -> []
 * - `tools:` absent          -> [WILDCARD] — pi would hand it the full default toolset
 * - `ext:pkg/tool` entries   -> preserved as `ext:` capabilities
 *
 * `disallowed_tools` is subtracted last, mirroring pi-subagents (deny wins).
 */
export function ceilingFor(type: AgentType): Capability[] {
  const denied = new Set((type.disallowedTools ?? []).map((t) => `tool:${t}`));

  let ceiling: Capability[];
  if (type.tools === undefined) {
    ceiling = [WILDCARD];
  } else if (type.tools.some((t) => t === "*" || t === "all")) {
    ceiling = [WILDCARD];
  } else if (type.tools.length === 1 && type.tools[0] === "none") {
    ceiling = [];
  } else {
    ceiling = type.tools.map((t) => (t.startsWith("ext:") ? t : `tool:${t}`));
  }

  return ceiling.filter((c) => !denied.has(c)).sort();
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
