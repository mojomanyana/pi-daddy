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
  type ApprovalPath,
  type ApprovalScope,
  type ApprovalSource,
  type InheritableApproval,
  type SubjectSnapshot,
} from "../src/approval.ts";
import { loadApprovals, saveApproval } from "../src/approval-store.ts";
import type { createApprovalGate } from "../src/approval-prompt.ts";
import { timeoutMsFromEnv } from "../src/approval-prompt.ts";
import { ceilingForDefinition, digestDefinition } from "../src/definitions.ts";
import type { Capability } from "../src/resolve.ts";
import type { GrantsSession } from "./session.ts";

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
  const fromKey = (key: string) => ({
    capability: key.slice(0, key.indexOf("@")),
    subject: key.slice(key.indexOf("@") + 1),
    scope: "session" as const,
  });
  return [
    // Inherited keys arrive already clamped and already `once`-free from the level above.
    ...[...session.inheritedApprovals].map(fromKey),
    ...[...session.sessionApprovals].map(fromKey),
  ];
}

export interface ApprovalOutcome {
  approved: Capability[];
  source?: ApprovalSource;
  scope?: ApprovalScope;
  humanDenied: boolean;
  reason?: string;
}

/** The slice of pi's `ExtensionContext` this flow needs — a UI to ask through, and how to ask. */
export interface ApprovalUIContext {
  ui: Parameters<typeof createApprovalGate>[0]["ui"];
  hasUI: boolean;
  mode: string;
}

/**
 * Satisfy as many gated capabilities as possible, asking a human only for what is left.
 *
 * Returns what was approved and how, so the caller can re-resolve with the same pure `resolve()` and
 * the ledger can record which of the three flavours of "no" applies (see `ledger.ts`'s `GrantRecord`).
 */
export async function obtainApprovals(
  session: GrantsSession,
  gatedBlocked: Capability[],
  subject: string,
  path: ApprovalPath,
  ctx: ApprovalUIContext,
  task?: string,
  signal?: AbortSignal,
): Promise<ApprovalOutcome> {
  const snapshot = (name: string) => snapshotOf(session, name);
  const { valid } = await loadApprovals({ cwd: session.cwd, now: new Date(), snapshotOf: snapshot });
  const pre = resolveApprovals({
    gated: gatedBlocked,
    subject,
    sessionApprovals: session.sessionApprovals,
    persisted: valid,
    inherited: session.inheritedApprovals,
  });
  if (pre.needsPrompt.length === 0) {
    return {
      approved: pre.approved,
      source: pre.approved.length > 0 ? pre.sources[pre.approved[0]] : undefined,
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
  let scope: ApprovalScope | undefined;
  let humanDenied = false;
  let reason: string | undefined;

  for (const capability of pre.needsPrompt) {
    const outcome = await gate.request({ capability, subject, path, task, signal });
    if (outcome.scope === null) {
      // Forward the gate's own discriminant rather than re-deriving it from `hasUI`: `hasUI` is true in
      // RPC mode too, so an automated client's timeout or dismissal there would misreport as "a human
      // declined" if we asked `ctx.hasUI` instead. Only `kind === "declined"` means a person said no.
      humanDenied = outcome.kind === "declined";
      reason = outcome.reason;
      break;
    }
    approved.push(capability);
    scope = outcome.scope;

    if (outcome.scope === "session" || outcome.scope === "always") {
      session.sessionApprovals.add(approvalKey(capability, subject));
    }
    if (outcome.scope === "always") {
      const now = new Date();
      const current = snapshot(subject);
      // No readable ceiling means the entry would carry `grantAtApproval: []`, which `entryVerdict`
      // compares against the type's ceiling on every load — so it could only ever come back
      // "type-missing" or "type-changed". Writing it is not unsafe (it fails closed), it is simply a
      // dead entry that silently accumulates in the file. Skip it and say so, taking the same
      // downgrade-to-session path as a failed write below: the human's yes still stands.
      const written =
        current === null
          ? false
          : await saveApproval(
              session.cwd,
              approvalKey(capability, subject),
              {
                approvedAt: now.toISOString(),
                expiresAt: expiryFor(now),
                cwd: session.cwd,
                grantAtApproval: current.ceiling,
                // ADR-0019: the tools AND the instructions the human actually saw. Pinning only the
                // former would let a rewritten body inherit a yes that was given about different text.
                bodyAtApproval: current.bodySha256,
                taskAtApproval: task,
              },
              snapshot,
              now,
            );
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
        scope = "session";
      }
    }
    session.publishChildEnv(); // a new session approval widens what children may inherit — republish now
  }

  return {
    approved,
    source: approved.length > 0 ? (scope ? "prompt" : pre.sources[approved[0]]) : undefined,
    scope,
    humanDenied,
    reason,
  };
}
