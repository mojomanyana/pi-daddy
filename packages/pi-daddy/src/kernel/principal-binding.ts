/** Legacy Principal dual-definition binding. Ordinary selected inline roles do not need this adapter. */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { realpath } from "node:fs/promises";
import { ceilingForDefinition, parseSkillDefinition, type SkillDefinition } from "./definitions.ts";
import { resolve } from "./resolve.ts";
import type { DefinitionSource } from "./definition-sources.ts";
const requiredPhases = ["plan", "build", "review", "debug", "investigate"];
const phases = [...requiredPhases, "test-review"];
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) =>
  Object.keys(x).sort().join(",") === [...keys].sort().join(",");
export async function principalBinding(
  path: string,
  inline: SkillDefinition,
  skillText: string,
  sources: DefinitionSource[] | undefined,
  read: (path: string, kind: DefinitionSource["kind"], sources?: DefinitionSource[]) => Promise<string>,
): Promise<SkillDefinition> {
  const phase = inline.name;
  const marked = inline.metadata?.["principal-package"] === "principal-pi-skills";
  if (!phases.includes(phase) || path !== join(dirname(dirname(path)), phase, "SKILL.md")) {
    if (marked) throw Error("marked Principal skill has a noncanonical phase or path");
    return inline;
  }
  const root = dirname(dirname(path));
  let packageText: string;
  try {
    packageText = await read(join(root, "package.json"), "package", sources);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !marked) return inline;
    throw error;
  }
  const pkg: unknown = JSON.parse(packageText);
  if (!object(pkg) || pkg.name !== "principal-pi-skills") {
    if (marked) throw Error("marked Principal skill has missing or wrong package identity");
    return inline;
  }
  const manifest: unknown = JSON.parse(await read(join(root, "principal-agents.json"), "binding-manifest", sources));
  if (
    !object(manifest) ||
    !exact(manifest, ["version", "package", "bindings"]) ||
    manifest.version !== 1 ||
    manifest.package !== "principal-pi-skills" ||
    !object(manifest.bindings) ||
    !exact(manifest.bindings, Object.hasOwn(manifest.bindings, "test-review") ? phases : requiredPhases)
  )
    throw Error("invalid Principal binding manifest");
  for (const name of Object.keys(manifest.bindings)) {
    const row = manifest.bindings[name];
    if (
      !object(row) ||
      !exact(row, ["skill", "agent", "skillSha256", "agentSha256"]) ||
      row.skill !== `${name}/SKILL.md` ||
      row.agent !== `agents/principal-${name}.md` ||
      typeof row.skillSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.skillSha256) ||
      typeof row.agentSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.agentSha256)
    )
      throw Error("invalid Principal binding row");
  }
  if (!Object.hasOwn(manifest.bindings, phase)) throw Error("selected Principal phase has no binding row");
  const row = manifest.bindings[phase] as Record<string, string>;
  const agentPath = join(root, row.agent);
  if (
    (await realpath(agentPath)) !== join(await realpath(root), row.agent) ||
    (await realpath(path)) !== join(await realpath(root), row.skill)
  )
    throw Error("Principal binding path escaped its selected package");
  const agentText = await read(agentPath, "delegated-agent", sources);
  if (hash(skillText) !== row.skillSha256 || hash(agentText) !== row.agentSha256)
    throw Error("Principal binding hash mismatch");
  const agent = parseSkillDefinition(agentPath, agentText);
  if (!agent) throw Error("Principal delegated definition is malformed");
  const inlineCeiling = ceilingForDefinition(inline),
    delegatedCeiling = ceilingForDefinition(agent);
  if (
    inlineCeiling.undeclared ||
    delegatedCeiling.undeclared ||
    inlineCeiling.patterns.length ||
    delegatedCeiling.patterns.length
  )
    throw Error("Principal binding needs two declared pattern-free ceilings");
  const ceiling = resolve({
    requested: delegatedCeiling.capabilities,
    parentGrant: inlineCeiling.capabilities,
    subsumption: false,
  }).effective;
  const header = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(agentText)!;
  return {
    ...agent,
    name: phase,
    source: agentPath,
    sourceHash: hash(agentText),
    selectedSkillHash: hash(skillText),
    body: agentText.slice(header[0].length),
    allowedTools: ceiling.join(","),
    runtimePreferences: agent.runtimePreferences ?? inline.runtimePreferences,
    ...(typeof pkg.version === "string" ? { packageVersion: pkg.version } : {}),
    binding: Object.freeze({ package: "principal-pi-skills", phase }),
  };
}
