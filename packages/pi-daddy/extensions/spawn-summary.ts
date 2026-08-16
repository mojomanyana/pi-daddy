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
 * **Decided by the real planner, and — since a reviewer caught it — no longer re-classified afterwards.**
 * The first version read two fields of `plan.result` and invented a category from them, which is the very
 * thing this header claimed to have made inexpressible: `planDelegation` has six refusals that leave both
 * fields empty, so a session at its depth limit, or one with a malformed `PI_GRANTS_MAX_DEPTH`, was told its
 * **files** were written wrong while `/grants` in the same session said "delegation is disabled (maxDepth
 * 0)". That is R-28's shape inside the fix for R-28's shape. The planner's own `reason` is now printed for
 * anything the two designated signals do not explain.
 *
 * **What this does not establish.** It runs at `session_start`, before the first provider request, so the
 * grant it classifies against is the one *inherited*; `deriveOwnGrant` narrows it to the observed tool
 * surface only when a request is made, and a definition counted spawnable here can be refused afterwards if
 * its ceiling names a tool this session turns out not to have (R-75, measured live). It is an upper bound,
 * and `/grants` run after any request is the settled answer.
 */

import type { SkillDefinition } from "../src/definitions.ts";
import type { GatedPlan } from "./run-delegation.ts";

/** Why a definition is not spawnable right now. Three causes, three different fixes. */
export type WithheldReason =
  /** The grant lacks `agent:<name>`, or lacks a tool the ceiling declares. Fix: widen `PI_GRANTS_GRANT`. */
  | "capability"
  /** Everything is held, but a gated capability needs a human yes first. Fix: spawn it and answer. */
  | "approval"
  /** Anything else the planner refused — the file, an unknown capability, an unresolvable skill. */
  | "declaration";

export interface WithheldDefinition {
  name: string;
  reason: WithheldReason;
  /** The capabilities that caused it, when the planner named any. */
  missing: string[];
  /** The planner's own words, used verbatim when the two designated signals do not explain the refusal. */
  reasonText?: string;
}

export interface SpawnableSummary {
  spawnable: string[];
  withheld: WithheldDefinition[];
  /**
   * Set when NOTHING can be spawned for a reason about the SESSION rather than about any definition — no
   * `tool:delegate`, or a depth bound that forbids spawning. Per-definition work is skipped entirely.
   */
  sessionBlocked?: string;
  /** Definitions beyond `PREVIEW_LIMIT`, counted but not classified. Stated, never silently dropped. */
  notChecked: number;
}

/** Names listed per clause before the rest are counted instead. Whatever is dropped is stated (R-48). */
const NAMES_SHOWN = 8;

/**
 * How many definitions the startup line classifies.
 *
 * `/grants` has had the same cap from the start, with the comment *"Each one runs the real planner, so this
 * bounds work, not truth"*; this path removed it and put the work on the blocking `session_start` hook.
 * Measured by a reviewer: 1000 definitions against 1000 stored approvals cost **1.66s at every session
 * start**, because a gate-blocked definition re-reads and re-verifies the whole approvals file. 50
 * definitions cost 7ms, which is the real world — but a bound that only holds for the real world is not a
 * bound, and this one is paid by every governed child too, including `--print` children that discard the
 * output.
 */
const PREVIEW_LIMIT = 24;

export interface SessionFacts {
  /** False when the grant omits `tool:delegate`: no `delegate` tool is registered at all (S-5). */
  mayDelegate: boolean;
  depth: number;
  maxDepth: number;
}

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
  session: SessionFacts,
): Promise<SpawnableSummary> {
  const names = [...definitions.keys()].sort();

  // Two session-level facts make every per-definition verdict identical and misleading, so they are
  // answered before any planning happens. Previewing N definitions to print N copies of one environment
  // problem is both wrong and wasteful.
  //
  // `mayDelegate` is the one a reviewer caught: `registerDelegationTools` returns early without it, so the
  // session has NO `delegate` tool and can spawn nothing — while this line said `1 of 3 spawnable`. That is
  // the exact question the line exists to answer, answered wrong in the one configuration where nothing can
  // ever run. Not R-75: no later event changes it, and it is wrong from the first millisecond.
  if (!session.mayDelegate) {
    return {
      spawnable: [],
      withheld: [],
      notChecked: 0,
      sessionBlocked:
        `this session holds no tool:delegate, so it has no delegate tool at all — nothing can be spawned, ` +
        `whatever any definition declares. Add tool:delegate to PI_GRANTS_GRANT to make this session a ` +
        `delegator rather than a leaf.`,
    };
  }
  if (session.maxDepth <= 0 || session.depth + 1 > session.maxDepth) {
    return {
      spawnable: [],
      withheld: [],
      notChecked: 0,
      sessionBlocked:
        session.maxDepth <= 0
          ? `spawning is disabled for this session (max depth ${session.maxDepth}), so no definition can ` +
            `run whatever its file says. If you did not set PI_GRANTS_MAX_DEPTH to 0, check the warning ` +
            `above: a malformed value disables spawning deliberately.`
          : `this session is at its depth limit (${session.depth} of ${session.maxDepth}), so it may not ` +
            `spawn — a definition refused here is not a problem with its file.`,
    };
  }

  const spawnable: string[] = [];
  const withheld: WithheldDefinition[] = [];

  for (const name of names.slice(0, PREVIEW_LIMIT)) {
    const { plan } = await preview(name);
    if (plan.ok) {
      spawnable.push(name);
      continue;
    }
    // Read off the plan's own result, in the order `planDelegation` decides them: an escalation is reported
    // before a gate, because a capability the session does not hold cannot be approved into existence.
    // `denied` carries the ADR-0017 authorisation refusal too — asking to run a definition this session was
    // not granted IS an attempt to exceed the grant, and it is recorded as one.
    const denied = plan.result.denied;
    const gated = plan.result.gatedBlocked;
    if (denied.length > 0) withheld.push({ name, reason: "capability", missing: [...denied].sort() });
    else if (gated.length > 0) withheld.push({ name, reason: "approval", missing: [...gated].sort() });
    // Everything else: say what the ENFORCER said. Inventing a category here is what told an operator with
    // an unknown capability, an unresolvable `skill:`, or a universal capability that their file was
    // written wrong, in wording that contradicted `/grants` on the same screen.
    else withheld.push({ name, reason: "declaration", missing: [], reasonText: plan.reason });
  }

  return { spawnable, withheld, notChecked: Math.max(0, names.length - PREVIEW_LIMIT) };
}

/** `a, b, c` — or the first few and a count, so a large skill root does not become the whole line. */
function list(names: string[]): string {
  if (names.length <= NAMES_SHOWN) return names.join(", ");
  return `${names.slice(0, NAMES_SHOWN).join(", ")} … and ${names.length - NAMES_SHOWN} more`;
}

/**
 * A definition name is a DIRECTORY name, so it is third-party text on a line this package composes.
 *
 * R-77 and R-78 were both "a name from somewhere else reached a generated artefact"; a newline here forges
 * a whole `grants:` line in the operator's terminal. Same class, lower stakes, same treatment: rendered
 * inert rather than trusted.
 */
function safeName(name: string): string {
  return /[\n\r\t]/.test(name) ? JSON.stringify(name) : name;
}

/**
 * Render the summary, or `null` when there is nothing to say.
 *
 * `null` means **no definitions were discovered at all** — a session delegating by `tools:` only, which is
 * a legitimate configuration and not something to report every start. Every other case speaks, including
 * "none of them is spawnable": that is P2's exact state (seven skills installed, zero declaring
 * `allowed-tools`), and it is the one an operator most needs told.
 */
export function renderSpawnableSummary(summary: SpawnableSummary, total: number): string | null {
  if (total === 0) return null;
  if (summary.sessionBlocked) {
    return `grants: ${total} definition${total === 1 ? "" : "s"} found, none spawnable — ${summary.sessionBlocked}`;
  }

  const lines = [
    `grants: ${summary.spawnable.length} of ${total} definition${total === 1 ? "" : "s"} spawnable` +
      (summary.spawnable.length > 0 ? ` — ${list(summary.spawnable.map(safeName))}` : ""),
  ];

  // PER DEFINITION, not per group. Grouping printed the UNION of every missing capability against every
  // name in the group, so a definition missing only `agent:x` was reported as needing `tool:bash` as well —
  // and naming the fix is this line's whole stated purpose.
  const clause = (w: WithheldDefinition): string => {
    const name = safeName(w.name);
    if (w.reason === "capability") return `${name} (needs ${list(w.missing)})`;
    // ADR-0024: a gated `agent:` id is the PARENT's authority to run the definition now, and is deliberately
    // kept out of what the child receives. "before a child receives it" was wrong for exactly that case.
    if (w.reason === "approval") return `${name} (needs your approval for ${list(w.missing)})`;
    return `${name} (${w.reasonText ?? "cannot be spawned as its file is written"})`;
  };

  if (summary.withheld.length > 0) {
    const shown = summary.withheld.slice(0, NAMES_SHOWN).map(clause);
    const extra = summary.withheld.length - shown.length;
    lines.push(`  withheld: ${shown.join("; ")}${extra > 0 ? `; … and ${extra} more` : ""}`);
  }
  if (summary.notChecked > 0) {
    lines.push(`  ${summary.notChecked} more not checked (first ${PREVIEW_LIMIT} only) — /grants lists them`);
  }

  return lines.join("\n");
}
