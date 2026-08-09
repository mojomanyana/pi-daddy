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
}

export interface Decision {
  allow: boolean;
  reason?: string;
  /** The child's effective grant when allowed — propagate this to the child session. */
  effective: Capability[];
  /** Ceiling the requested type declares, for the ledger. */
  requested: Capability[];
  result?: ResolveResult;
  childDepth: number;
  typeName: string;
}

/** Does this grant permit handing out everything? */
function holdsWildcard(grant: Capability[]): boolean {
  return grant.includes(WILDCARD);
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

  const base = { effective: [] as Capability[], requested: [] as Capability[], childDepth, typeName };

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
  const requested = type ? ceilingFor(type) : [WILDCARD];

  // The delegator holding the wildcard may hand out anything, including a wildcard ceiling.
  if (holdsWildcard(ctx.parentGrant)) {
    const effective = requested.filter((c) => !UNIVERSAL_CAPABILITIES.includes(c));
    return {
      ...base,
      allow: true,
      requested,
      effective,
      reason: type ? undefined : `unknown agent type "${typeName}" — allowed only because the delegator holds ${WILDCARD}`,
    };
  }

  // A wildcard ceiling cannot be covered by any enumerated grant, by definition.
  if (requested.includes(WILDCARD)) {
    return {
      ...base,
      requested,
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
