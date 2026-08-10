/**
 * The spawn decision — pure, so it is testable without pi, a model, or a network.
 *
 * IMPORTANT LIMITATION, stated up front because it shapes everything: `@tintinweb/pi-subagents`'
 * `Agent` tool has **no `tools` parameter**. A delegator selects a `subagent_type`, whose capability
 * set is fixed in that type's file. So this interceptor can ENFORCE but not PROVISION: it decides
 * whether a spawn is permissible and blocks it otherwise. It cannot silently hand the child a
 * narrower set than its type declares.
 *
 * That is still the security property — a spawn that would exceed the delegator's own grant never
 * happens — and it is what pi's `tool_call` hook makes possible today.
 */

import { ceilingFor, WILDCARD, type AgentType } from "./agent-types.ts";
// Only for the refusal message: naming the variable that fixes it is the difference between a
// refusal an operator can act on and one they cannot.
import { ENV_GRANT } from "./propagation.ts";
import { resolve, UNIVERSAL_CAPABILITIES, type Capability, type ResolveResult } from "./resolve.ts";

export interface SpawnRequest {
  /** `event.input.subagent_type` from the `Agent` tool call. */
  subagentType?: unknown;
  /** `event.input.isolated` — drops extension tools, so it narrows rather than widens. */
  isolated?: unknown;
}

export interface DecisionContext {
  /** Capabilities this session holds. Root sessions are configured, never defaulted to everything. */
  parentGrant: Capability[];
  /** Delegation depth of THIS session; the child would be depth + 1. */
  depth: number;
  /** Maximum permitted child depth. `0` forbids spawning outright. */
  maxDepth: number;
  /** Known agent types by name. */
  types: Map<string, AgentType>;
  /** Capabilities requiring explicit human approval. */
  gated?: Capability[];
  /** Gated capabilities approved for this spawn. */
  approved?: Capability[];
  /**
   * Extension-tool capabilities this session actually holds (ADR-0013).
   *
   * Most agent types inherit the session's extensions, so this is part of the child's real ceiling.
   * Omitting it makes every inheriting type resolve to the wildcard — fail closed, because an
   * under-counted ceiling is one that gets allowed.
   */
  extensionTools?: Capability[];
}

export interface Decision {
  allow: boolean;
  reason?: string;
  /** The child's effective grant when allowed — propagate this to the child session. */
  effective: Capability[];
  /** Ceiling the requested type declares, for the ledger. */
  requested: Capability[];
  /**
   * The result this decision was made from. **Required** (A-S3): when it was optional, the caller
   * recomputed a missing one from different inputs and recorded a false escalation. The type is what
   * stops that returning — a new early exit cannot omit it.
   */
  result: ResolveResult;
  childDepth: number;
  typeName: string;
}

/** Does this grant permit handing out everything? */
function holdsWildcard(grant: Capability[]): boolean {
  return grant.includes(WILDCARD);
}

/**
 * A `ResolveResult` for a decision reached WITHOUT calling `resolve()`.
 *
 * G6 / review finding A-S3. Six of this function's eight exits used to return no `result` at all, and the
 * extension papered over that with `decision.result ?? resolve({ requested, parentGrant, gated })`
 * (`grants.ts:326`) — recomputing the record from different inputs than the decision was made from. On the
 * wildcard path that recompute is actively wrong: `resolve()` has no notion of `tool:*` (the string
 * appears nowhere in `resolve.ts`), so a wildcard delegator's grant matches nothing, every requested
 * capability lands in `denied`, and `isEscalationAttempt()` reports an ALLOWED spawn as an attack. The one
 * signal the ledger exists to carry was firing on legitimate traffic.
 *
 * Fixing it here rather than by teaching `resolve()` the wildcard is deliberate. `resolve.ts` is the
 * security core: it is the function that must never over-grant, it has the package's most exhaustive
 * tests, and giving it a branch where one input string means "everything is permitted" is exactly the
 * shape of change that turns a total function into a footgun. The wildcard is an *interceptor-level*
 * concept — the authority to hand out what you do not enumerate — so it stays at this level.
 */
function decidedResult(over: Partial<ResolveResult> = {}): ResolveResult {
  return {
    effective: [],
    denied: [],
    clipped: [],
    gatedBlocked: [],
    universal: [],
    subsumedBy: [],
    ...over,
  };
}

/**
 * Decide whether a spawn may proceed.
 *
 * Fails closed on every uncertainty: unknown type, missing type name, depth exceeded, or a ceiling the
 * delegator cannot cover.
 */
export function decideSpawn(request: SpawnRequest, ctx: DecisionContext): Decision {
  const childDepth = ctx.depth + 1;
  const typeName = typeof request.subagentType === "string" ? request.subagentType : "";

  // Every exit carries a `result` (A-S3). `base` supplies an empty one; paths that reach `resolve()`
  // overwrite it, and the wildcard paths below build an accurate one by hand.
  const base = {
    effective: [] as Capability[],
    requested: [] as Capability[],
    result: decidedResult(),
    childDepth,
    typeName,
  };

  if (ctx.maxDepth <= 0) {
    return { ...base, allow: false, reason: "spawning is disabled (maxDepth 0)" };
  }
  if (childDepth > ctx.maxDepth) {
    return { ...base, allow: false, reason: `delegation depth limit reached (${ctx.maxDepth})` };
  }
  if (!typeName) {
    return { ...base, allow: false, reason: "spawn without a subagent_type cannot be governed" };
  }

  const type = ctx.types.get(typeName);
  // An unknown type is treated as wildcard-requesting rather than as harmless: we cannot read its
  // ceiling, so we must not assume it is narrow.
  const requested = type ? ceilingFor(type, { extensionTools: ctx.extensionTools }) : [WILDCARD];

  // The delegator holding the wildcard may hand out anything it holds — but "anything it holds" is
  // not the same as "anything at all", and this branch used to return `allow` before either of the
  // two checks below had run.
  //
  // ADR-0011. The old code filtered universal capabilities out of `effective` here and allowed the
  // spawn. That filtering was cosmetic: `effective` is a RECORD on this path, not a provisioning
  // instruction — `pi-subagents`' Agent tool has no `tools` parameter, so the child received the
  // capability regardless and only the ledger entry changed. A line that looks like enforcement but
  // edits an audit record is worse than no line, so it is gone.
  if (holdsWildcard(ctx.parentGrant)) {
    const universal = requested.filter((c) => UNIVERSAL_CAPABILITIES.includes(c));
    if (universal.length > 0) {
      return {
        ...base,
        requested,
        result: decidedResult({ universal }),
        allow: false,
        reason:
          `agent type "${typeName}" declares ${universal.join(", ")}, which transitively confers the whole ` +
          `catalog — the spawn would not narrow anything, so holding ${WILDCARD} does not authorise it`,
      };
    }

    // A gate is the operator's, not the delegator's. Holding the wildcard is authority to GRANT
    // widely; it was never authority to skip a human. Found independently by two reviews.
    const approvedHere = new Set(ctx.approved ?? []);
    const gatedHere = (ctx.gated ?? []).filter((c) => requested.includes(c) && !approvedHere.has(c));
    if (gatedHere.length > 0) {
      return {
        ...base,
        requested,
        result: decidedResult({ gatedBlocked: gatedHere }),
        allow: false,
        // ADR-0011 Finding 1: this branch REFUSES, it does not prompt — it returns before a
        // `ResolveResult` exists, and the extension's approval flow is guarded by
        // `shouldSeekApproval(decision.result)`, which is false for `undefined`. Saying "requires
        // approval" would send the operator to a dialog that never appears. The message names the
        // remedy instead, because there genuinely is one: an enumerated grant reaches the path that
        // CAN be approved.
        reason:
          `agent type "${typeName}" declares ${gatedHere.join(", ")}, which this session's operator has ` +
          `gated — and a ${WILDCARD} grant cannot be approved for it, because no approval is offered on ` +
          `this path. Set ${ENV_GRANT} to an enumerated list to be asked instead of refused`,
      };
    }

    return {
      ...base,
      allow: true,
      requested,
      // The delegator holds the wildcard, so nothing was denied. Recording this explicitly is the whole
      // point of A-S3: the extension's fallback `resolve()` would deny ALL of it.
      result: decidedResult({ effective: requested }),
      effective: requested,
      reason: type ? undefined : `unknown agent type "${typeName}" — allowed only because the delegator holds ${WILDCARD}`,
    };
  }

  // A wildcard ceiling cannot be covered by any enumerated grant, by definition.
  if (requested.includes(WILDCARD)) {
    return {
      ...base,
      requested,
      result: decidedResult({ denied: requested }),
      allow: false,
      reason: type
        ? `agent type "${typeName}" declares no tools: allowlist, so it would receive pi's full toolset; the delegator does not hold ${WILDCARD}`
        : `unknown agent type "${typeName}"; the delegator does not hold ${WILDCARD}`,
    };
  }

  const result = resolve({
    requested,
    parentGrant: ctx.parentGrant,
    gated: ctx.gated,
    approved: ctx.approved,
  });

  if (result.denied.length > 0) {
    return {
      ...base,
      requested,
      result,
      allow: false,
      reason:
        `agent type "${typeName}" requires ${result.denied.join(", ")}, which this session does not hold ` +
        `(capability escalation blocked)`,
    };
  }
  // ADR-0011: checked BEFORE `gatedBlocked`, deliberately. A spawn retaining a universal capability
  // can never proceed, with or without a human's approval — so reporting "requires approval" would
  // send the operator to a dialog that cannot help, and a yes given there would be banked against a
  // spawn that was always going to be refused.
  if (result.universal.length > 0) {
    return {
      ...base,
      requested,
      result,
      allow: false,
      reason:
        `agent type "${typeName}" would retain ${result.universal.join(", ")}, which transitively confers ` +
        `the whole catalog — the grant would not narrow anything`,
    };
  }
  if (result.gatedBlocked.length > 0) {
    return {
      ...base,
      requested,
      result,
      allow: false,
      reason: `agent type "${typeName}" requires approval for ${result.gatedBlocked.join(", ")}`,
    };
  }

  return { ...base, allow: true, requested, result, effective: result.effective };
}
