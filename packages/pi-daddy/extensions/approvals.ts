/**
 * The human-approval flow: what this session may inherit, republish, and ask a person for.
 *
 * Split out of `extensions/grants.ts`. Everything here takes the session as an explicit first argument
 * rather than closing over module state — the same discipline `grants-command.ts` was extracted under, and
 * for the same reason: R-28 was a defect in an *argument list*, invisible to 226 pure tests because
 * nothing tested argument lists. A parameter can be read; a closure has to be reconstructed.
 *
 * The session is passed whole, not destructured, because `ownGrant`, `definitions` and `cwd` all change
 * during a session. Reading them through the object is what keeps this flow looking at the live values
 * instead of whatever they were when the extension loaded.
 */

import {
  approvalKey,
  expiryFor,
  resolveApprovals,
  verifyInherited,
  type ApprovalPath,
  type ApprovalScope,
  type ApprovalSource,
  type InheritableApproval,
  type ResolveApprovalsResult,
  type SubjectSnapshot,
} from "../src/approval.ts";
import { loadApprovals, saveApproval } from "../src/approval-store.ts";
import type { createApprovalGate } from "../src/approval-prompt.ts";
import { timeoutMsFromEnv, type PromptOutcomeKind } from "../src/approval-prompt.ts";
import { ceilingForDefinition, digestDefinition } from "../src/definitions.ts";
import type { Capability } from "../src/resolve.ts";
import { approvalBindingDigest, type ApprovalBinding } from "../src/correlation.ts";
import type { RefusalCode } from "../src/refusals.ts";
import type { GrantsSession } from "./session.ts";
import type { BankedApproval } from "./approval-banking.ts";
export { unbankApprovals } from "./approval-banking.ts";
export type { BankedApproval } from "./approval-banking.ts";

/**
 * What a subject looks like right now, for the confused-deputy check in the approval store.
 *
 * ADR-0010's property is unchanged: an `always` approval is void once the thing it was granted for has
 * changed. Two things moved. The source is a `SKILL.md`'s `allowed-tools` rather than an agent type's
 * frontmatter (ADR-0016); and "the thing it was granted for" now includes the **body** as well as the
 * tools (ADR-0019), because a definition whose instructions were rewritten is not the definition the human
 * approved. An undeclared definition yields an EMPTY ceiling, not a wildcard, so a stored approval for it
 * can never be revalidated by accident.
 *
 * `<delegate>` — the `tools:` form's subject — resolves to `null` here and always will: it names no file,
 * so there is nothing to compare against. That is also why that path is never offered `always`.
 */
export function snapshotOf(session: GrantsSession, subject: string): SubjectSnapshot | null {
  const definition = session.definitions.get(subject);
  if (!definition) return null;
  return {
    ceiling: ceilingForDefinition(definition).capabilities,
    bodySha256: digestDefinition(definition).sha256,
  };
}

/**
 * What this session may republish to children (ADR-0014).
 *
 * Two changes from the version that published bare capability names. Each entry keeps its **subject**,
 * so an approval given for one agent type cannot satisfy another; and each keeps its **scope**, so
 * `inheritApprovals` can drop `once` rather than handing a whole subtree an approval a human gave for
 * a single spawn.
 *
 * `once` never enters `sessionApprovals` in the first place, so everything here is `session` or
 * `always` — but the scope is carried rather than assumed, because assuming it is what went wrong.
 */
export function republishable(session: GrantsSession): InheritableApproval[] {
  const fromKey = (key: string) => {
    const subject = key.slice(key.indexOf("@") + 1);
    return {
      capability: key.slice(0, key.indexOf("@")),
      subject,
      scope: "session" as const,
      // ADR-0022: the digest is taken from THIS session's view of the definition, not carried over from
      // whatever the parent sent. Republishing a stale hash would let a rewritten body travel one more hop
      // on a pin nobody re-checked, which is the hole this closes rather than moves.
      bodySha256: snapshotOf(session, subject)?.bodySha256,
    };
  };
  return [
    // Inherited keys arrive already clamped and already `once`-free from the level above — but NOT already
    // verified, and republishing an unverified one launders it. `fromKey` stamps this session's current
    // digest, so a key whose pin no longer matches would go out looking valid and be honoured by a child
    // that loaded the same current body: the approval was given about a different text and would travel
    // one hop further on a pin nobody checked. That is ADR-0022's own hole, reappearing inside the fix.
    ...[...verifyInherited(session.inheritedApprovals, (name) => snapshotOf(session, name))].map(fromKey),
    ...[...session.sessionApprovals].map(fromKey),
  ];
}

export interface ApprovalOutcome {
  approved: Capability[];
  /**
   * How far EACH capability's yes reaches (F1b/F5).
   *
   * Was a single `scope`, declared outside the prompt loop and overwritten by the last capability answered.
   * Approve `tool:bash` *once* and `tool:write` *for this session* and both were re-stamped `session` —
   * so ADR-0014's rule that "`once` stops at the boundary" was reopened by a mixed answer, and the ledger's
   * `approvalScope` described one capability while claiming to describe the set.
   *
   * Only prompted capabilities appear here. One satisfied from the store or by inheritance is deliberately
   * absent, so the caller's `?? "once"` keeps it out of what a child inherits — the conservative reading,
   * and the behaviour that was already in place.
   */
  scopes: Record<Capability, ApprovalScope>;
  /** Complete scope map for the ledger, including inherited, session, and persisted answers. */
  recordedScopes: Record<Capability, ApprovalScope>;
  /**
   * Where EACH approved capability's yes came from (R-46).
   *
   * Was a single `source`, chosen as `scope ? "prompt" : sources[approved[0]]` — which told the ledger a
   * human had been asked about capabilities satisfied silently from the store. `resolveApprovals` has
   * always computed this map; the bug was that it was thrown away.
   */
  sources: Record<Capability, ApprovalSource>;
  /** Exact binding per approved capability when this is a correlated controller call. */
  bindings: Record<Capability, ApprovalBinding>;
  expiresAt: Record<Capability, string>;
  uses: Record<Capability, { max: number; remaining: number }>;
  humanDenied: boolean;
  /**
   * Which of the five prompt outcomes ended the loop, when one did (ADR-0026's F5).
   *
   * `humanDenied` is one bit of a five-way discriminant. `no-ui`, `dismissed` and `error` all produced the
   * same record with only free-text `reason` to separate them, and they call for different responses: a
   * dismissal is a queue or a longer timeout, `no-ui` is an operator pre-approving, `error` is a defect.
   */
  gateOutcome?: PromptOutcomeKind;
  /**
   * Authority this gate LEFT BEHIND: session keys added, and 30-day entries written to disk.
   *
   * Recorded so a caller that refuses after the gate can take it back. `run-delegation.ts` already
   * documents the rule at length — "a refused operation must not leave authority behind" — and moved the
   * executor check before the gate to honour it. The adjacent path did not: an operator clicks *Always*,
   * the load-bearing ledger append then fails (a lock timeout under fan-out is a documented condition),
   * the delegation is refused, and a project-wide 30-day approval survives for a spawn that never
   * happened (R-113).
   */
  banked?: BankedApproval[];
  refusalCode?: RefusalCode;
  reason?: string;
}

/** The slice of pi's `ExtensionContext` this flow needs — a UI to ask through, and how to ask. */
export interface ApprovalUIContext {
  ui: Parameters<typeof createApprovalGate>[0]["ui"];
  hasUI: boolean;
  mode: string;
}

/**
 * The approvals already in hand: inherited, given earlier this session, or persisted from a previous one.
 *
 * No dialog, and no I/O beyond reading the store. Extracted (R-38) so that a **read-only preview can run
 * the same resolution the enforcer runs**. `/grants` used to list each definition from `planDelegation`
 * alone, which knows nothing about approvals — so a definition whose only gated capability was covered by a
 * valid persisted approval was listed as `BLOCK  … requires explicit approval` while a real spawn proceeded
 * with no human in the loop. That is R-28's shape (a diagnostic disagreeing with the enforcer) and it hid a
 * standing approval from the operator who ran the command to find exactly that.
 */
export async function storedApprovals(
  session: GrantsSession,
  gated: Capability[],
  subject: string,
  expectedBinding?: ApprovalBinding,
): Promise<ResolveApprovalsResult> {
  const { valid, dropped } = await loadApprovals({
    cwd: session.cwd,
    now: new Date(),
    snapshotOf: (name) => snapshotOf(session, name),
  });
  return resolveApprovals({
    gated,
    subject,
    sessionApprovals: session.sessionApprovals,
    sessionApprovalBindings: session.sessionApprovalBindings,
    persisted: valid,
    expectedBinding,
    expiredKeys: new Set(dropped.filter((item) => item.verdict === "expired").map((item) => item.key)),
    // ADR-0022. Verified HERE rather than at parse time because it needs `session.definitions`, which
    // arrives at `session_start` — after the session object is built.
    inherited: verifyInherited(session.inheritedApprovals, (name) => snapshotOf(session, name)),
  });
}

/**
 * Satisfy as many gated capabilities as possible, asking a human only for what is left.
 *
 * Returns what was approved and how, so the caller can re-resolve with the same pure `resolve()` and
 * the ledger can record which of the three flavours of "no" applies (see `ledger.ts`'s `GrantRecord`).
 *
 * **`ctx: null` means preview**: report what is already in hand and ask nobody. Deliberately not expressed
 * as `hasUI: false`, which means *"there is nobody here to ask"* — that path replaces the plan's reason with
 * a message about pre-approving in an interactive session, which is right for a governed child and both
 * wrong and noisy for a listing that never intended to ask. The two are different facts and are kept
 * distinguishable.
 */
export async function obtainApprovals(
  session: GrantsSession,
  gatedBlocked: Capability[],
  subject: string,
  path: ApprovalPath,
  ctx: ApprovalUIContext | null,
  task?: string,
  signal?: AbortSignal,
  expectedBinding?: ApprovalBinding,
): Promise<ApprovalOutcome> {
  const snapshot = (name: string) => snapshotOf(session, name);
  const pre = await storedApprovals(session, gatedBlocked, subject, expectedBinding);
  const preBindings: Record<Capability, ApprovalBinding> = {};
  if (expectedBinding) for (const capability of pre.approved) preBindings[capability] = expectedBinding;
  if (ctx === null || pre.needsPrompt.length === 0) {
    return {
      approved: pre.approved,
      sources: pre.sources,
      scopes: {},
      recordedScopes: pre.scopes,
      bindings: preBindings,
      expiresAt: pre.expiresAt,
      uses: {},
      humanDenied: false,
    };
  }

  // The gate PROVIDER lives on the session, not here: `obtainApprovals` runs once per `tool_call` and once
  // per `delegate.execute`, so a queue built per call would start empty every time and de-duplicate
  // nothing. Two concurrent delegations would stack two dialogs asking the identical question, which is
  // precisely what spec §6.1 exists to prevent. Options are per-call; the queue is session-long.
  const gate = session.approvalGateFor({
    ui: ctx.ui,
    hasUI: ctx.hasUI,
    mode: ctx.mode,
    timeoutMs: timeoutMsFromEnv(process.env.PI_GRANTS_APPROVAL_TIMEOUT),
  });

  const approved = [...pre.approved];
  // Seeded with what the store already answered, then one entry added per capability a human is asked
  // about — so a mixed set reports exactly which yes came from where.
  const sources: Record<Capability, ApprovalSource> = { ...pre.sources };
  const scopes: Record<Capability, ApprovalScope> = {};
  const recordedScopes: Record<Capability, ApprovalScope> = { ...pre.scopes };
  const bindings: Record<Capability, ApprovalBinding> = { ...preBindings };
  const expiresAt: Record<Capability, string> = { ...pre.expiresAt };
  const uses: Record<Capability, { max: number; remaining: number }> = {};
  let humanDenied = false;
  const banked: BankedApproval[] = [];
  let gateOutcome: PromptOutcomeKind | undefined;
  let refusalCode: RefusalCode | undefined;
  let reason: string | undefined;

  for (const capability of pre.needsPrompt) {
    const outcome = await gate.request({
      capability, subject, path, task, signal,
      ...(expectedBinding ? { bindingKey: approvalBindingDigest(expectedBinding) } : {}),
    });
    if (outcome.scope === null) {
      // Forward the gate's own discriminant rather than re-deriving it from `hasUI`: `hasUI` is true in
      // RPC mode too, so an automated client's timeout or dismissal there would misreport as "a human
      // declined" if we asked `ctx.hasUI` instead. Only `kind === "declined"` means a person said no.
      humanDenied = outcome.kind === "declined";
      // The full discriminant, not just the one bit of it that had a field. `no-ui`, `dismissed` and
      // `error` used to produce records identical to each other, separated only by free-text `reason` —
      // so "was there an operator who timed out, or was there nobody?" had no answer, and the two want
      // different fixes. It was computed here all along and thrown away.
      gateOutcome = outcome.kind;
      refusalCode = pre.expired.includes(capability)
        ? "APPROVAL_EXPIRED"
        : pre.scopeMismatched.includes(capability)
          ? "APPROVAL_SCOPE_MISMATCH"
          : "GATED_UNAPPROVED";
      reason = outcome.reason;
      break;
    }
    approved.push(capability);
    // R-66: `prompt` means A HUMAN SAW A DIALOG FOR THIS. A caller that joined another's in-flight answer
    // did not, so it records the source it actually had — the session approval that answer created. Eight
    // concurrent children under one *Allow for this session* used to write eight lines each claiming a
    // prompt. Same repair as R-46, one level up: stop asserting a human was asked on a path where they
    // were not.
    sources[capability] = outcome.joined ? "session" : "prompt";
    scopes[capability] = outcome.scope;
    recordedScopes[capability] = outcome.scope;
    if (expectedBinding) bindings[capability] = expectedBinding;
    if (outcome.scope === "once") uses[capability] = { max: 1, remaining: 0 };

    if (outcome.scope === "session" || outcome.scope === "always") {
      const key = approvalKey(capability, subject);
      if (expectedBinding) session.sessionApprovalBindings.set(key, expectedBinding);
      else session.sessionApprovals.add(key);
      banked.push({ key, capability, subject, persisted: false });
    }
    if (outcome.scope === "always") {
      const now = new Date();
      const current = snapshot(subject);
      // No readable ceiling means the entry would carry `grantAtApproval: []`, which `entryVerdict`
      // compares against the type's ceiling on every load — so it could only ever come back
      // "type-missing" or "type-changed". Writing it is not unsafe (it fails closed), it is simply a
      // dead entry that silently accumulates in the file. Skip it and say so, taking the same
      // downgrade-to-session path as a failed write below: the human's yes still stands.
      const expires = expiryFor(now);
      expiresAt[capability] = expires;
      const written =
        current === null
          ? false
          : await saveApproval(
              session.cwd,
              approvalKey(capability, subject),
              {
                approvedAt: now.toISOString(),
                expiresAt: expires,
                cwd: session.cwd,
                grantAtApproval: current.ceiling,
                // ADR-0019: the tools AND the instructions the human actually saw. Pinning only the
                // former would let a rewritten body inherit a yes that was given about different text.
                bodyAtApproval: current.bodySha256,
                ...(expectedBinding ? { binding: expectedBinding } : {}),
                // The TASK is deliberately absent (ADR-0021). It is shown in the dialog, where a human
                // needs it, and never written down, because the model assembles it from the parent's
                // context and it can carry anything the parent could see.
              },
              snapshot,
              now,
            );
      if (written) {
        // Mark the on-disk half so a later refusal knows there is a file entry to take back, not just a
        // session key that dies with the process.
        const persistedKey = approvalKey(capability, subject);
        for (const entry of banked) if (entry.key === persistedKey) entry.persisted = true;
      }
      if (!written) {
        // The human already said yes; the security decision stands. Only the convenience cache
        // failed, so this downgrades scope rather than refusing the delegation (see approval-store.ts).
        ctx.ui.notify(
          current === null
            ? `grants: cannot persist the approval for ${capability} — no definition named ${subject} is ` +
                `readable here, so a stored entry could never be valid; it applies for this session only`
            : `grants: could not persist the approval for ${capability} — it applies for this session only`,
          "warning",
        );
        // The human's yes stands; only the cache failed. Downgrade THIS capability, not the set — under
        // the old scalar this also rewrote the scope of every other capability answered in the same call.
        scopes[capability] = "session";
        recordedScopes[capability] = "session";
        delete expiresAt[capability];
      }
    }
    session.publishChildEnv(); // a new session approval widens what children may inherit — republish now
  }

  return {
    approved,
    sources,
    scopes,
    recordedScopes,
    bindings,
    expiresAt,
    uses,
    humanDenied,
    gateOutcome,
    refusalCode,
    reason,
    banked,
  };
}
