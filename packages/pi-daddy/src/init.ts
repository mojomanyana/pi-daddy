/**
 * `pi-daddy init` — scaffold a governed project from the skill packages already installed (B2, P3).
 *
 * Today an operator wanting to govern a package of skills must, per skill: create a directory, copy the
 * body, hand-write frontmatter, choose a capability set with no guidance, and assemble a `PI_GRANTS_GRANT`
 * string by hand. Seven times, for `principal-pi-skills`. This does the mechanical parts.
 *
 * **The line it does not cross, and the reason this module exists at all:** `init` writes files an operator
 * then **reviews, edits and commits**. It never chooses a ceiling. A skill that declares `allowed-tools` is
 * copied *verbatim* — the author's declaration is the ceiling, and re-deriving it here would put a second
 * opinion between the file and the enforcer. A skill that declares none is copied with a **commented**
 * placeholder and stays unspawnable until a human fills it in.
 *
 * **What it DOES choose is the starting grant, which is a stronger act** — ADR-0029, added after a reviewer
 * pointed out that ADR-0028 drew its boundary around the wrong object. The handoff's reason a third party
 * may safely author `allowed-tools` is that *"the operator's `PI_GRANTS_GRANT` still bounds it"*; a
 * generated union gives the bound and the bounded one author, and it is not the operator. So capabilities
 * that can change a machine are emitted **commented** (`./grant-env.ts`).
 *
 * The placeholder is deliberately not a working example. Uncommenting it unedited yields capability ids
 * like `tool:<list` which the catalog refuses as unknown — a loud failure, in the direction rule 8 asks
 * for, rather than a grant nobody decided.
 */

import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentCapability, workspaceCapability } from "./capabilities.ts";
import { ceilingForDefinition } from "./definitions.ts";
import { runWithFinalizers } from "./finalization.ts";
import { ALWAYS_LIVE, assertGrantIsWritable, isLiveByDefault, renderGrantEnv, type GrantEnvSkill } from "./grant-env.ts";
import { PI_BUILTIN_TOOLS } from "./pi-tools.ts";
import type { Capability } from "./resolve.ts";
import type { SkillPackage } from "./skill-packages.ts";

/** Why a discovered skill is not authorised in the generated grant. `null` means it is. */
/**
 * How many of `from`'s skills actually **declare** a ceiling.
 *
 * Exported because the number is printed to an operator and was wrong: `cli.ts` filtered on
 * `withheld === null`, which is false for all three `WithholdReason`s — so a skill that declares
 * `allowed-tools` perfectly well and merely needs a withheld capability counted as not declaring one.
 * Against `principal-pi-skills` that printed *"7 skill(s), 3 declaring allowed-tools"* while all seven
 * declared. R-28's shape: a diagnostic disagreeing with the thing it describes.
 *
 * **It was invisible until the integration worked.** Before ceilings shipped, none of the seven declared
 * and the line read *"0 declaring"* — correct by coincidence, for the wrong reason. A count that is right
 * only while the interesting case is absent is the kind this project keeps finding.
 *
 * `undeclared` is the only reason that means "did not declare". `pattern` declared something this package
 * refuses to reinterpret, and `needs-withheld` declared something fine that the operator must opt into —
 * both are declarations.
 */
export function countDeclaring(skills: PlannedSkill[], from: string): number {
  return skills.filter((s) => s.from === from && s.withheld !== "undeclared").length;
}

export type WithholdReason = "undeclared" | "pattern" | "needs-withheld";

export interface PlannedSkill {
  name: string;
  /** Which package it came from, as `name@version`. */
  from: string;
  sourcePath: string;
  targetPath: string;
  /** Exactly what would be written — the file verbatim, or the file plus a commented note. */
  content: string;
  /** The declared ceiling, empty when the declaration is absent or unusable. */
  ceiling: Capability[];
  withheld: WithholdReason | null;
  /** e.g. a sub-tool pattern pi's `--tools` cannot express. Reported, never reinterpreted. */
  notes: string[];
}

export interface InitPlan {
  skills: PlannedSkill[];
  /** Definitions two packages both declare. First wins; the loser is named rather than silently dropped. */
  collisions: string[];
  /** The live grant — what `source .pi/grants.env` actually sets. */
  grant: Capability[];
  /** Withheld capability → the definitions that declared it (ADR-0029). Emitted commented. */
  withheldCapabilities: Map<Capability, string[]>;
  /** `workspace:<id>` this project could route to (ADR-0035). Always commented — `init` does not choose. */
  routableWorkspaces: Capability[];
  grantEnvPath: string;
  grantEnvContent: string;
  /** Capabilities a declared ceiling names that pi 0.84.1 has no tool for — a caution, not a verdict. */
  cautions: string[];
}

const PLACEHOLDER = [
  "# pi-daddy: this skill declares no `allowed-tools`, so it CANNOT be spawned as a governed sub-agent —",
  "# an undeclared capability set is treated as NONE, never as everything. Decide what it needs, then",
  "# uncomment and complete the line below. pi-daddy does not choose this for you: the capability set is",
  "# the thing you are meant to review and commit.",
  "# pi 0.84.1's tools: " + PI_BUILTIN_TOOLS.join(", ") + ".",
  "# allowed-tools: <list the tools this skill needs, e.g. Read, Grep>",
];

/**
 * A copied file that is unspawnable for a reason an operator cannot see by reading it.
 *
 * The undeclared case got four explanatory lines from the start; a pattern-carrying one got nothing, so
 * opening `.pi/skills/git-ops/SKILL.md` to find out why it will not spawn showed a perfectly ordinary file.
 * Same argument, opposite treatment — now the same treatment.
 */
const patternNote = (patterns: string[]) => [
  "# pi-daddy: this skill CANNOT be spawned as a governed sub-agent. Its `allowed-tools` restricts a tool",
  `# with a pattern (${patterns.join(", ")}), and pi's --tools matches whole tool names only — granting the`,
  "# bare tool would widen the declaration and dropping it would silently narrow, so neither is done.",
  "# Replace the pattern with whole tool names to make it spawnable.",
];

/**
 * The file to write for one skill: verbatim when it declares a usable ceiling, plus a commented note when
 * it does not.
 *
 * Inserted at the END of the frontmatter block, so the rest of the file — including its own key order and
 * its body — is byte-identical to the package's. A `#` line is a YAML comment and this package's
 * frontmatter reader skips it, so an undeclared copy is still *undeclared*: not spawnable until a human
 * edits it, which is the whole point.
 */
export function withPlaceholder(text: string, declared: boolean, note: string[] = PLACEHOLDER): string {
  if (declared) return text;
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
  // No frontmatter at all means `parseSkillDefinition` returned null and this skill was never discovered;
  // inventing one here would invent a file shape. Left exactly as it is.
  if (!match) return text;
  const [full, opening, body, close] = match;
  const eol = close.startsWith("\r\n") ? "\r\n" : "\n";
  return opening + body + eol + note.join(eol) + close + text.slice(full.length);
}

/** `tool:` ids pi 0.84.1 has no tool for. `delegate` is this package's own, hence the exemption. */
function unknownToolIds(capabilities: Capability[]): Capability[] {
  const builtins = new Set<string>(PI_BUILTIN_TOOLS);
  return capabilities.filter(
    (c) => c.startsWith("tool:") && c !== ALWAYS_LIVE && !builtins.has(c.slice("tool:".length)),
  );
}

/**
 * Decide what `init` would write. Pure: no filesystem, no npm, no decisions taken on the operator's behalf.
 *
 * The grant is **the read-only part** of what the copied skills declare, plus one `agent:` id per definition
 * that can actually run within it, plus `tool:delegate` — without which the session registers no delegation
 * tools at all and the whole file is inert. Everything else is emitted commented, named, and one uncomment
 * away (ADR-0029).
 */
export function planInit(
  packages: SkillPackage[],
  cwd: string,
  /**
   * Ids from the operator's workspace registry, when one is configured — read by the CALLER, because
   * `planInit` is pure and stays that way.
   *
   * ADR-0035 made routing a capability and said `init` "scaffolds the registered ids so the common path is a
   * one-line grant edit". It did not: `init` had never heard of the registry, so the ADR's own stated
   * migration path for a breaking change did not exist. These are emitted **commented**, never live —
   * offering the ids while refusing to choose among them is exactly ADR-0028's position.
   */
  registeredWorkspaceIds: readonly string[] = [],
): InitPlan {
  const skills: PlannedSkill[] = [];
  const collisions: string[] = [];
  const seen = new Set<string>();

  for (const pkg of packages) {
    for (const skill of pkg.skills) {
      const name = skill.definition.name;
      if (seen.has(name)) {
        collisions.push(`${name} (also in ${pkg.name}@${pkg.version}, not written)`);
        continue;
      }
      seen.add(name);

      const ceiling = ceilingForDefinition(skill.definition);
      const notes: string[] = [];
      let withheld: WithholdReason | null = null;
      let note = PLACEHOLDER;
      if (ceiling.undeclared) withheld = "undeclared";
      else if (ceiling.patterns.length > 0) {
        withheld = "pattern";
        note = patternNote(ceiling.patterns);
        notes.push(
          `declares ${ceiling.patterns.join(", ")} — pi's --tools matches whole tool names only, so a ` +
            `sub-tool pattern is refused rather than reinterpreted (granting the bare tool would widen it)`,
        );
      }

      skills.push({
        name,
        from: `${pkg.name}@${pkg.version}`,
        sourcePath: skill.path,
        targetPath: join(cwd, ".pi", "skills", name, "SKILL.md"),
        content: withPlaceholder(skill.text, withheld === null, note),
        ceiling: ceiling.capabilities,
        withheld,
        notes,
      });
    }
  }

  // ADR-0029: split what the declared ceilings ask for into what `init` grants live and what it comments.
  const declared = skills.filter((s) => s.withheld === null);
  const withheldCapabilities = new Map<Capability, string[]>();
  for (const skill of declared) {
    for (const capability of skill.ceiling) {
      if (isLiveByDefault(capability)) continue;
      // A routing destination is withheld but does NOT belong in this map, and the difference is not
      // cosmetic. This map drives two things: the "WITHHELD BY DEFAULT — these can change your machine"
      // block, and `/grants init`'s dialog. Review found a `workspace:` id reaching both — described to the
      // operator with `tool:bash`'s rationale (routing does not change your machine, and unlike `bash` it
      // *is* gateable), and then granted **live and persisted** on one "Yes", off a third-party package's
      // declaration. That is the rule `grant-env.ts` states — "does not become live because a package asked
      // for it" — honoured by the rendered file and broken by the dialog beside it: two surfaces of one
      // command disagreeing, which is R-28's shape inside the fix for R-28.
      //
      // Which worktree a child starts in is not derivable from a declaration (ADR-0028), so `init` lists
      // routing and never grants it. `routableWorkspaces` below is where these go; the definition that
      // declared one still loses its live `agent:` id via the `needs-withheld` pass, so nothing becomes
      // spawnable behind the operator's back either.
      if (capability.startsWith("workspace:")) continue;
      withheldCapabilities.set(capability, [...(withheldCapabilities.get(capability) ?? []), skill.name]);
    }
  }

  // A definition needing a withheld capability does not get a live `agent:` id either: authorising it to run
  // and then refusing it at spawn time is a worse answer than not authorising it, and it would put an
  // `agent:` id in the grant whose definition cannot work — the shape ADR-0028 rule 3 already refuses.
  for (const skill of declared) {
    if (skill.ceiling.some((c) => !isLiveByDefault(c))) skill.withheld = "needs-withheld";
  }

  const authorised = skills.filter((s) => s.withheld === null);
  const written = new Set(authorised.map((s) => s.name));
  // `agent:<other>` in a ceiling is legitimate — it is how a delegator learns which definitions IT may
  // spawn — but a name `init` did not write here would authorise a file from another skill root that the
  // operator is not reviewing, including `~/.pi/agent/skills`, which other tools install into. Reported,
  // never granted: the same objection ADR-0028 rule 3 makes to authorising an undeclared skill.
  const crossReferences: { from: string; capability: Capability }[] = [];
  const live = new Set<Capability>([ALWAYS_LIVE]);
  for (const skill of authorised) {
    live.add(agentCapability(skill.name));
    for (const capability of skill.ceiling) {
      if (capability.startsWith("agent:") && !written.has(capability.slice("agent:".length))) {
        crossReferences.push({ from: skill.name, capability });
        continue;
      }
      live.add(capability);
    }
  }
  const grant = [...live].sort();

  const cautions = authorised.flatMap((s) =>
    unknownToolIds(s.ceiling).map(
      (c) =>
        `${s.name} declares ${c}, which pi 0.84.1 has no tool for — unless an extension provides it, ` +
        `spawning ${s.name} is refused as an unknown capability`,
    ),
  );

  // R-78's structural backstop. Throws rather than rendering something a shell could read as more than a
  // value, so a gap in the per-entry whitelist costs a refusal instead of an injection.
  assertGrantIsWritable(grant);

  const describe: Record<WithholdReason, (s: PlannedSkill) => string> = {
    undeclared: (s) => "declares no `allowed-tools` — fill it in, then add `agent:" + s.name + "` below",
    pattern: (s) => s.notes.join("; "),
    "needs-withheld": (s) =>
      `needs ${s.ceiling.filter((c) => !isLiveByDefault(c)).join(", ")}, withheld by default — see below`,
  };

  const grantEnvSkills: GrantEnvSkill[] = skills.map((s) => ({
    name: s.name,
    ceiling: s.ceiling,
    ...(s.withheld ? { unspawnable: describe[s.withheld](s) } : {}),
  }));

  // Registry ids the operator could route to, plus any a copied definition actually declares — a package
  // naming `workspace:prod` is evidence that id matters here, and it must still be uncommented by hand.
  const declaredWorkspaces = skills.flatMap((s) => s.ceiling.filter((c) => c.startsWith("workspace:")));
  const routableWorkspaces = [
    ...new Set([...registeredWorkspaceIds.map(workspaceCapability), ...declaredWorkspaces]),
  ].sort();

  return {
    skills,
    collisions,
    grant,
    withheldCapabilities,
    routableWorkspaces,
    grantEnvPath: join(cwd, ".pi", "grants.env"),
    grantEnvContent: renderGrantEnv({
      skills: grantEnvSkills,
      live: grant,
      withheld: withheldCapabilities,
      withheldDefinitions: skills.filter((s) => s.withheld === "needs-withheld").map((s) => s.name),
      crossReferences,
      cautions,
      routableWorkspaces,
    }),
    cautions,
  };
}

export interface InitOutcome {
  written: string[];
  /** Present already, so left alone. `init` never silently overwrites an edited ceiling. */
  kept: string[];
  failed: { path: string; error: string }[];
}

/**
 * Create a file only if nothing is there, and **never through a symlink**.
 *
 * Both properties come from `O_CREAT|O_EXCL` (`flag: "wx"`), and both were defects in the first version
 * (R-79). It probed for existence with `readFile` and then called `writeFile`:
 *
 *  - `readFile` conflates *unreadable* with *absent*, so an operator's `SKILL.md` with restrictive
 *    permissions was reported `wrote` and their narrowed `allowed-tools: Read` was replaced by the
 *    package's wider one — **without `--force`**, falsifying this package's own documented "Kept" rule.
 *    A FIFO at the target path hung the probe forever, with no timeout anywhere in the path.
 *  - `writeFile` follows symlinks, so a dangling symlink at a target path created the file at the link's
 *    destination, outside the project, while reporting an in-project path. That is **B-I6**, which
 *    `approval-store.ts` already fixed for the approval store under ADR-0014 — a new writer in the same
 *    package reintroducing a defect the package documents as closed, and whose comment says in so many
 *    words *"never through a symlink"*.
 *
 * `wx` fails with `EEXIST` on anything at the path, including a dangling symlink, so there is no probe, no
 * race between the probe and the write, and no way to write through a link.
 */
async function createUnlessPresent(path: string, content: string, outcome: InitOutcome): Promise<void> {
  try {
    await mkdir(join(path, ".."), { recursive: true });
    const handle = await open(path, "wx");
    await runWithFinalizers(
      () => handle.writeFile(content, "utf8"),
      [{ label: "new-file handle cleanup failed", run: () => handle.close() }],
    );
    outcome.written.push(path);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") outcome.kept.push(path);
    else outcome.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Replace a file, unlinking first so a symlink is REPLACED rather than written through. */
async function replace(path: string, content: string, outcome: InitOutcome): Promise<void> {
  try {
    await mkdir(join(path, ".."), { recursive: true });
    // `rm` unlinks the LINK, never its target — which is exactly the semantics `--force` should have.
    await rm(path, { force: true });
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    outcome.written.push(path);
  } catch (error) {
    outcome.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Apply a plan.
 *
 * **Existing files are kept, not overwritten**, and that default is load-bearing rather than polite: the
 * edit an operator makes to one of these files IS the capability decision, and the second run of a
 * scaffolding command is exactly when it would be destroyed.
 *
 * **`--force` never regenerates `.pi/grants.env`** (R-79). It rewrites the definition copies, which is the
 * documented re-sync path for R-74 — but the grant file is the *reviewed artifact*, and an operator who had
 * deleted `agent:build` and added a ledger path would have had both silently restored to generated defaults
 * by a command whose usage text mentions only `allowed-tools`. Deleting the file is how to regenerate it,
 * and that is not something anyone does by accident.
 */
export async function applyInit(plan: InitPlan, options: { force?: boolean } = {}): Promise<InitOutcome> {
  const outcome: InitOutcome = { written: [], kept: [], failed: [] };
  const force = options.force === true;
  for (const skill of plan.skills) {
    if (force) await replace(skill.targetPath, skill.content, outcome);
    else await createUnlessPresent(skill.targetPath, skill.content, outcome);
  }
  await createUnlessPresent(plan.grantEnvPath, plan.grantEnvContent, outcome);
  return outcome;
}
