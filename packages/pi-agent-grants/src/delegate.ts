/**
 * Governed delegation — provisioning, not merely enforcement.
 *
 * The `tool_call` interceptor can only *permit or refuse* a `pi-subagents` spawn, because that package's
 * `Agent` tool has no `tools` parameter. When we do the spawning ourselves the grant becomes an argument,
 * which is what "give them some tools but not others" actually requires.
 *
 * Two properties fall out of owning the spawn:
 *
 *  1. **No propagation race at all.** Each child receives its own explicit `env` object, so nothing is
 *     written to the shared `process.env`. The interceptor's constraint (only parent-level facts may be
 *     pushed, because the channel is global) does not apply here.
 *  2. **Depth control by capability.** `tool:delegate` is itself a capability. Grant it and the child can
 *     sub-delegate; withhold it and the child is a leaf. No separate depth mechanism is required, though
 *     `maxDepth` remains as a cheap backstop.
 */

import { planSpawn } from "./spawn.ts";
import { resolve, assertNarrowing, type Capability, type ResolveResult } from "./resolve.ts";
import { ENV_APPROVED, ENV_DEPTH, ENV_GATED, ENV_GRANT, ENV_LEDGER, ENV_MAX_DEPTH } from "./propagation.ts";
import { inheritApprovals, type InheritableApproval } from "./approval.ts";
import { unknownCapabilities, type Catalog } from "./catalog.ts";

/** The tool name that confers the ability to delegate further. */
export const DELEGATE_CAPABILITY: Capability = "tool:delegate";

/** Accept `read` or `tool:read` or `ext:pkg/tool` and normalise to a capability id. */
export function normaliseCapability(raw: string): Capability {
  const value = raw.trim();
  if (value.startsWith("tool:") || value.startsWith("ext:") || value.startsWith("skill:") || value.startsWith("agent:")) {
    return value;
  }
  return `tool:${value}`;
}

export interface DelegationRequest {
  task: string;
  /** Capabilities the delegator wants the child to hold. */
  tools: string[];
  model?: string;
  provider?: string;
  thinking?: string;
}

export interface DelegationContext {
  ownGrant: Capability[];
  depth: number;
  maxDepth: number;
  gated: Capability[];
  /**
   * Approvals in force for this delegation, with subject and scope (ADR-0014).
   *
   * One source of truth for two different questions. The **gate check here** honours every entry,
   * including `once` — that approval applies to *this* spawn, which is exactly what the human said yes
   * to. What crosses to the CHILD is `inheritApprovals`, which drops `once` and keeps the subject, so
   * the same list cannot silently authorise a subtree.
   */
  approved?: InheritableApproval[];
  ledgerPath?: string;
  /** Path to this extension, so a child granted `tool:delegate` can delegate in turn. */
  extensionPath?: string;
  /** Live capability catalog. When supplied, capabilities absent from it are refused as unknown. */
  catalog?: Catalog;
}

export interface Delegation {
  ok: boolean;
  reason?: string;
  args: string[];
  /** Per-child environment — never merged into the parent's process.env. */
  env: Record<string, string>;
  effective: Capability[];
  /**
   * The result this plan was made from. **Required** (B-I3): while it was optional the extension
   * guarded its ledger write with `if (ledgerPath && plan.result)`, silently dropping every refusal
   * that returned before `resolve()` ran. The type is what keeps a new early exit auditable.
   */
  result: ResolveResult;
  childDepth: number;
}

/**
 * Plan a governed delegation. Pure: returns argv and env, spawns nothing.
 *
 * Fails closed on depth, on any requested capability the delegator does not hold, on gated capabilities
 * without approval, and on a grant that cannot narrow (a universal capability slipping through).
 */
export function planDelegation(request: DelegationRequest, ctx: DelegationContext): Delegation {
  const childDepth = ctx.depth + 1;
  // G6 / B-I3: every refusal carries a result, including the four below that return before `resolve()`
  // is ever called. The extension guarded its ledger write with `if (ledgerPath && plan.result)`, so
  // those four governance decisions — disabled, too deep, no task, unknown capability — were never
  // audited at all. An empty result is the honest record: nothing was resolved, and that is the fact.
  const empty: Delegation = {
    ok: false,
    args: [],
    env: {},
    effective: [],
    childDepth,
    result: { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
  };

  if (ctx.maxDepth <= 0) return { ...empty, reason: "delegation is disabled (maxDepth 0)" };
  if (childDepth > ctx.maxDepth) {
    return { ...empty, reason: `delegation depth limit reached (${ctx.maxDepth})` };
  }
  if (!request.task?.trim()) return { ...empty, reason: "a delegation needs a task" };

  const requested = request.tools.map(normaliseCapability);

  // Unknown is reported before denied, and separately: "does not exist here" and "you lack authority"
  // have different causes and different fixes. Collapsing them hides typos and stale grants.
  if (ctx.catalog) {
    const unknown = unknownCapabilities(requested, ctx.catalog);
    if (unknown.length > 0) {
      return {
        ...empty,
        reason:
          `unknown capabilit${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")} — not present in ` +
          `this session's catalog (typo, or an uninstalled package?)`,
      };
    }
  }

  const result = resolve({
    requested,
    parentGrant: ctx.ownGrant,
    gated: ctx.gated,
    approved: (ctx.approved ?? []).map((a) => a.capability),
  });

  if (result.denied.length > 0) {
    return {
      ...empty,
      result,
      reason: `cannot grant ${result.denied.join(", ")} — this session does not hold it (capability escalation blocked)`,
    };
  }
  // ADR-0011: narrowing is checked BEFORE the gate, and the order is load-bearing rather than
  // stylistic. `assertNarrowing` refuses regardless of approval, so with the old order this returned
  // "requires explicit approval" for a delegation that could never be approved — telling the operator
  // to go and find a human who cannot help. `shouldSeekApproval` now also refuses to prompt in this
  // case; this reordering makes the reported *reason* agree with what actually blocks the spawn.
  try {
    assertNarrowing(result);
  } catch (error) {
    return { ...empty, result, reason: String(error instanceof Error ? error.message : error) };
  }
  if (result.gatedBlocked.length > 0) {
    return { ...empty, result, reason: `${result.gatedBlocked.join(", ")} requires explicit approval` };
  }

  const canSubDelegate = result.effective.includes(DELEGATE_CAPABILITY);
  const plan = planSpawn({
    effective: result.effective,
    prompt: request.task,
    model: request.model,
    provider: request.provider,
    thinking: request.thinking,
  });

  // A child may only delegate further if it was granted the capability AND has the extension to do it.
  const args = [...plan.args];
  if (canSubDelegate && ctx.extensionPath) {
    // `-e` loads even under `--no-extensions`, which planSpawn sets — that is precisely why the
    // extension is added explicitly here and nowhere else.
    args.splice(args.length - 1, 0, "-e", ctx.extensionPath);
  }

  const env: Record<string, string> = {
    [ENV_GRANT]: result.effective.join(","),
    [ENV_DEPTH]: String(childDepth),
    [ENV_MAX_DEPTH]: String(ctx.maxDepth),
  };
  if (ctx.gated.length > 0) env[ENV_GATED] = ctx.gated.join(",");
  // Approvals ride down with the grant, but only ever for what this child actually received — so
  // `approved ⊆ grant` holds at every level (ADR-0010). Written even when empty, so this object states
  // the child's approval set outright rather than leaving it to whatever the caller merges over; see
  // `mergeChildEnv`, which is what actually stops the parent's value leaking through.
  env[ENV_APPROVED] = inheritApprovals(ctx.approved ?? [], result.effective).join(",");
  if (ctx.ledgerPath) env[ENV_LEDGER] = ctx.ledgerPath;

  return { ok: true, args, env, effective: result.effective, result, childDepth };
}
