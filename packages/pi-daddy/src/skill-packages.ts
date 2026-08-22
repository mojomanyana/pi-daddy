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
 *
 * **Everything read here comes from a third party**, so this module is also where the refusals live: a
 * name, a declared capability id, or a path that cannot safely be written into a generated file is refused
 * with a reason rather than passed on (R-77, R-78, R-80). `init` generates a shell file an operator
 * `source`s; the only strings that may reach it are ones that survived a whitelist here.
 */

import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ceilingForDefinition, parseSkillDefinition, type SkillDefinition } from "./definitions.ts";
import { WILDCARD } from "./pi-tools.ts";
import { AGENT_WILDCARD, WORKSPACE_WILDCARD, type Capability } from "./resolve.ts";
import { isSafeCapability } from "./capabilities.ts";

export interface DiscoveredSkill {
  definition: SkillDefinition;
  /** The file verbatim. `init` copies it rather than regenerating it, so nothing is lost in a round trip. */
  text: string;
  path: string;
}

/** Why a declared skill was refused before it could be planned. Each has a different fix. */
export type RefusalReason =
  /** The name cannot be a capability id, a line in a sourced file, or a path segment. */
  | "unsafe-name"
  /** A declared `allowed-tools` entry cannot be one either — R-78, the sibling of R-77. */
  | "unsafe-capability"
  /** The declaration claims `tool:*` or `agent:*`: root authority, which a package may not hand itself. */
  | "wildcard"
  /** The bytes are not valid UTF-8, so "copied verbatim" could not be honoured. */
  | "not-utf8";

export interface RefusedSkill {
  /** The `pi.skills` entry or the definition name, whichever the operator can act on. */
  subject: string;
  reason: RefusalReason;
  /** The offending id(s), when the reason names any. */
  detail: string[];
}

export interface SkillPackage {
  name: string;
  version: string;
  /** Paths `pi.skills` named that could not be read as a `SKILL.md`, so the report can say so out loud. */
  unreadable: string[];
  /** Skills refused for a reason that would otherwise reach a generated file. Never silently dropped. */
  refused: RefusedSkill[];
  skills: DiscoveredSkill[];
}

/**
 * May this definition's name be written into a capability id, a shell file and a path?
 *
 * **Measured before it was written, and it was a defect in this module's first version (R-77).** A
 * definition's identity is its directory name, and `init` interpolates that name into three places at once:
 * `agent:<name>` inside a **comma-separated** `PI_GRANTS_GRANT`, a `.pi/grants.env` an operator **sources**,
 * and the path it writes the copy to. An installed package with a directory called `a,tool:bash` produced
 *
 * ```
 * export PI_GRANTS_GRANT="agent:a,tool:bash,tool:delegate,tool:read"
 * ```
 *
 * — `tool:bash` in an operator's grant, declared by nobody. A quote character reaches a file that gets
 * `source`d, and a name of `..` writes outside `.pi/skills/`. One rule closes all three, and it is
 * deliberately a **whitelist**: the safe set here is small and the unsafe set is the rest of Unicode.
 *
 * The first character must be alphanumeric, so `..` and dotfiles are refused along with everything else.
 */
export function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/**
 * May this DECLARED capability id be written into the generated grant? — R-78.
 *
 * **R-77's other half, and the reason a whitelist beats a blocklist twice.** R-77 was closed on the name
 * channel; the `allowed-tools` *value* travels to the identical interpolation site and was unchecked, so a
 * package declaring
 *
 * ```yaml
 * allowed-tools: Read,ext:x";touch /tmp/pwned;PI_GRANTS_GRANT="
 * ```
 *
 * produced a `.pi/grants.env` that executed arbitrary code the moment the operator ran the `source` line
 * `init` itself prints. Reproduced end to end before this existed. `ceilingForDefinition` passes `ext:`,
 * `skill:` and `agent:` entries through **as written** by design (a translation table would invent or drop
 * grants), which is right for the enforcement path — the catalog refuses what it does not know — and is
 * exactly why the check has to be here, at the boundary that *generates* rather than the one that enforces.
 *
 * The grammar is the one `docs/SPEC.md` documents: `tool:<name>`, `skill:<name>`, `agent:<name>`,
 * `workspace:<id>`, and `ext:<pkg>/<tool>` where `<pkg>` may be npm-scoped. No wildcards — those are refused
 * separately and loudly, because "you tried to grant yourself everything" is a different fact from "that is
 * not a name".
 *
 * `workspace:` was absent until 2026-08-21, so the boundary that GENERATES grants could not emit the one
 * capability ADR-0035's breaking change made mandatory: a package needing to route was reported as declaring
 * something that "is not a name". A namespace has to be added here as well as to the enforcing path, and
 * that is the whole lesson of the review this came out of.
 */
// Imported as well as re-exported: a bare `export … from` does not bind the name in this module's scope, and
// `refusalFor` below calls it. Re-exported because this has been the import site since 0.13.0.
export { isSafeCapability };

/**
 * The ids that confer authority over a whole namespace. A package declaring one is claiming it, not
 * describing a need — so it is reported as a *wildcard claim* rather than as a malformed name, which is a
 * different sentence to show an operator. `workspace:*` belongs here for the same reason `agent:*` does.
 */
function wildcardsIn(capabilities: Capability[]): Capability[] {
  return capabilities.filter((c) => c === WILDCARD || c === AGENT_WILDCARD || c === WORKSPACE_WILDCARD);
}

/**
 * Everything about one declared skill that would make it unsafe to scaffold. `null` when it is fine.
 *
 * Ordered so the operator is told the most actionable thing: a wildcard is a deliberate claim, an unsafe id
 * is probably a typo or an attack, and a bad name is neither.
 */
function refusalFor(skill: DiscoveredSkill): RefusedSkill | null {
  const name = skill.definition.name;
  if (!isSafeName(name)) return { subject: name, reason: "unsafe-name", detail: [name] };

  const ceiling = ceilingForDefinition(skill.definition);
  const wildcards = wildcardsIn(ceiling.capabilities);
  if (wildcards.length > 0) return { subject: name, reason: "wildcard", detail: wildcards };

  const unsafe = ceiling.capabilities.filter((c) => !isSafeCapability(c));
  if (unsafe.length > 0) return { subject: name, reason: "unsafe-capability", detail: unsafe };

  return null;
}

/** One `pi.skills` entry: a directory holding `SKILL.md`, or a `.md` file — the same two shapes pi allows. */
async function readSkill(packageDir: string, entry: string): Promise<DiscoveredSkill | "not-utf8" | null> {
  const target = resolve(packageDir, entry);
  // A manifest is data from another package, so an entry escaping its own directory is refused rather than
  // followed. **`realpath`, not a lexical prefix test** (R-80): `resolve()` normalises `..` and knows
  // nothing about symlinks, so a packaged symlink walked straight past the first version of this check and
  // a definition from outside the package was copied in, with its `allowed-tools` landing in the operator's
  // grant. Measured. This is the same lesson as the `realpathSync` fix in `cli.ts`, which was found by the
  // smoke test one day earlier and not applied here.
  const realPackageDir = await realpath(packageDir).catch(() => packageDir);
  for (const path of [join(target, "SKILL.md"), ...(target.endsWith(".md") ? [target] : [])]) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      continue;
    }
    const realPath = await realpath(path).catch(() => path);
    if (!realPath.startsWith(realPackageDir + sep)) return null;

    // "The file verbatim … nothing is lost in a round trip" is a claim this module makes, so bytes that
    // cannot survive the round trip are refused rather than silently replaced. A latin-1 `0xE9` used to come
    // back as U+FFFD, changing the file's length and its digest, with no warning.
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) return "not-utf8";

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
  const refused: RefusedSkill[] = [];
  for (const entry of declared) {
    if (typeof entry !== "string") continue;
    const skill = await readSkill(packageDir, entry);
    if (skill === null) {
      unreadable.push(entry);
    } else if (skill === "not-utf8") {
      refused.push({ subject: entry, reason: "not-utf8", detail: [] });
    } else {
      const refusal = refusalFor(skill);
      if (refusal) refused.push(refusal);
      else skills.push(skill);
    }
  }

  return {
    name: manifest.name ?? packageDir.split(sep).pop() ?? "(unnamed)",
    version: manifest.version ?? "(no version)",
    unreadable,
    refused,
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
/**
 * Every place a pi package can be installed, most specific first (R-75).
 *
 * **Two roots, because pi has two install paths and only one of them is `npm install`.** `pi install
 * npm:principal-pi-skills` — the documented, pi-native way, and the only one that registers the package so
 * pi will auto-load its extension — puts it in `$PI_CODING_AGENT_DIR/npm/node_modules`, and leaves the
 * project without a `node_modules` at all. Searching only `<cwd>/node_modules` therefore found **nothing**
 * for an operator who followed pi's own instructions, and said "install principal-pi-skills" to somebody
 * who just had.
 *
 * Measured, in a fresh `PI_CODING_AGENT_DIR` with an empty project: `pi install` populates the agent root
 * and creates no project root.
 *
 * Project first when both exist, because a package pinned in the repository is the one the team agreed on.
 */
export function skillPackageRoots(cwd: string): string[] {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return [join(cwd, "node_modules"), join(agentDir, "npm", "node_modules")];
}

export async function discoverSkillPackages(cwd: string): Promise<SkillPackage[]> {
  const dirs: string[] = [];
  const seenNames = new Set<string>();
  for (const root of skillPackageRoots(cwd)) await collectFrom(root, dirs);

  const packages: SkillPackage[] = [];
  for (const dir of dirs) {
    const found = await readSkillPackage(dir);
    // First root wins on a name collision: the project's pinned copy outranks the machine-wide one, and
    // silently preferring the other would make a committed lockfile stop meaning anything.
    if (found && !seenNames.has(found.name)) {
      seenNames.add(found.name);
      packages.push(found);
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/** Append every package directory under one `node_modules`, scoped packages included. */
async function collectFrom(root: string, dirs: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return; // a root that does not exist is a normal state, not a failure
  }

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
}
