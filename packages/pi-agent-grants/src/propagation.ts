/**
 * Race-free grant propagation.
 *
 * The first implementation wrote each child's computed grant into `process.env` inside the `tool_call`
 * handler. The environment is process-global, so two concurrent spawns could read each other's values —
 * a real hole in a security control.
 *
 * The fix removes the need for a per-child channel entirely, rather than trying to build one:
 *
 *   1. Everything pushed to children is a property of the PARENT, not of the individual spawn — the
 *      parent's own grant, the child depth (parent depth + 1), and the configured bounds. Those are
 *      identical for every sibling, so concurrent spawns cannot disagree and there is nothing to race.
 *      `ENV_APPROVED` (approvals a human granted at or above this level) is safe on the same global
 *      channel for the same reason: it is intersected with the parent's own grant before being written,
 *      which is itself a parent-level fact, so it too is identical for every sibling.
 *   2. Each child derives ITS OWN grant on arrival: `inheritedParentGrant ∩ ownObservedTools`, where the
 *      observed set comes from the `tools` array of its first provider request — authoritative, because
 *      it is literally what pi sent the model.
 *
 * The environment is therefore written ONCE per session, before any spawn can occur (the first provider
 * request precedes any tool call), and never mutated per spawn.
 *
 * The invariant still holds transitively: own = observed ∩ inheritedParent ⊆ inheritedParent, so no
 * descendant can exceed the root. It is also defence in depth — even if a spawn slipped past the
 * interceptor and pi handed the child more than the parent held, the intersection clamps it back.
 */

import type { Capability } from "./resolve.ts";
import { WILDCARD } from "./agent-types.ts";
import { inheritApprovals } from "./approval.ts";

export const ENV_GRANT = "PI_GRANTS_GRANT";
export const ENV_DEPTH = "PI_GRANTS_DEPTH";
export const ENV_MAX_DEPTH = "PI_GRANTS_MAX_DEPTH";
export const ENV_GATED = "PI_GRANTS_GATED";
export const ENV_LEDGER = "PI_GRANTS_LEDGER";
export const ENV_APPROVED = "PI_GRANTS_APPROVED";

/**
 * Every variable this package uses to push governance state at a child.
 *
 * Named as a set so `mergeChildEnv` can guarantee that none of them survives from the parent's own
 * environment into a child's — a governance variable a child inherits by accident is one nobody decided
 * to give it.
 */
export const GRANT_ENV_KEYS = [
  ENV_GRANT,
  ENV_DEPTH,
  ENV_MAX_DEPTH,
  ENV_GATED,
  ENV_LEDGER,
  ENV_APPROVED,
] as const;

export const parseList = (raw: string | undefined): Capability[] =>
  (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);

/** Does a bare pi tool name correspond to this capability? `read` matches `tool:read` and `ext:pkg/read`. */
function matchesToolName(capability: Capability, toolName: string): boolean {
  if (capability === `tool:${toolName}`) return true;
  return capability.startsWith("ext:") && capability.slice(capability.lastIndexOf("/") + 1) === toolName;
}

/**
 * Derive this session's own grant from what it inherited and what pi actually gave it.
 *
 * `observedTools` is the bare tool-name list from the session's own provider payload, or null when it
 * has not been observed yet — in which case the inherited grant is used unchanged (it is already an
 * upper bound, so this is safe, just less tight).
 *
 * A wildcard holder stays a wildcard holder: an enumerated observation must not silently downgrade an
 * explicitly unlimited grant, or a root session would lose the authority it was configured with.
 */
export function deriveOwnGrant(
  inheritedParentGrant: Capability[],
  observedTools: string[] | null,
): Capability[] {
  if (observedTools === null) return [...inheritedParentGrant];
  if (inheritedParentGrant.includes(WILDCARD)) {
    // Keep the wildcard, and additionally enumerate what was observed so descendants can be checked
    // against concrete names too.
    const enumerated = observedTools.map((t) => `tool:${t}`);
    return [...new Set([WILDCARD, ...enumerated])].sort();
  }
  return inheritedParentGrant
    .filter((c) => observedTools.some((t) => matchesToolName(c, t)))
    .sort();
}

export interface ChildEnvInput {
  /** This session's own grant — becomes the child's inherited parent grant. */
  ownGrant: Capability[];
  /** This session's depth; children are one deeper. */
  depth: number;
  maxDepth: number;
  gated: Capability[];
  /**
   * Gated capabilities a human approved at or above this level.
   *
   * Safe to push on the GLOBAL channel because it is intersected with THIS session's own grant, which is
   * a parent-level fact — identical for every sibling, so there is nothing to race on. Each child then
   * re-intersects with its own grant on arrival, exactly as it does for the grant itself.
   */
  approved?: Capability[];
  ledgerPath?: string;
}

/**
 * The environment a child should inherit. Constant across all of this session's children by
 * construction, which is what makes concurrent spawning safe.
 *
 * **The wildcard is never inherited.** A root may HOLD `tool:*` — that is authority to grant anything —
 * but handing it down would let every descendant reacquire the full catalog, which makes attenuation
 * meaningless below the root. Children therefore inherit the ENUMERATED grant only.
 *
 * Consequence, deliberate: a wildcard root that has not yet observed its own tools hands children an
 * empty grant, so they can spawn nothing. That fails closed. It is also unreachable in normal flow,
 * because a session's first provider request always precedes its first tool call.
 */
export function childEnv(input: ChildEnvInput): Record<string, string> {
  const inheritable = input.ownGrant.filter((c) => c !== WILDCARD);
  const env: Record<string, string> = {
    [ENV_GRANT]: inheritable.join(","),
    [ENV_DEPTH]: String(input.depth + 1),
    [ENV_MAX_DEPTH]: String(input.maxDepth),
  };
  if (input.gated.length > 0) env[ENV_GATED] = input.gated.join(",");
  // ALWAYS written, empty string included. This is the one value that changes during a session (a human
  // approves something, or the session's own grant narrows on observation), and the interceptor path
  // publishes it by ASSIGNING into the process-global `process.env`. Omitting it when empty would leave
  // whatever was there before — the parent's own, unclamped `PI_GRANTS_APPROVED` — visible to every child.
  // `parseList("")` is `[]`, so an empty value reads back exactly as an absent one.
  env[ENV_APPROVED] = inheritApprovals(input.approved ?? [], inheritable).join(",");
  if (input.ledgerPath) env[ENV_LEDGER] = input.ledgerPath;
  return env;
}

/**
 * The environment for a child this process spawns itself: the parent's environment with every governance
 * variable stripped, then the per-child plan applied.
 *
 * Spreading `{ ...process.env, ...plan.env }` is not enough. `plan.env` omits keys that do not apply to
 * this child (an empty approval set, no gated list), and an omitted key does not overwrite — so the
 * parent's own value survives into the child. Stripping first makes the plan the ONLY source of every
 * governance variable, which is what `delegate.ts`'s "nothing is written to the shared `process.env`"
 * claim actually requires. Consumers re-clamp anyway; this is the defence in depth behind that.
 */
export function mergeChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  planEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...parentEnv };
  for (const key of GRANT_ENV_KEYS) delete merged[key];
  return { ...merged, ...planEnv };
}

/** Extract bare tool names from a provider payload's tool array, tolerating provider shape differences. */
export function observeToolNames(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["tools", "functions"]) {
    const candidate = record[key];
    if (!Array.isArray(candidate)) continue;
    const names = candidate
      .map((entry) => {
        if (!entry || typeof entry !== "object") return undefined;
        const e = entry as Record<string, unknown>;
        // Anthropic/OpenAI tool objects, and OpenAI's nested `function.name` form.
        const nested = e.function as Record<string, unknown> | undefined;
        const name = e.name ?? nested?.name;
        return typeof name === "string" ? name : undefined;
      })
      .filter((n): n is string => Boolean(n));
    // An empty tools array is a real observation (the session has no tools), not a failure to observe.
    return names;
  }
  return null;
}
