/**
 * Approval model for gated capabilities — pure, so it is exhaustively testable without pi.
 *
 * `resolve()` computes `gatedBlocked`: capabilities a session legitimately holds but which may not enter
 * a child's grant without a human saying so. This module decides WHAT a yes means — how far it reaches,
 * how long it lasts, and what it is keyed to. It never performs I/O and never prompts; see
 * `approval-store.ts` and `approval-prompt.ts` for those.
 *
 * ADR-0010 records the four decisions encoded here.
 */

import { WILDCARD } from "./pi-tools.ts";
import type { Capability, ResolveResult } from "./resolve.ts";

/** How far a single yes reaches in time. */
export type ApprovalScope = "once" | "session" | "always";

/** Where a yes came from, for the ledger. These call for different follow-ups, so they stay distinct. */
export type ApprovalSource = "prompt" | "session" | "persisted" | "inherited";

/** Which call site is asking. Determines the scopes offered — see `offeredScopes`. */
export type ApprovalPath = "definition" | "delegate";

/**
 * Subject used for delegate-path approvals.
 *
 * The delegate tool has no human-authored subject: the only things naming a child are the task string and
 * the tool list, both chosen by the model. A key the model controls is not a key, so delegate approvals
 * use this fixed literal — "allow write for delegations this session" — and are never persisted.
 * Angle brackets cannot appear in an agent-type name (`parseAgentType` reads an identifier), so this can
 * never collide with a real type.
 */
export const DELEGATE_SUBJECT = "<delegate>";

/**
 * Lifetime of a persisted approval.
 *
 * Deliberately a constant rather than an environment variable: a knob that silently extends every gate is
 * the first thing an impatient operator would reach for.
 */
export const APPROVAL_TTL_DAYS = 30;

const DAY_MS = 86_400_000;

/** `tool:write` + `docs-writer` -> `tool:write@docs-writer`. */
export function approvalKey(capability: Capability, subject: string): string {
  return `${capability}@${subject}`;
}

/**
 * May this resolution raise an approval dialog?
 *
 * `resolve()` computes `denied` and `gatedBlocked` INDEPENDENTLY (deliberately — each rejection reason is
 * reported rather than masked by whichever filter ran first), and both `decideSpawn` and `planDelegation`
 * refuse outright on `denied` while still attaching the full result. So a request mixing a gated capability
 * with one the session does not hold at all would otherwise prompt a human about the gated one and then be
 * refused anyway for the other.
 *
 * That is not merely noise. A *session* yes is recorded and republished to children, and an *always* yes is
 * written to disk for 30 days — both banked against a spawn that never happened, and both reachable by a
 * model that appends one unheld capability to an otherwise ordinary request. A person is therefore only
 * asked about a spawn that would actually proceed if they said yes.
 *
 * `clipped` is deliberately NOT a bar: it does not refuse a spawn, it just drops those capabilities from
 * the child's grant, so the spawn does proceed and the question is real.
 */
export function shouldSeekApproval(result: ResolveResult | undefined): boolean {
  if (!result) return false;
  if (result.denied.length > 0) return false;
  // ADR-0011. A grant retaining a universal capability is refused by `assertNarrowing` no matter what
  // a human says, so asking is worse than useless: the dialog cannot change the outcome, and a
  // `session`- or `always`-scoped yes given there is banked and reused for later spawns that DO
  // proceed. Same harm the `denied` guard above exists to prevent.
  if (result.universal.length > 0) return false;
  return result.gatedBlocked.length > 0;
}

/**
 * Scopes a given call site may offer. `always` requires a **human-authored subject**.
 *
 * ADR-0019. The rule is unchanged; which paths satisfy it is not. `"interceptor"` used to be the only one
 * and ADR-0016 deleted it, leaving `always` offerable from nowhere — 220 lines of persistence no live path
 * could write to. `"definition"` is `delegate({agent})`, where ADR-0017 makes the subject an
 * operator-authored file the session must hold `agent:<name>` to name at all. `"delegate"` is the `tools:`
 * form, where the original reasoning stands untouched: the only things naming that child are the task and
 * the tool list, both model-chosen, and a key the model controls is not a key.
 */
export function offeredScopes(path: ApprovalPath): ApprovalScope[] {
  return path === "definition" ? ["once", "session", "always"] : ["once", "session"];
}

/**
 * The approval an inheriting child may hold.
 *
 * Intersecting with the child's grant is what keeps ADR-0008 intact once approvals became inheritable:
 * `approved ⊆ grant` at every level, by construction. An approval can therefore never name a capability
 * the session does not hold — it only ever unblocks part of a grant, never widens one.
 *
 * The wildcard is filtered for the same reason `childEnv` filters it out of grants (R-26): inheriting it
 * would let a descendant treat every future gate as pre-approved.
 */
/** An approval as it crosses a boundary: the capability, WHO it was for, and HOW LONG it was meant to last. */
export interface InheritableApproval {
  capability: Capability;
  /** The agent type, or `<delegate>`. Carried because an approval is for a subject, not for a word. */
  subject: string;
  scope: ApprovalScope;
  /**
   * The definition's body digest at the time of approval (ADR-0022). Absent for `<delegate>`, which names
   * no file to hash — and, per ADR-0019, is never persisted or offered `always` for the same reason.
   */
  bodySha256?: string;
}

/**
 * What a child may inherit, as `capability@subject` keys.
 *
 * ADR-0014 changed this in two ways, and both were cases of a human's explicit choice being discarded
 * one hop down:
 *
 *  - **`once` is dropped** (A-S1). The scope chosen was not carried, so a `once` approval was written
 *    into the child's `PI_GRANTS_APPROVED` and republished onward — the most conservative answer a human
 *    can give produced the least conservative outcome, across an entire descendant subtree.
 *  - **The subject is kept** (A-S6). Bare capabilities were published, so a `<delegate>`-subject approval
 *    matched *any* subject below. `approvalKey`'s own doc argues at length that a model-controlled name
 *    is not a key; erasing the subject made that argument moot exactly where it mattered.
 *
 * The clamp to `grant` is unchanged and still load-bearing: **approval cannot conjure a capability**, so
 * an inherited yes is only ever honoured for something the child independently holds.
 */
export function inheritApprovals(approved: InheritableApproval[], grant: Capability[]): string[] {
  const held = new Set(grant);
  return [
    ...new Set(
      approved
        .filter((a) => a.scope !== "once" && a.capability !== WILDCARD && held.has(a.capability))
        // A definition subject MUST carry a pin to cross a boundary (ADR-0022, hardened after F1).
        //
        // `verifyInherited` honours an unpinned entry by decision — `<delegate>` names no file and a
        // pre-0.11 parent sends none — so an unpinned entry for a subject that *does* name a file is an
        // approval exempt from the digest check. Enforcing it at the point of PUBLICATION rather than
        // trusting each caller to attach a digest is what makes it structural: two call sites build these
        // entries, one of them forgot, and every fresh approval crossed unpinned as a result. A caller that
        // cannot produce a digest (the definition is not on disk here) now publishes nothing, which is the
        // fail-closed direction.
        .filter((a) => a.subject === DELEGATE_SUBJECT || Boolean(a.bodySha256))
        .map((a) => approvalKey(a.capability, a.subject) + (a.bodySha256 ? `#${a.bodySha256}` : "")),
    ),
  ].sort();
}

/**
 * Read the inherited set back on the child side.
 *
 * Anything that is not a well-formed `capability@subject` pair is dropped rather than guessed at. An
 * unparseable entry granting nothing is a missing prompt; an unparseable entry granting *something* is a
 * silent escalation, so the direction of the failure is not a matter of taste.
 */
export function parseInherited(raw: string | undefined): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const item of (raw ?? "").split(",")) {
    const trimmed = item.trim();
    // ADR-0022 appends `#<sha256>`. Split it off FIRST: a `#` cannot appear in a capability id or in a
    // definition name (identity comes from a path component), so this is unambiguous.
    const hash = trimmed.indexOf("#");
    const key = hash === -1 ? trimmed : trimmed.slice(0, hash);
    const digest = hash === -1 ? undefined : trimmed.slice(hash + 1);
    const at = key.indexOf("@");
    if (at <= 0 || at === key.length - 1) continue;
    if (hash !== -1 && !digest) continue; // `key#` promises a pin and carries none — drop it, do not guess
    out.set(key, digest);
  }
  return out;
}

/**
 * Drop inherited approvals that were given for different instructions (ADR-0022).
 *
 * The hole this closes: `resolveApprovals` checks `inherited` FIRST and none of it had ever been through
 * `entryVerdict`, so ADR-0019's headline property — an approval is void once the instructions change — held
 * on the one path that persists and neither of the two that do not. A child is a fresh process: it re-reads
 * the definition from disk, so a `git pull` between the parent's approval and the child's spawn meant the
 * child ran a rewritten body under a yes given about the old one, recording `approvalSource: "inherited"`.
 *
 * An entry with **no** digest is honoured, and that is not a hole: `<delegate>` legitimately has none, and
 * neither does a pre-0.11 parent. It is the same trade `entryVerdict` refuses to make for a *persisted*
 * entry — but that entry is 30 days old and read off disk, whereas this one was handed over by a live parent
 * process in the same tree, which is a much shorter chain to trust.
 */
export function verifyInherited(
  parsed: ReadonlyMap<string, string | undefined>,
  snapshotOf: (subject: string) => SubjectSnapshot | null,
): Set<string> {
  const out = new Set<string>();
  for (const [key, digest] of parsed) {
    if (digest === undefined) {
      out.add(key);
      continue;
    }
    const current = snapshotOf(key.slice(key.indexOf("@") + 1));
    if (current && current.bodySha256 === digest) out.add(key);
  }
  return out;
}

/** When an approval granted now stops being valid. Computed once at write time and stored, so an entry's
 *  lifetime is visible in the file rather than implied by whichever version of the code reads it. */
export function expiryFor(approvedAt: Date): string {
  return new Date(approvedAt.getTime() + APPROVAL_TTL_DAYS * DAY_MS).toISOString();
}

/** A persisted approval, keyed externally by subject and capability. Only the `"definition"` path writes one. */
export interface ApprovalEntry {
  approvedAt: string;
  expiresAt: string;
  /** The directory the human was sitting in. See `entryVerdict` and R-27. */
  cwd: string;
  /** The agent type's ceiling AT APPROVAL TIME. Load-bearing, not decorative — see `entryVerdict`. */
  grantAtApproval: Capability[];
  /*
   * `taskAtApproval` was here and is GONE (ADR-0021). It stored the model-authored task string, which
   * `src/ledger.ts` forbids in unqualified terms — "the task is not recorded, anywhere, ever" — and the
   * approval store is a worse home for it than the ledger by ADR-0018's own criteria: always-on, outside
   * the repository, kept for 30 days. It also read as a scope it never was, since the entry authorises ANY
   * task for that definition. Both reviewers found it independently. `approval-store.ts`'s `sanitise`
   * strips it from any entry this version rewrites.
   */
  /**
   * The definition's body digest AT APPROVAL TIME (ADR-0019, using ADR-0018's hash).
   *
   * `grantAtApproval` pins the tools; this pins the INSTRUCTIONS. Without it an `always` approval survives
   * a total rewrite of what the child is told to do, because `ceilingForDefinition` reads only
   * `allowed-tools` — R-35's hazard reappearing inside the persistence layer. Absent means the entry
   * predates 0.10.0 and cannot be verified, which `entryVerdict` treats as changed: fail closed.
   */
  bodyAtApproval?: string;
}

export type EntryVerdict =
  | "valid"
  | "expired"
  | "foreign-cwd"
  | "type-changed"
  | "instructions-changed"
  | "type-missing";

/**
 * What a subject looks like RIGHT NOW — one lookup, not two (ADR-0019).
 *
 * Deliberately a single snapshot rather than parallel `ceilingOf` / `digestOf` callbacks. R-28 was one
 * call site supplying one argument and omitting another; a shape that cannot be half-supplied is the
 * structural form of remembering.
 */
export interface SubjectSnapshot {
  ceiling: Capability[];
  /** SHA-256 of the definition body — `digestDefinition(...).sha256`. */
  bodySha256: string;
}

export interface EntryValidityInput {
  entry: ApprovalEntry;
  /** The directory this session is running in. */
  cwd: string;
  now: Date;
  /** The subject's CURRENT ceiling and body digest, or null when it no longer exists. */
  current: SubjectSnapshot | null;
}

/**
 * Decide whether a persisted approval still means what the human meant.
 *
 * Four ways it can stop meaning that, and each is reported distinctly so `/grants approvals` can explain
 * itself rather than silently showing fewer rows:
 *
 *  - `foreign-cwd`  — the file was copied or committed and opened somewhere else. Nobody in THIS checkout
 *                     was asked, so it authorises nothing here (R-27).
 *  - `expired`      — a gate opened during one project must not still be open next quarter.
 *  - `type-changed` — the confused deputy. The key names a file whose contents can change after approval:
 *                     approve `tool:write@docs-writer` when it declares `read, write`, and later that file
 *                     gains `bash`. The entry would still match the key while describing something the
 *                     human never saw.
 *  - `instructions-changed` — the same confused deputy, one level deeper. The tools are untouched but the
 *                     BODY was rewritten, so the child would now be told to do something the human never
 *                     saw. Only checkable since ADR-0018 gave the body a digest; an entry carrying no body
 *                     pin lands here too, because unverifiable is not the same as unchanged.
 *  - `type-missing` — the type was deleted or renamed; a new file could later claim the same name.
 */
export function entryVerdict(input: EntryValidityInput): EntryVerdict {
  if (input.entry.cwd !== input.cwd) return "foreign-cwd";
  const expiresAt = new Date(input.entry.expiresAt).getTime();
  // NaN <= x is false in JS, so an unparseable date would otherwise fail OPEN. A cache we cannot
  // read the expiry of is a cache we do not trust — treat it as expired, per the spec's rule that a
  // broken cache grants nothing.
  if (!Number.isFinite(expiresAt) || expiresAt <= input.now.getTime()) return "expired";
  if (input.current === null) return "type-missing";
  // Compare as sorted lists: reformatting or reordering a `tools:` line is not a change; adding,
  // removing, or renaming a capability is.
  const approved = [...input.entry.grantAtApproval].sort().join(",");
  const current = [...input.current.ceiling].sort().join(",");
  if (approved !== current) return "type-changed";
  // Fail closed on an unpinned entry: it was written before bodies were digested, so "unchanged" is not
  // something this code can assert about it. One re-approval is the honest cost.
  if (input.entry.bodyAtApproval !== input.current.bodySha256) return "instructions-changed";
  return "valid";
}

export interface ResolveApprovalsInput {
  /** `ResolveResult.gatedBlocked` — held and within ceiling, but awaiting a human. */
  gated: Capability[];
  subject: string;
  /** Approval KEYS approved for this session, in memory only. */
  sessionApprovals: ReadonlySet<string>;
  /** Persisted entries by key, ALREADY validity-filtered by the store. */
  persisted: ReadonlyMap<string, ApprovalEntry>;
  /** Capabilities approved further up the tree and inherited with the grant. */
  /**
   * `capability@subject` keys inherited from the delegator (ADR-0014).
   *
   * Was `Capability[]` — bare names that matched any subject, and included `once` approvals that were
   * never meant to leave the level they were given at.
   */
  inherited?: Set<string>;
}

export interface ResolveApprovalsResult {
  approved: Capability[];
  /** Gated capabilities still requiring a live human. */
  needsPrompt: Capability[];
  sources: Record<Capability, ApprovalSource>;
}

/**
 * Satisfy as much of `gated` as possible without asking anyone.
 *
 * Precedence is inherited -> session -> persisted -> prompt. Order matters only for what gets REPORTED
 * (the ledger's `approvalSource`); any hit satisfies equally. Checking all three before prompting is what
 * stops an orchestrator's tenth delegation from raising a tenth identical dialog.
 */
export function resolveApprovals(input: ResolveApprovalsInput): ResolveApprovalsResult {
  // ADR-0014: these are `capability@subject` keys now, not bare capabilities, so an approval given for
  // one subject can no longer satisfy another.
  const inherited = input.inherited ?? new Set<string>();
  const approved: Capability[] = [];
  const needsPrompt: Capability[] = [];
  const sources: Record<Capability, ApprovalSource> = {};

  for (const capability of [...new Set(input.gated)].sort()) {
    const key = approvalKey(capability, input.subject);
    if (inherited.has(key)) {
      approved.push(capability);
      sources[capability] = "inherited";
    } else if (input.sessionApprovals.has(key)) {
      approved.push(capability);
      sources[capability] = "session";
    } else if (input.persisted.has(key)) {
      approved.push(capability);
      sources[capability] = "persisted";
    } else {
      needsPrompt.push(capability);
    }
  }

  return { approved, needsPrompt, sources };
}
