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
import { WILDCARD } from "./pi-tools.ts";
import { WORKSPACE_WILDCARD } from "./resolve.ts";
import { inheritApprovals, type InheritableApproval } from "./approval.ts";
import { assertCapabilitiesArePropagatable } from "./capabilities.ts";

export const ENV_GRANT = "PI_GRANTS_GRANT";
/**
 * Total descendants this session may create in its whole subtree (`src/fanout.ts`).
 *
 * In `GRANT_ENV_KEYS` and therefore stripped from a child's environment and re-supplied only by the spawn
 * plan — like depth, and for the same reason: it is capability state that must ATTENUATE downward, not an
 * operator preference that should inherit. `PI_GRANTS_CHILD_TIMEOUT` is deliberately the other kind.
 */
export const ENV_FANOUT = "PI_GRANTS_FANOUT";
/**
 * This session's ledger id, so a child's records name their real parent (review finding F8).
 *
 * Without it every level restarts at `d0` and the ledger cannot be joined into a tree across processes.
 */
export const ENV_PARENT_ID = "PI_GRANTS_PARENT_ID";
/** Unique identity of this governed execution occurrence; unlike ENV_PARENT_ID it is never reused. */
export const ENV_EXECUTION_ID = "PI_GRANTS_EXECUTION_ID";
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
  ENV_FANOUT,
  ENV_PARENT_ID,
  ENV_EXECUTION_ID,
] as const;

export const parseList = (raw: string | undefined): Capability[] =>
  (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);

/** Does a bare pi tool name correspond to this capability? `read` matches `tool:read` and `ext:pkg/read`. */
function matchesToolName(capability: Capability, toolName: string): boolean {
  if (capability === `tool:${toolName}`) return true;
  return capability.startsWith("ext:") && capability.slice(capability.lastIndexOf("/") + 1) === toolName;
}

/**
 * Is this capability something an observed tool array can speak about at all? (R-36, ADR-0017 step 1.)
 *
 * `tool:` and `ext:` name tools, so a tool array that omits one is evidence the session does not have it.
 * `skill:` and `agent:` name a loadable instruction file and a spawnable definition — neither is ever a
 * tool, so an observation says **nothing** about them and must not be read as evidence of absence.
 */
const isToolCapability = (capability: Capability): boolean =>
  capability.startsWith("tool:") || capability.startsWith("ext:");

/**
 * Derive this session's own grant from what it inherited and what pi actually gave it.
 *
 * `observedTools` is the bare tool-name list from the session's own provider payload, or null when it
 * has not been observed yet — in which case the inherited grant is used unchanged (it is already an
 * upper bound, so this is safe, just less tight).
 *
 * A wildcard holder stays a wildcard holder: an enumerated observation must not silently downgrade an
 * explicitly unlimited grant, or a root session would lose the authority it was configured with.
 *
 * **R-36 / ADR-0017 step 1: only tool-shaped capabilities are filtered.** The observation is a list of
 * TOOLS, so it is evidence about `tool:` and `ext:` and about nothing else. Until this was fixed, a child
 * inheriting `tool:read, skill:review` held only `tool:read` from its first provider request onward — it
 * still *had* the skill (it arrives as `--skill`), but could not re-grant it and `/grants` stopped listing
 * it. Silently, and in the narrowing direction, which is why it survived: nothing fails when a grant
 * quietly shrinks. It also made ADR-0017's `agent:` prerequisite unsatisfiable below the root.
 */
export function deriveOwnGrant(
  inheritedParentGrant: Capability[],
  observedTools: string[] | null,
): Capability[] {
  if (observedTools === null) return [...inheritedParentGrant];
  // Capabilities an observation cannot speak about ride through both branches untouched.
  const nonTool = inheritedParentGrant.filter((c) => !isToolCapability(c) && c !== WILDCARD);
  if (inheritedParentGrant.includes(WILDCARD)) {
    // Keep the wildcard, and additionally enumerate what was observed so descendants can be checked
    // against concrete names too.
    const enumerated = observedTools.map((t) => `tool:${t}`);
    return [...new Set([WILDCARD, ...enumerated, ...nonTool])].sort();
  }
  return [
    ...inheritedParentGrant.filter(
      (c) => isToolCapability(c) && observedTools.some((t) => matchesToolName(c, t)),
    ),
    ...nonTool,
  ].sort();
}

/**
 * Parse a bound from the environment, distinguishing **absent** from **malformed**.
 *
 * G7 / A-S4 + B-I4. `Number.parseInt` is the wrong tool for reading configuration: it accepts a numeric
 * prefix (`parseInt("2abc")` is `2`), returns `NaN` for anything else, and `NaN` silently passes every
 * comparison as false — so a malformed `PI_GRANTS_MAX_DEPTH` did not tighten the limit, it removed it.
 *
 * The three-way return is the point. `undefined` means "not configured, use the documented default";
 * `null` means "configured wrongly", which callers must treat as a failure rather than a default,
 * because a value someone tried to set and mistyped is not the same as one they never set.
 */
export function parseBound(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  // Exact non-negative decimal integers only: no signs, no fractions, no 0x, no numeric prefixes.
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

export interface DepthConfig {
  depth: number;
  maxDepth: number;
  /** Names of the variables that were set but unreadable, for an operator-facing warning. */
  malformed: string[];
}

/**
 * Resolve this session's depth bounds, failing closed on anything malformed.
 *
 * **Malformed input disables spawning entirely (`maxDepth: 0`)** rather than falling back to a default,
 * and that applies to a bad `PI_GRANTS_DEPTH` just as much as a bad `PI_GRANTS_MAX_DEPTH`. The old
 * `|| 0` guard on depth failed open in a subtler way than the missing guard on maxDepth: a session that
 * could not read its own depth was treated as a **root**, which is the most permissive answer available
 * and precisely the value an attacker would choose. If we do not know how deep we are, we must not spawn.
 */
export function depthConfig(depthRaw: string | undefined, maxDepthRaw: string | undefined): DepthConfig {
  const depth = parseBound(depthRaw);
  const maxDepth = parseBound(maxDepthRaw);
  const malformed: string[] = [];
  if (depth === null) malformed.push(ENV_DEPTH);
  if (maxDepth === null) malformed.push(ENV_MAX_DEPTH);

  if (malformed.length > 0) return { depth: depth ?? 0, maxDepth: 0, malformed };
  return { depth: depth ?? 0, maxDepth: maxDepth ?? DEFAULT_MAX_DEPTH, malformed };
}

/** The documented default child-depth bound when `PI_GRANTS_MAX_DEPTH` is not set. */
export const DEFAULT_MAX_DEPTH = 2;

/**
 * Gated by default in a governed session (ADR-0012).
 *
 * `bash` is not one capability among others; it is an execution primitive. A child holding it can run
 * `env -u PI_GRANTS_GRANT pi …` and obtain a completely **ungoverned** descendant — measured, not
 * theorised (`docs/probes/g5-bash-escape`). Handing that down silently is the thing worth changing.
 *
 * Subsumption-aware gating (also ADR-0012) means this single entry covers `write`, `edit`, `read`,
 * `grep`, `find` and `ls` as well, since `bash` confers all of them.
 */
export const DEFAULT_GATED: Capability[] = ["tool:bash"];

/**
 * Read the gate list, distinguishing **absent** from **explicitly empty**.
 *
 * `parseList` alone cannot: it maps both `undefined` and `""` to `[]`. That distinction is the operator's
 * only way to turn the default off — without it, someone who wants no gates would have to stop governing
 * altogether, which is strictly worse than the thing they were trying to avoid.
 */
export function gatedFromEnv(raw: string | undefined): Capability[] {
  if (raw === undefined) return [...DEFAULT_GATED];
  return parseList(raw);
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
  /**
   * Approvals eligible to cross the boundary (ADR-0014): capability, subject and scope. `once` is
   * dropped by `inheritApprovals`, and the subject is preserved so it cannot satisfy another one.
   */
  approved?: InheritableApproval[];
  ledgerPath?: string;
  /**
   * Whether THIS session is governed — i.e. `PI_GRANTS_GRANT` was set for it.
   *
   * G7 / B-I8. Governance is opt-in: with the variable unset the README promises "nothing is blocked".
   * That was true of the session itself and false of its children, because this function still exported
   * a grant, a depth and a bound, so an ungoverned parent silently started governing its descendants —
   * and the grant it exported was its own observed tool surface, which is a real restriction arrived at
   * by accident. An ungoverned session must be transparent, not a source of policy.
   *
   * Defaults to `true` so that every existing caller keeps publishing; only the extension, which alone
   * knows whether the variable was set, passes `false`.
   */
  governed?: boolean;
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
/**
 * The part of a grant a child may inherit: everything but the wildcards that are HELD, never handed down.
 *
 * `tool:*` for R-26's reason — a root that handed it down let every descendant reacquire the full catalog.
 * `workspace:*` for the same reason one namespace over (R-131): a descendant holding it could route anywhere
 * the registry lists, which is the attenuation failure ADR-0035 exists to close. `agent:*` is deliberately
 * NOT stripped — ADR-0023 decided that a session authorised for any definition passes that on, because
 * definitions are ceilings rather than roots.
 *
 * **Exported, and there is exactly one spelling of this rule on purpose.** It shipped as a filter inline in
 * `childEnv` and nowhere else, so a grant travelling the OTHER path — `delegate.ts` building a child's
 * `PI_GRANTS_GRANT` from `result.effective` — carried `workspace:*` straight down. The test written beside
 * that fix exercised `childEnv`, which is not the path a delegated child's grant travels, so it could not
 * catch it. R-28's shape: two routes for one rule, with the guard on the quieter one. Both call this now.
 */
export function inheritableGrant(grant: readonly Capability[]): Capability[] {
  return grant.filter((c) => c !== WILDCARD && c !== WORKSPACE_WILDCARD);
}

export function childEnv(input: ChildEnvInput): Record<string, string> {
  if (input.governed === false) return {};
  const inheritable = inheritableGrant(input.ownGrant);
  const env: Record<string, string> = {
    [ENV_GRANT]: (assertCapabilitiesArePropagatable(inheritable), inheritable.join(",")),
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
