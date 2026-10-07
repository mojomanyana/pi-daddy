/**
 * The reviewable project record (`settings.json` since ADR-0076 PR 3c) — and what `init` refuses to put in it.
 *
 * Split out of `init.ts` when ADR-0029's grant-width rule pushed that file past the 400-line ceiling and
 * `test/file-size.test.ts` refused it. The seam is the natural one: `init.ts` decides *what is true about
 * the installed packages*, this file decides *how that is presented to a human for review*.
 *
 * **ADR-0029.** `init` used to emit the union of every declared ceiling as a live grant. A critic's reading
 * killed it in one sentence: the handoff's safety argument for a third party authoring `allowed-tools` is
 * that *"the operator's `PI_DADDY_GRANT` still bounds it"* — and a generated union makes the bound and the
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
import { PROJECT_FILES } from "./project-paths.ts";

/**
 * Capabilities `init` will never put LIVE in a generated grant.
 *
 * **This list is a judgement, and it is written down in one place so it can be argued with** — which is the
 * whole reason ADR-0029 exists. The rule behind it: a capability that can *change the machine* or *execute*
 * does not become live because a package asked for it. Everything else (reading, searching, listing) does.
 *
 *  - `DEFAULT_GATED` — whatever a governed session already asks a human about. Today `tool:bash`, and taking
 *    it from there rather than restating it means the two cannot drift apart.
 *  - `tool:write`, `tool:edit`, `tool:edit-diff` — mutate the working tree. They used to be named here because
 *    they were NOT gated, so a source-and-go operator handed them to a child with no dialog at all, which is
 *    what made "the union is mitigated by gating" untrue (R-76). They joined `DEFAULT_GATED` on 2026-09-23,
 *    so that gap is closed and this entry is now redundant with the line above rather than load-bearing. It
 *    is kept because the set must not silently follow a future change to the gate list: what `init` withholds
 *    and what a session asks a human about are two decisions that happen to agree today.
 *  - `UNIVERSAL_CAPABILITIES` — confer the whole catalog by measurement (probe `pi-fabric-eval`).
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
 * Every character allowed in a generated `PI_DADDY_GRANT` value.
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
      `refusing to write the grant: the assembled grant contains characters that are not part of a ` +
        `capability id (${JSON.stringify(value)}). The grant is handed to children through their environment, so it is ` +
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
/**
 * Render `.pi/pi-daddy/settings.json`, the reviewable, committable record of a project's ceiling (ADR-0076 PR 3c).
 *
 * It replaced `.pi/grants.env`, which was never machine-read: the root grant comes from the user-level grant
 * store (ADR-0037), and the shell file existed so a human could read and diff the capability decision. That
 * purpose is kept as data: every capability is annotated with the definition it came from, withheld
 * capabilities and definitions are listed with their reasons, and nothing here is advice dressed as a value.
 * `/grants` renders it; PR 6 adds the advisor toggles beside it.
 */
export interface ProjectSettings {
  version: 1;
  writtenBy: "pi-daddy init";
  /** How to read this file, for the human who opens it in a diff. */
  review: string;
  /** The live grant: what `pi-daddy init` found declared and did not withhold. Delete an id to withhold it. */
  grant: Capability[];
  definitions: { name: string; declares: Capability[]; spawnable: boolean; reason?: string }[];
  /** Withheld by default (ADR-0029) → the definitions that declared each. Never granted by init. */
  withheld: { capability: Capability; declaredBy: string[] }[];
  /** Definitions whose `agent:` id is withheld because they need a withheld capability. */
  withheldDefinitions: string[];
  /** `workspace:<id>` ids this project could route to (ADR-0035). Listed, never granted. */
  routableWorkspaces: Capability[];
  /** `agent:<name>` ids a ceiling names that init did not write here. Reported, never granted. */
  crossReferences: { from: string; capability: Capability }[];
  cautions: string[];
  /** The project ledger file name under `.pi/pi-daddy/`; init enables it (ADR-0037). */
  ledger: string;
  /** Gated by default (ADR-0012): closed under subsumption, so gating tool:write also gates tool:bash. */
  gatedByDefault: Capability[];
}

export function buildProjectSettings(input: GrantEnvInput): ProjectSettings {
  return {
    version: 1,
    writtenBy: "pi-daddy init",
    review:
      "Every capability below was read from a SKILL.md's own allowed-tools; pi-daddy chose none of them. " +
      "Review and commit this file. Delete an agent: id from `grant` to withhold that definition, a tool: id to " +
      "withhold that tool from every child. A child never receives more than this grant ∩ its definition.",
    grant: [...input.live],
    definitions: input.skills.map((s) => ({
      name: s.name,
      declares: [...s.ceiling],
      spawnable: !s.unspawnable,
      ...(s.unspawnable ? { reason: s.unspawnable } : {}),
    })),
    withheld: [...input.withheld.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([capability, declaredBy]) => ({ capability, declaredBy: [...declaredBy] })),
    withheldDefinitions: [...input.withheldDefinitions],
    routableWorkspaces: [...(input.routableWorkspaces ?? [])],
    crossReferences: input.crossReferences.map((c) => ({ ...c })),
    cautions: [...input.cautions],
    ledger: PROJECT_FILES.ledger,
    gatedByDefault: ["tool:bash"],
  };
}

export function renderProjectSettings(input: GrantEnvInput): string {
  return JSON.stringify(buildProjectSettings(input), null, 2) + "\n";
}

/** The capability that must always be live, or the generated file is inert (S-5). */
export const ALWAYS_LIVE: Capability = DELEGATE_CAPABILITY;
