/**
 * Which installed npm packages ship `SKILL.md` definitions — read from their own manifests.
 *
 * `pi-daddy init` scaffolds a governed project from whatever skill packages are already installed, and
 * this is how it finds them: **a package declares its skills in `package.json`'s `pi.skills` array**, which
 * is pi's own convention and how pi itself loads them. Measured against `principal-pi-skills@2.3.1`:
 *
 * ```json
 * "pi": { "skills": ["./decide", "./architect", "./plan", "./build", "./review", "./debug", "./git-ops"] }
 * ```
 *
 * **A declaration, never a heuristic.** Walking `node_modules` looking for files called `SKILL.md` would
 * find a package's test fixtures, its examples, and its vendored copies of someone else's skills — and
 * would then offer to install them as spawnable sub-agents. A package that says which of its files are
 * skills has said so on purpose, and that is the only list this reads.
 *
 * What it deliberately does NOT do: scan `~/.pi/agent/skills/`. Definitions already in a skill root are
 * discovered by `loadDefinitions` and governed as they stand; copying them into a project would duplicate
 * them under a name that shadows the original (project wins on collision), which is a change nobody asked
 * for.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parseSkillDefinition, type SkillDefinition } from "./definitions.ts";

export interface DiscoveredSkill {
  definition: SkillDefinition;
  /** The file verbatim. `init` copies it rather than regenerating it, so nothing is lost in a round trip. */
  text: string;
  path: string;
}

export interface SkillPackage {
  name: string;
  version: string;
  /** Paths `pi.skills` named that could not be read as a `SKILL.md`, so the report can say so out loud. */
  unreadable: string[];
  /** Skills refused because their name cannot safely be a capability id or a path — see `isSafeName`. */
  unsafe: string[];
  skills: DiscoveredSkill[];
}

/**
 * May this definition's name be written into a capability id, a shell file and a path?
 *
 * **Measured before it was written, and it was a defect in this module's first version.** A definition's
 * identity is its directory name, and `init` interpolates that name into three places at once:
 * `agent:<name>` inside a **comma-separated** `PI_GRANTS_GRANT`, a `.pi/grants.env` an operator **sources**,
 * and the path it writes the copy to. An installed package with a directory called `a,tool:bash` produced
 *
 * ```
 * export PI_GRANTS_GRANT="agent:a,tool:bash,tool:delegate,tool:read"
 * ```
 *
 * — `tool:bash` in an operator's grant, declared by nobody and chosen by no one. A quote character reaches
 * a file that gets `source`d, and a name of `..` writes outside `.pi/skills/`. One rule closes all three,
 * and it is deliberately a **whitelist**: the safe set here is small and the unsafe set is the rest of
 * Unicode.
 *
 * The first character must be alphanumeric, so `..` and dotfiles are refused along with everything else.
 */
export function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/** One `pi.skills` entry: a directory holding `SKILL.md`, or a `.md` file — the same two shapes pi allows. */
async function readSkill(packageDir: string, entry: string): Promise<DiscoveredSkill | null> {
  const target = resolve(packageDir, entry);
  // A manifest is data from another package, so an entry escaping its own directory is refused rather than
  // followed. Rule 8: fail closed, and it costs one comparison.
  if (target !== packageDir && !target.startsWith(packageDir + sep)) return null;

  for (const path of [join(target, "SKILL.md"), ...(target.endsWith(".md") ? [target] : [])]) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const definition = parseSkillDefinition(path, text);
    return definition ? { definition, text, path } : null;
  }
  return null;
}

/** Read one installed package, if it declares skills. `null` means "not a skill package", not an error. */
export async function readSkillPackage(packageDir: string): Promise<SkillPackage | null> {
  let manifest: { name?: string; version?: string; pi?: { skills?: unknown } };
  try {
    manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const declared = manifest.pi?.skills;
  if (!Array.isArray(declared) || declared.length === 0) return null;

  const skills: DiscoveredSkill[] = [];
  const unreadable: string[] = [];
  const unsafe: string[] = [];
  for (const entry of declared) {
    if (typeof entry !== "string") continue;
    const skill = await readSkill(packageDir, entry);
    if (!skill) unreadable.push(entry);
    else if (!isSafeName(skill.definition.name)) unsafe.push(skill.definition.name);
    else skills.push(skill);
  }

  return {
    name: manifest.name ?? packageDir.split(sep).pop() ?? "(unnamed)",
    version: manifest.version ?? "(no version)",
    unreadable,
    unsafe,
    skills,
  };
}

/**
 * Every installed package under `<cwd>/node_modules` that declares `pi.skills`, sorted by name.
 *
 * Top level and one scope deep, which is what npm's layout has. Nothing recurses into a dependency's own
 * `node_modules`: a transitive skill package is not something an operator asked to install definitions
 * from, and scaffolding one into their project would be a surprise wearing a helpful face.
 */
export async function discoverSkillPackages(cwd: string): Promise<SkillPackage[]> {
  const root = join(cwd, "node_modules");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return []; // no node_modules is a normal state, not a failure
  }

  const dirs: string[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue; // .bin, .package-lock.json
    if (entry.startsWith("@")) {
      try {
        for (const scoped of (await readdir(join(root, entry))).sort()) dirs.push(join(root, entry, scoped));
      } catch {
        continue;
      }
    } else {
      dirs.push(join(root, entry));
    }
  }

  const packages: SkillPackage[] = [];
  for (const dir of dirs) {
    const found = await readSkillPackage(dir);
    if (found) packages.push(found);
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}
