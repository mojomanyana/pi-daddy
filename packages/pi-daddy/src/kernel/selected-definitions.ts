/** Selected Pi 1.0.4 resources, frozen once per extension instance. No independent resource scan. */
import { createHash } from "node:crypto";
import { dirname, resolve as resolvePath } from "node:path";
import { lstat } from "node:fs/promises";
import { BoundedReadCleanupError, readBoundedBytes } from "./bounded-read.ts";
import { parseSkillDefinition, type SkillDefinition } from "./definitions.ts";
import { principalBinding } from "./principal-binding.ts";
import type { DefinitionSource } from "./definition-sources.ts";
import type { CatalogEntry } from "./catalog.ts";
export interface SelectedCommand {
  source?: string;
  name: string;
  sourceInfo?: { path?: string };
}
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
async function read(path: string, kind: DefinitionSource["kind"], sources?: DefinitionSource[]): Promise<string> {
  if (!(await lstat(path)).isFile()) throw Error(`nonregular selected resource: ${path}`);
  const result = await readBoundedBytes(path, { maxBytes: 1024 * 1024, timeoutMs: 3000 });
  if (!result.ok) throw Error(result.detail);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
  sources?.push(Object.freeze({ kind, path, base64: result.bytes.toString("base64") }));
  return text;
}
export async function selectedDefinitions(
  commands: readonly SelectedCommand[],
  captureSources = false,
): Promise<{
  definitions: Map<string, SkillDefinition>;
  skills: CatalogEntry[];
  skips: string[];
}> {
  const definitions = new Map<string, SkillDefinition>();
  const skills: CatalogEntry[] = [],
    skips: string[] = [],
    seen = new Set<string>();
  for (const command of commands) {
    if (command.source !== "skill" || !command.name.startsWith("skill:")) continue;
    const name = command.name.slice(6);
    if (seen.has(name)) {
      definitions.delete(name);
      skips.push(`${name}: duplicate selected resource`);
      continue;
    }
    seen.add(name);
    try {
      if (!command.sourceInfo?.path) throw Error("selected resource lacks a public source path");
      const path = resolvePath(command.sourceInfo.path);
      const sources: DefinitionSource[] | undefined = captureSources ? [] : undefined;
      const text = await read(path, "selected-skill", sources);
      const parsed = parseSkillDefinition(path, text);
      if (!parsed || parsed.name !== name) throw Error("selected name/path does not match definition");
      const bound = await principalBinding(path, parsed, text, sources, read);
      const selectedResources =
        bound.selectedResources ??
        Object.freeze({
          version: 1 as const,
          selectedSkill: Object.freeze({ path, sha256: hash(text) }),
          definition: Object.freeze({ path: bound.source, sha256: bound.sourceHash! }),
          resourceDirectory: dirname(path),
        });
      const definitionId = hash(
        JSON.stringify({
          name,
          source: bound.source,
          sourceHash: bound.sourceHash,
          selectedSkillHash: bound.selectedSkillHash,
          body: bound.body,
          allowedTools: bound.allowedTools,
          runtimePreferences: bound.runtimePreferences,
          binding: bound.binding,
          packageVersion: bound.packageVersion,
          selectedResources,
        }),
      );
      if (bound.metadata) Object.freeze(bound.metadata);
      definitions.set(
        name,
        Object.freeze({
          ...bound,
          selectedResources,
          definitionId,
          ...(sources
            ? { sourceSnapshot: Object.freeze({ resources: Object.freeze(sources), body: bound.body }) }
            : {}),
        }),
      );
      skills.push({ capability: `skill:${name}`, kind: "skill", source: path });
    } catch (error) {
      if (error instanceof BoundedReadCleanupError) throw error;
      skips.push(`${name}: ${String(error)}`);
    }
  }
  return { definitions, skills: skills.filter((s) => definitions.has(s.capability.slice(6))), skips };
}
