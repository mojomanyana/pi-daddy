/**
 * The `.pi/grants.env` an operator reads, edits and commits — and what `init` refuses to put in it live.
 *
 * Split out of `init.ts` when ADR-0029's grant-width rule pushed that file past the 400-line ceiling and
 * `test/file-size.test.ts` refused it. The seam is the natural one: `init.ts` decides *what is true about
 * the installed packages*, this file decides *how that is presented to a human for review*.
 *
 * **ADR-0029.** `init` used to emit the union of every declared ceiling as a live grant. A critic's reading
 * killed it in one sentence: the handoff's safety argument for a third party authoring `allowed-tools` is
 * that *"the operator's `PI_GRANTS_GRANT` still bounds it"* — and a generated union makes the bound and the
 * bounded have the same author, who is not the operator. So capabilities that can change a machine are
 * emitted **commented**, with the definitions that need them named. `init` + `source` yields a working
 * read-only setup; the wide ones cost one deliberate uncomment.
 *
 * That is a decision about the **starting grant**, which is a stronger act than choosing a ceiling and is
 * why it needed its own ADR rather than a paragraph in ADR-0028.
 */

import { DELEGATE_CAPABILITY } from "./capabilities.ts";
import { DEFAULT_GATED } from "./propagation.ts";
import { UNIVERSAL_CAPABILITIES, type Capability } from "./resolve.ts";

/**
 * Capabilities `init` will never put LIVE in a generated grant.
 *
 * **This list is a judgement, and it is written down in one place so it can be argued with** — which is the
 * whole reason ADR-0029 exists. The rule behind it: a capability that can *change the machine* or *execute*
 * does not become live because a package asked for it. Everything else (reading, searching, listing) does.
 *
 *  - `DEFAULT_GATED` — whatever a governed session already asks a human about. Today `tool:bash`, and taking
 *    it from there rather than restating it means the two cannot drift apart.
 *  - `tool:write`, `tool:edit`, `tool:edit-diff` — mutate the working tree, and **are not gated by default**,
 *    so a source-and-go operator would hand them to a child with no dialog at all. That gap is exactly what
 *    made "the union is mitigated by gating" untrue (R-76).
 *  - `UNIVERSAL_CAPABILITIES` — confer the whole catalog by measurement (`docs/probes/pi-fabric-eval`).
 *    `assertNarrowing` refuses a grant containing one anyway; leaving it out of the file keeps the operator
 *    from ever holding it by accident.
 */
export const WITHHELD_BY_DEFAULT: readonly Capability[] = [
  ...new Set([...DEFAULT_GATED, "tool:write", "tool:edit", "tool:edit-diff", ...UNIVERSAL_CAPABILITIES]),
];

/** Would `init` put this capability in the live grant? */
export function isLiveByDefault(capability: Capability): boolean {
  // No `workspace:<id>` is ever live by default (ADR-0035), and this is the same rule the list above states
  // rather than a new one: authority "does not become live because a package asked for it". A registry id is
  // a *choice of where a child runs*, which is the operator's to make and cannot be inferred from a
  // declaration — ADR-0028's whole position. Enumerated ids are unbounded, so this is a namespace test and
  // not a list membership.
  if (capability.startsWith("workspace:")) return false;
  return !WITHHELD_BY_DEFAULT.includes(capability);
}

/**
 * Every character allowed in a generated `PI_GRANTS_GRANT` value.
 *
 * **A structural backstop, not the main defence** (R-78). The per-entry whitelist in `skill-packages.ts` is
 * what refuses a hostile capability id; this refuses to write the FILE AT ALL if anything unexpected reached
 * the string regardless. R-77 and R-78 were the same defect found twice, on two channels into one
 * interpolation, so the third channel — whatever it turns out to be — should cost a refusal rather than an
 * injection. A guard that depends on my enumeration being complete is not a guard.
 */
const GRANT_VALUE = /^[A-Za-z0-9:@,._/-]*$/;

export class UnsafeGrantError extends Error {}

/** Throw rather than write a grant string that could mean something to a shell. */
export function assertGrantIsWritable(grant: Capability[]): void {
  const value = grant.join(",");
  if (!GRANT_VALUE.test(value)) {
    throw new UnsafeGrantError(
      `refusing to write .pi/grants.env: the assembled grant contains characters that are not part of a ` +
        `capability id (${JSON.stringify(value)}). This file is meant to be sourced by a shell, so it is ` +
        `not written at all rather than written unsafely. Report this — a declared capability reached the ` +
        `grant that should have been refused at discovery.`,
    );
  }
}

/** One definition's declared ceiling, as far as the grant file is concerned. */
export interface GrantEnvSkill {
  name: string;
  ceiling: Capability[];
  /** Present when the definition cannot be spawned at all; the string is why, for the reader. */
  unspawnable?: string;
}

export interface GrantEnvInput {
  skills: GrantEnvSkill[];
  /** Capabilities emitted live. */
  live: Capability[];
  /** Withheld capability → the definitions that declared it. Emitted commented, for a deliberate uncomment. */
  withheld: Map<Capability, string[]>;
  /** Definitions whose `agent:` id is withheld because they need a withheld capability. */
  withheldDefinitions: string[];
  /** `workspace:<id>` ids this project could route to (ADR-0035). Rendered commented, never granted. */
  routableWorkspaces?: Capability[];
  /** `agent:<name>` ids a ceiling names that `init` did not write here. Reported, never granted. */
  crossReferences: { from: string; capability: Capability }[];
  cautions: string[];
}

/**
 * Render the file.
 *
 * Every capability is annotated with the definition it came from, because the whole claim of this feature is
 * that the capability decision is visible and diffable. A grant nobody can read is a grant nobody reviews.
 */
export function renderGrantEnv(input: GrantEnvInput): string {
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

  const spawnable = input.skills.filter((s) => !s.unspawnable);
  if (spawnable.length > 0) {
    lines.push("# What each definition declares — a child receives this ∩ the grant below:");
    const width = Math.max(...spawnable.map((s) => s.name.length));
    for (const skill of spawnable) {
      lines.push(`#   ${skill.name.padEnd(width)}  ${skill.ceiling.join(", ") || "(nothing — a child with no tools)"}`);
    }
    lines.push("#");
  }

  const unspawnable = input.skills.filter((s) => s.unspawnable);
  if (unspawnable.length > 0) {
    lines.push("# NOT AUTHORISED — pi-daddy refuses to spawn these, so no `agent:` id is granted for them:");
    for (const skill of unspawnable) lines.push(`#   ${skill.name}: ${skill.unspawnable}`);
    lines.push("#");
  }

  // ADR-0029. The wide capabilities, commented, with the definitions that need them named — so authorising
  // one is a deliberate act and reading the file tells you exactly what it buys and what it costs.
  if (input.withheld.size > 0) {
    lines.push(
      "# WITHHELD BY DEFAULT — these can change your machine, so `pi-daddy init` does not grant them.",
      "# Uncomment a capability to authorise it for every child, then add the definitions that need it to",
      "# PI_GRANTS_GRANT below. `tool:bash` is asked about at spawn time as well; `tool:write` and",
      "# `tool:edit` are NOT, so granting them here is the whole decision.",
    );
    const width = Math.max(...[...input.withheld.keys()].map((c) => c.length));
    for (const [capability, needed] of [...input.withheld].sort()) {
      lines.push(`#   ${capability.padEnd(width)}  (${needed.join(", ")})`);
    }
    if (input.withheldDefinitions.length > 0) {
      lines.push(
        `#   …and then: ${input.withheldDefinitions.map((n) => `agent:${n}`).join(",")}`,
        "#   Their `agent:` ids are withheld too: a definition that cannot receive what it declares would",
        "#   be authorised to run and then refused, which is a worse answer than not being authorised.",
      );
    }
    lines.push("#");
  }

  // ADR-0035. Routing became a capability in 0.19.0, which made every existing grant that routes start
  // refusing — so the migration has to be visible from the file the operator already opens. Listed and NOT
  // granted: which worktree a child starts in is the operator's decision and cannot be read off a
  // declaration (ADR-0028), and granting one because a package named it is the "does not become live because
  // a package asked for it" rule that `WITHHELD_BY_DEFAULT` above states.
  if (input.routableWorkspaces && input.routableWorkspaces.length > 0) {
    lines.push(
      "# ROUTABLE WORKSPACES — routing a child to a registered worktree needs the id in PI_GRANTS_GRANT",
      "# (ADR-0035, 0.19.0). Without it a delegation naming one is refused WORKSPACE_NOT_AUTHORIZED. Add the",
      "# ones this project's children may start in; a child can only pass on ids it holds itself, so this is",
      "# also the list of what any DESCENDANT could reach. Not granted for you: `workspace:*` exists but is",
      "# held and never inherited, which makes it the wrong answer for anything but a single-worktree setup.",
    );
    for (const capability of input.routableWorkspaces) lines.push(`#   ${capability}`);
    lines.push("#");
  }

  // A ceiling may legitimately name `agent:<other>` — that is how a delegator is told what IT may spawn.
  // Granting one for a definition `init` did not write would authorise a file from some other skill root
  // that the operator is not reviewing here, which is the same objection rule 3 makes to undeclared skills.
  if (input.crossReferences.length > 0) {
    lines.push("# NOT GRANTED — a definition here names another definition that pi-daddy did not write:");
    for (const ref of input.crossReferences) {
      lines.push(`#   ${ref.from} declares ${ref.capability}, which is not one of the definitions above.`);
    }
    lines.push(
      "#   Add it by hand if you mean it — it would authorise spawning that name from ANY skill root,",
      "#   including ~/.pi/agent/skills, which other tools install into.",
      "#",
    );
  }

  for (const caution of input.cautions) lines.push(`# CAUTION: ${caution}`);
  if (input.cautions.length > 0) lines.push("#");

  lines.push(
    "# tool:delegate is what registers the delegation tools at all — withhold it and this session is a leaf.",
    `export PI_GRANTS_GRANT="${input.live.join(",")}"`,
    "",
    "# Optional. Setting a ledger makes it LOAD-BEARING: a spawn that cannot be recorded is refused.",
    '#export PI_GRANTS_LEDGER=".pi/grants.jsonl"',
    "",
    "# Optional. tool:bash is ALREADY gated by default, so this line only matters if you widen it:",
    "# gating is closed under subsumption, so gating tool:write also gates tool:bash (bash can write).",
    '#export PI_GRANTS_GATED="tool:bash,tool:write"',
    "",
  );

  return lines.join("\n");
}

/** The capability that must always be live, or the generated file is inert (S-5). */
export const ALWAYS_LIVE: Capability = DELEGATE_CAPABILITY;
