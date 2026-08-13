/**
 * The approval dialog — the only place a human enters the capability-governance path.
 *
 * Kept out of `extensions/grants.ts` deliberately: that file is wiring only, and this holds decisions
 * (what to offer, what a dismissal means, what happens with nobody watching) that must be testable
 * without pi. `ApprovalUI` is the minimal slice of pi's `ExtensionUIContext` needed here, so a test can
 * supply a plain object.
 *
 * Everything here denies on uncertainty. pi already agrees: in non-interactive modes it installs a
 * no-op UI context whose `select` resolves undefined, so even a missed `hasUI` check would deny.
 */

import { approvalKey, offeredScopes, type ApprovalPath, type ApprovalScope } from "./approval.ts";
import type { Capability } from "./resolve.ts";

/** The slice of pi's `ExtensionUIContext` this module needs. */
export interface ApprovalUI {
  select(
    title: string,
    options: string[],
    opts?: { timeout?: number; signal?: AbortSignal },
  ): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export const DENY_LABEL = "Deny";

export const SCOPE_LABELS: Record<ApprovalScope, string> = {
  once: "Allow once",
  session: "Allow for this session",
  always: "Always allow in this project (30 days)",
};

export interface PromptRequest {
  capability: Capability;
  /** Agent type name, or `DELEGATE_SUBJECT` on the delegate path. */
  subject: string;
  path: ApprovalPath;
  /** Shown to the human for context. Never part of a key. */
  task?: string;
  signal?: AbortSignal;
}

/**
 * Which of the five outcomes a request produced.
 *
 * `scope: null` alone conflates four different kinds of no — a caller that needs to know whether a
 * PERSON actually declined (as opposed to nobody being there to ask, a dismissal, or the dialog itself
 * breaking) cannot recover that from `scope` or from parsing `reason`. Only "declined" means a human said
 * no; the other three are absence-of-signal, not a signal.
 */
export type PromptOutcomeKind = "granted" | "no-ui" | "declined" | "dismissed" | "error";

export interface PromptOutcome {
  /** The scope the human chose, or null for any form of no. */
  scope: ApprovalScope | null;
  /** Which of the five outcomes this was. Set on every return path. */
  kind: PromptOutcomeKind;
  /** Why, when the answer was no. */
  reason?: string;
}

export interface ApprovalGateOptions {
  ui: ApprovalUI;
  /** pi's `ctx.hasUI` — false in print/json mode, and therefore in every governed child. */
  hasUI: boolean;
  /** pi's `ctx.mode`, quoted back in the refusal so an operator can see why. */
  mode: string;
  timeoutMs?: number;
}

export interface ApprovalGate {
  request(request: PromptRequest): Promise<PromptOutcome>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Read `PI_GRANTS_APPROVAL_TIMEOUT`, in SECONDS, into the milliseconds pi expects.
 *
 * `0` or an unparseable value means no timeout: waiting forever denies nothing, so it is the safe
 * interpretation of a value we do not understand.
 */
export function timeoutMsFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
}

function labelToScope(label: string, scopes: ApprovalScope[]): ApprovalScope | null {
  return scopes.find((s) => SCOPE_LABELS[s] === label) ?? null;
}

/**
 * The single-flight queue: one dialog per approval key at a time.
 *
 * `delegate` sets no `executionMode`, so an orchestrator can fan out several children at once and two can
 * hit the same gate simultaneously — otherwise two stacked dialogs asking the identical question.
 *
 * **R-29 — the key does two jobs, and only one of them may be shared.** `approvalKey` is
 * `capability@subject`, and on the delegate path the subject is the constant `DELEGATE_SUBJECT`, which is
 * deliberate: the only things naming a delegated child are the task and the tool list, both model-chosen,
 * and a key the model controls is not a key (`approval.ts:24-32`). That reasoning governs *approval
 * identity* — what a human said yes to, and what may be persisted — and it is right.
 *
 * It does **not** govern de-duplication. Sharing one dialog's outcome is correct for `session` and
 * `always`, which are genuinely answers about the session or the project, and for a decline or an error,
 * which answer everyone. It is **wrong for `once`**, which means *this spawn*. Measured before the fix:
 * four concurrent delegations gating `tool:bash`, one dialog, one click of *Allow once* → four `granted`
 * outcomes, with the human having seen only the first caller's task. That is a confused deputy, and it
 * falsified ADR-0014's decided property that "`once` stops at the boundary".
 */
export type InFlightApprovals = Map<string, Promise<PromptOutcome>>;

/**
 * Build gates that SHARE one single-flight queue.
 *
 * This exists because of how the wiring actually calls in. The gate's options depend on the per-call
 * `ExtensionContext` (`ui`, `hasUI`, `mode`), so the extension necessarily builds a gate per invocation —
 * and a gate that owns its queue privately therefore de-duplicates nothing across invocations, which is
 * exactly the case §6.1 exists for (two concurrent `delegate` calls are two separate invocations).
 *
 * The provider separates the two lifetimes: options stay per-call and fresh, the queue is created once and
 * lives as long as the provider. Preferred over a module-level map because that would be shared by every
 * gate in the process — including across tests — for no benefit.
 */
export function createApprovalGateProvider(): (options: ApprovalGateOptions) => ApprovalGate {
  const inFlight: InFlightApprovals = new Map();
  return (options) => createApprovalGate(options, inFlight);
}

/**
 * @param inFlight optional shared single-flight queue — see `createApprovalGateProvider`. Defaults to one
 * private to this gate, which only de-duplicates requests made through this same gate object.
 */
export function createApprovalGate(
  options: ApprovalGateOptions,
  inFlight: InFlightApprovals = new Map(),
): ApprovalGate {
  const ask = async (request: PromptRequest): Promise<PromptOutcome> => {
    const scopes = offeredScopes(request.path);
    const title =
      `grants: approve ${request.capability} for ${request.subject}?` +
      (request.task ? `\n  task: ${request.task}` : "");

    let chosen: string | undefined;
    try {
      chosen = await options.ui.select(title, [DENY_LABEL, ...scopes.map((s) => SCOPE_LABELS[s])], {
        timeout: options.timeoutMs,
        signal: request.signal,
      });
    } catch (error) {
      // A governance layer that errors must deny, not permit. This is a dialog malfunction, not a
      // person's answer — `kind: "error"` keeps it out of "declined".
      return { scope: null, kind: "error", reason: `approval dialog failed, denying (${String(error)})` };
    }

    // undefined covers dismissal, timeout, and abort. All are a no, but none is a person saying no.
    if (chosen === undefined) {
      return { scope: null, kind: "dismissed", reason: `approval for ${request.capability} was dismissed` };
    }
    if (chosen === DENY_LABEL) {
      return { scope: null, kind: "declined", reason: `${request.capability} was denied by a human` };
    }

    const scope = labelToScope(chosen, scopes);
    return scope === null
      ? { scope: null, kind: "error", reason: `unrecognised approval choice ${JSON.stringify(chosen)}, denying` }
      : { scope, kind: "granted" };
  };

  return {
    async request(request: PromptRequest): Promise<PromptOutcome> {
      if (!options.hasUI) {
        // Nobody was there to ask — distinct from a person declining, which is why this is its own kind
        // rather than being folded into "declined" (see PromptOutcomeKind).
        return {
          scope: null,
          kind: "no-ui",
          reason:
            `${request.capability} requires approval and this session has no interactive user ` +
            `(mode: ${options.mode}). Pre-approve it in an interactive session, or drop it from the request.`,
        };
      }

      const key = approvalKey(request.capability, request.subject);

      // R-29. Join an in-flight dialog, but only *keep* its answer if that answer was about more than one
      // spawn. A `once` belongs to whichever caller the human was actually looking at — the title shows
      // that caller's task — so anyone else who joined must ask their own question rather than ride a yes
      // given for somebody else's work. The loop (rather than a single retry) covers the case where a
      // fellow waiter started its own dialog first: we join that one instead of opening a third.
      for (;;) {
        const existing = inFlight.get(key);
        if (!existing) break;
        const outcome = await existing;
        if (outcome.scope !== "once") return outcome;
      }

      const pending = ask(request).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
  };
}
