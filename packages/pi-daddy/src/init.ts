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
 * placeholder and stays unspawnable until a human fills it in. Generating a file a human approves is
 * governance; deciding on their behalf at spawn time is not, and a suggested-and-uncommented default would
 * be the second thing wearing the first thing's clothes.
 *
 * The placeholder is deliberately not a working example. Uncommenting it unedited yields capability ids
 * like `tool:<list` which the catalog refuses as unknown — a loud failure, in the direction rule 8 asks
 * for, rather than a grant nobody decided.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentCapability, DELEGATE_CAPABILITY } from "./capabilities.ts";
import { ceilingForDefinition } from "./definitions.ts";
import { PI_BUILTIN_TOOLS } from "./pi-tools.ts";
import type { Capability } from "./resolve.ts";
import type { SkillPackage } from "./skill-packages.ts";

/** Why a discovered skill is not authorised in the generated grant. `null` means it is. */
export type WithholdReason = "undeclared" | "pattern";

export interface PlannedSkill {
  name: string;
  /** Which package it came from, as `name@version`. */
  from: string;
  sourcePath: string;
  targetPath: string;
  /** Exactly what would be written — the file verbatim, or the file plus a commented placeholder. */
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
  grant: Capability[];
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
 * The file to write for one skill: verbatim when it declares a ceiling, plus a commented placeholder when
 * it does not.
 *
 * Inserted at the END of the frontmatter block, so the rest of the file — including its own key order and
 * its body — is byte-identical to the package's. A `#` line is a YAML comment and this package's
 * frontmatter reader skips it, so the copy is still *undeclared*: it is not spawnable until a human edits
 * it, which is the whole point.
 */
export function withPlaceholder(text: string, declared: boolean): string {
  if (declared) return text;
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
  // No frontmatter at all means `parseSkillDefinition` returned null and this skill was never discovered;
  // inventing one here would invent a file shape. Left exactly as it is.
  if (!match) return text;
  const [full, open, body, close] = match;
  const eol = close.startsWith("\r\n") ? "\r\n" : "\n";
  return open + body + eol + PLACEHOLDER.join(eol) + close + text.slice(full.length);
}

/** `tool:` ids pi 0.84.1 has no tool for. `delegate` is this package's own, hence the exemption. */
function unknownToolIds(capabilities: Capability[]): Capability[] {
  const builtins = new Set<string>(PI_BUILTIN_TOOLS);
  return capabilities.filter(
    (c) => c.startsWith("tool:") && c !== DELEGATE_CAPABILITY && !builtins.has(c.slice("tool:".length)),
  );
}

/**
 * Decide what `init` would write. Pure: no filesystem, no npm, no decisions taken on the operator's behalf.
 *
 * The grant is the **union of what the declared skills declare**, plus one `agent:` id per skill that can
 * actually be spawned, plus `tool:delegate` — without which the session registers no delegation tools at
 * all and the whole file is inert. Undeclared skills contribute nothing: authorising a definition that
 * refuses every spawn would put a line in the grant that means nothing today and something un-reviewed
 * tomorrow, the moment somebody fills that file in.
 */
export function planInit(packages: SkillPackage[], cwd: string): InitPlan {
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
      if (ceiling.undeclared) withheld = "undeclared";
      else if (ceiling.patterns.length > 0) {
        withheld = "pattern";
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
        content: withPlaceholder(skill.text, !ceiling.undeclared),
        ceiling: ceiling.capabilities,
        withheld,
        notes,
      });
    }
  }

  const authorised = skills.filter((s) => s.withheld === null);
  const grant = [
    ...new Set([
      ...authorised.map((s) => agentCapability(s.name)),
      ...authorised.flatMap((s) => s.ceiling),
      DELEGATE_CAPABILITY,
    ]),
  ].sort();

  const cautions = authorised.flatMap((s) =>
    unknownToolIds(s.ceiling).map(
      (c) =>
        `${s.name} declares ${c}, which pi 0.84.1 has no tool for — unless an extension provides it, ` +
        `spawning ${s.name} is refused as an unknown capability`,
    ),
  );

  return {
    skills,
    collisions,
    grant,
    grantEnvPath: join(cwd, ".pi", "grants.env"),
    grantEnvContent: renderGrantEnv(skills, grant, cautions),
    cautions,
  };
}

/**
 * The `.pi/grants.env` an operator reads before sourcing it.
 *
 * Every capability is annotated with the file it came from, because the whole claim of this package is that
 * the capability decision is visible and diffable. A grant nobody can read is a grant nobody reviews.
 */
function renderGrantEnv(skills: PlannedSkill[], grant: Capability[], cautions: string[]): string {
  const lines = [
    "# .pi/grants.env — written by `pi-daddy init`. REVIEW IT, then commit it.",
    "#",
    "# Every capability below was read from a SKILL.md's own `allowed-tools`. pi-daddy chose none of them:",
    "# a ceiling belongs in a file a human reviews, not in a default applied when a sub-agent is spawned.",
    "# Delete an `agent:` id to withhold that definition; delete a `tool:` id to withhold that tool from",
    "# every child. You cannot grant a child what this session does not hold, so this file is the ceiling",
    "# over the whole delegation tree.",
    "#",
  ];

  const authorised = skills.filter((s) => s.withheld === null);
  if (authorised.length > 0) {
    lines.push("# What each definition declares — a child receives this ∩ the grant below:");
    const width = Math.max(...authorised.map((s) => s.name.length));
    for (const skill of authorised) {
      lines.push(`#   ${skill.name.padEnd(width)}  ${skill.ceiling.join(", ") || "(nothing — a child with no tools)"}`);
    }
    lines.push("#");
  }

  const withheld = skills.filter((s) => s.withheld !== null);
  if (withheld.length > 0) {
    lines.push("# NOT AUTHORISED — pi-daddy refuses to spawn these, so no `agent:` id is granted for them:");
    for (const skill of withheld) {
      const why =
        skill.withheld === "undeclared"
          ? "declares no `allowed-tools` — fill it in, then add `agent:" + skill.name + "` below"
          : skill.notes.join("; ");
      lines.push(`#   ${skill.name}: ${why}`);
    }
    lines.push("#");
  }

  for (const caution of cautions) lines.push(`# CAUTION: ${caution}`);
  if (cautions.length > 0) lines.push("#");

  lines.push(
    "# tool:delegate is what registers the delegation tools at all — withhold it and this session is a leaf.",
    `export PI_GRANTS_GRANT="${grant.join(",")}"`,
    "",
    "# Optional. Setting a ledger makes it LOAD-BEARING: a spawn that cannot be recorded is refused.",
    '#export PI_GRANTS_LEDGER=".pi/grants.jsonl"',
    "",
    "# Optional. tool:bash is gated by default, so a human is asked before any child receives a shell.",
    "# `PI_GRANTS_GATED=\"\"` gates nothing; adding a capability gates that one too (and everything that",
    "# subsumes it — gating write also gates bash, because bash can write).",
    '#export PI_GRANTS_GATED="tool:bash"',
    "",
  );

  return lines.join("\n");
}

export interface InitOutcome {
  written: string[];
  /** Present already, so left alone. `init` never silently overwrites an edited ceiling. */
  kept: string[];
  failed: { path: string; error: string }[];
}

/** Write one file unless it already exists (or `force`), reporting which of the three happened. */
async function writeUnlessPresent(path: string, content: string, force: boolean, outcome: InitOutcome): Promise<void> {
  try {
    if (!force) {
      try {
        await readFile(path, "utf8");
        outcome.kept.push(path);
        return;
      } catch {
        /* absent, so write it */
      }
    }
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
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
 * scaffolding command is exactly when it would be destroyed. `force` exists and says what it costs.
 */
export async function applyInit(plan: InitPlan, options: { force?: boolean } = {}): Promise<InitOutcome> {
  const outcome: InitOutcome = { written: [], kept: [], failed: [] };
  const force = options.force === true;
  for (const skill of plan.skills) await writeUnlessPresent(skill.targetPath, skill.content, force, outcome);
  await writeUnlessPresent(plan.grantEnvPath, plan.grantEnvContent, force, outcome);
  return outcome;
}
