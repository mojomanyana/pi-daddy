/**
 * "What can this session actually spawn?" — answered at session start, out loud (B1, P4).
 *
 * The startup line reported the *grant* and nothing else: `holding [agent:review, tool:read, …]`. An
 * operator who has just installed a package of `SKILL.md` definitions cannot tell from that whether the
 * install worked, whether their grant names the right ids, or whether anything at all is spawnable — and
 * the failure they are most likely to be in (a definition declaring no `allowed-tools`, so it is discovered
 * and refused) looks exactly like the success. **The withheld half is the important half**: it is the
 * difference between "governance is working" and "did the install fail?".
 *
 * **Classified by the real planner, never by a second reading of the rules.** `summariseSpawnable` takes a
 * preview function and does nothing but count and phrase what it returns — the same `planWithApprovals` the
 * `/grants` listing and a real `delegate` come through, with `ctx: null` so no human is ever asked. That is
 * R-28's lesson kept structural: this package has twice shipped a diagnostic that disagreed with the
 * enforcer (R-28, then R-38), and both times the diagnostic had its own copy of the reasoning.
 *
 * **What this does not establish.** It runs at `session_start`, before the first provider request, so the
 * grant it classifies against is the one *inherited* — `deriveOwnGrant` narrows it to the observed tool
 * surface only when a request is made, and a definition counted spawnable here can be refused afterwards if
 * its ceiling names a tool this session turns out not to have. The line is an upper bound, and `/grants`
 * (run after any request) is the settled answer. Nor does it say a spawn would *succeed*: it says the grant,
 * the ceiling and the gate would let it start.
 */

import type { SkillDefinition } from "../src/definitions.ts";
import type { GatedPlan } from "./run-delegation.ts";

/** Why a definition is not spawnable right now. Three causes, three different fixes. */
export type WithheldReason =
  /** The grant lacks `agent:<name>`, or lacks a tool the ceiling declares. Fix: widen `PI_GRANTS_GRANT`. */
  | "capability"
  /** Everything is held, but a gated capability needs a human yes first. Fix: spawn it and answer. */
  | "approval"
  /** The file itself: no `allowed-tools`, a sub-tool pattern, an unknown capability. Fix: edit the file. */
  | "declaration";

export interface WithheldDefinition {
  name: string;
  reason: WithheldReason;
  /** The capabilities that caused it, when the planner named any. Empty for `declaration`. */
  missing: string[];
}

export interface SpawnableSummary {
  spawnable: string[];
  withheld: WithheldDefinition[];
}

/** Names listed per group before the rest are counted instead. Whatever is dropped is stated (R-48). */
const NAMES_SHOWN = 8;

/**
 * Classify every discovered definition by running the real planner over it.
 *
 * `preview` is `planWithApprovals(session, {agent: name, …}, {}, null)` — the enforcing path minus the one
 * thing a startup line must not do, which is ask a human. Stored approvals count exactly as they would for
 * a spawn, so a definition covered by a standing 30-day yes is reported spawnable, which is what it is.
 */
export async function summariseSpawnable(
  definitions: Map<string, SkillDefinition>,
  preview: (name: string) => Promise<GatedPlan>,
): Promise<SpawnableSummary> {
  const spawnable: string[] = [];
  const withheld: WithheldDefinition[] = [];

  for (const name of [...definitions.keys()].sort()) {
    const { plan } = await preview(name);
    if (plan.ok) {
      spawnable.push(name);
      continue;
    }
    // Read off the plan's own result, in the order `planDelegation` decides them: an escalation is
    // reported before a gate, because a capability the session does not hold cannot be approved into
    // existence. `denied` carries the ADR-0017 authorisation refusal too — asking to run a definition this
    // session was not granted IS an attempt to exceed the grant, and it is recorded as one.
    const denied = plan.result.denied;
    const gated = plan.result.gatedBlocked;
    if (denied.length > 0) withheld.push({ name, reason: "capability", missing: [...denied].sort() });
    else if (gated.length > 0) withheld.push({ name, reason: "approval", missing: [...gated].sort() });
    else withheld.push({ name, reason: "declaration", missing: [] });
  }

  return { spawnable, withheld };
}

/** `a, b, c` — or the first few and a count, so a large skill root does not become the whole line. */
function list(names: string[]): string {
  if (names.length <= NAMES_SHOWN) return names.join(", ");
  return `${names.slice(0, NAMES_SHOWN).join(", ")} … and ${names.length - NAMES_SHOWN} more`;
}

/**
 * Render the summary, or `null` when there is nothing to say.
 *
 * `null` means **no definitions were discovered at all** — a session delegating by `tools:` only, which is
 * a legitimate configuration and not something to report every start. Every other case speaks, including
 * "none of them is spawnable": that is P2's exact state (seven skills installed, zero declaring
 * `allowed-tools`), and it is the one an operator most needs told. The handoff proposed printing only when
 * at least one was spawnable, which would have been silent for precisely that operator.
 */
export function renderSpawnableSummary(summary: SpawnableSummary): string | null {
  const total = summary.spawnable.length + summary.withheld.length;
  if (total === 0) return null;

  const lines = [
    `grants: ${summary.spawnable.length} of ${total} definition${total === 1 ? "" : "s"} spawnable` +
      (summary.spawnable.length > 0 ? ` — ${list(summary.spawnable)}` : ""),
  ];

  const groups: { reason: WithheldReason; phrase: (missing: string[]) => string }[] = [
    {
      reason: "capability",
      phrase: (missing) => `need${missing.length > 0 ? ` ${list(missing)}` : " capabilities"}, which this session does not hold`,
    },
    { reason: "approval", phrase: (missing) => `need your approval for ${list(missing)} before a child receives it` },
    {
      reason: "declaration",
      phrase: () => "cannot be spawned as their files are written — /grants names the file and the reason",
    },
  ];

  for (const group of groups) {
    const members = summary.withheld.filter((w) => w.reason === group.reason);
    if (members.length === 0) continue;
    const missing = [...new Set(members.flatMap((m) => m.missing))].sort();
    lines.push(`  withheld: ${list(members.map((m) => m.name))} — ${group.phrase(missing)}`);
  }

  return lines.join("\n");
}
