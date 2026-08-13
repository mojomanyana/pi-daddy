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
import { ceilingForDefinition, digestDefinition, type DefinitionDigest, type SkillDefinition } from "./definitions.ts";
import { AGENT_WILDCARD, resolve, assertNarrowing, type Capability, type ResolveResult } from "./resolve.ts";
import { ENV_APPROVED, ENV_DEPTH, ENV_FANOUT, ENV_GATED, ENV_GRANT, ENV_LEDGER, ENV_MAX_DEPTH, ENV_PARENT_ID } from "./propagation.ts";
import { inheritApprovals, type InheritableApproval } from "./approval.ts";
import { unknownCapabilities, type Catalog } from "./catalog.ts";
import { WILDCARD } from "./pi-tools.ts";

/** The capability that authorises spawning a definition (ADR-0017). `tool:*` satisfies any of them. */
export const agentCapability = (name: string): Capability => `agent:${name}`;

/**
 * May this grant spawn that definition? (ADR-0017.)
 *
 * `resolve()` is exact-match plus subsumption and has no wildcard rule — a wildcard session works only
 * because `deriveOwnGrant` *enumerates* its observed tools alongside `tool:*`. Definitions are not tools,
 * so nothing enumerates them, and the wildcard has to be honoured here explicitly. Without that an
 * UNGOVERNED session would stop being able to spawn, and "governance is opt-in" is the one rule this
 * package must never break by accident.
 */
export function maySpawnDefinition(ownGrant: Capability[], name: string): boolean {
  // ADR-0023 adds the middle case. `tool:*` is authority to grant every tool and satisfies this too;
  // `agent:*` is authority to spawn any definition and grants no tools at all, which is the configuration
  // an operator wanting "any of our definitions, narrow tools" previously had to fake with `tool:*`.
  return (
    ownGrant.includes(WILDCARD) ||
    ownGrant.includes(AGENT_WILDCARD) ||
    ownGrant.includes(agentCapability(name))
  );
}

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
  /**
   * Capabilities the delegator wants the child to hold.
   *
   * Optional since ADR-0016: prefer `agent`, which names an operator-authored definition. This form
   * lets the MODEL choose the capability set, which is the weaker arrangement — it is still bounded by
   * the session grant (ADR-0008), so it cannot escalate, but nothing about it was reviewed by a human.
   */
  tools?: string[];
  /**
   * Name of a `SKILL.md` definition to spawn (ADR-0016).
   *
   * When given, the definition's `allowed-tools` is the ceiling and its body is the child's system
   * prompt. The model chooses only *which* definition and *what* task; the capability set is the
   * operator's, written down in a file.
   */
  agent?: string;
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
  /**
   * Absolute path per skill NAME, from the catalog's `source` field (R-32).
   *
   * Without it every granted `skill:` capability is unresolvable and the delegation is refused, which
   * is the correct direction: a caller that cannot say where a skill lives cannot honestly grant it.
   */
  skillPaths?: Record<string, string>;
  /** Let the child load `AGENTS.md` / `CLAUDE.md`. Default false — see `planSpawn`. */
  contextFiles?: boolean;
  /** Known `SKILL.md` definitions by name, for `DelegationRequest.agent` (ADR-0016). */
  definitions?: Map<string, SkillDefinition>;
  /**
   * Build an INTERACTIVE plan — no `--print` — for an executor that drives the child after starting it.
   *
   * `runHerdrPane` requires this: `--print` makes pi process the prompt and exit, so it never reaches the
   * interactive readiness `herdr agent start` waits for and the agent is never detected. Default is the
   * non-interactive plan, because a governed child should not sit waiting for a human by accident.
   */
  interactive?: boolean;
  /**
   * Total descendants this session may still create (`src/fanout.ts`). Split among children by the caller.
   *
   * Omitted means unbounded, which is the pre-fan-out behaviour and correct for a single blocking
   * delegation — the accident that used to bound cardinality to one.
   */
  fanoutBudget?: number;
  /** This session's ledger id, so a child's `parentId` names its real parent (F8). */
  spawnId?: string;
  /** Ledger id assigned to THIS child, distinguishing it from its siblings (F8). */
  childSpawnId?: string;
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
  /**
   * The capabilities this delegation asked for, whatever route named them.
   *
   * Carried on the plan rather than re-derived by the caller (the B-I3 lesson): with `agent`, the
   * request names a DEFINITION and the capabilities come from its `allowed-tools`, so a ledger that
   * read the tool parameters would record an empty request for every definition spawn.
   */
  requested: Capability[];
  /** Ledger id for this child, if the caller assigned one (F8). */
  childId?: string;
  /**
   * Which operator-authored instructions this spawn used (ADR-0018).
   *
   * Absent for a `tools:`-style delegation, which has no definition and therefore no instructions to
   * identify — and absent on an ADR-0017 authorisation refusal, which is decided before the file is read.
   */
  definitionDigest?: DefinitionDigest;
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
    requested: [],
    result: { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
  };

  if (ctx.maxDepth <= 0) return { ...empty, reason: "delegation is disabled (maxDepth 0)" };
  if (childDepth > ctx.maxDepth) {
    return { ...empty, reason: `delegation depth limit reached (${ctx.maxDepth})` };
  }
  if (!request.task?.trim()) return { ...empty, reason: "a delegation needs a task" };

  // ADR-0016. A named definition replaces the model's tool list with an operator-authored ceiling.
  let requested: Capability[];
  let systemPrompt: string | undefined;
  let definitionDigest: DefinitionDigest | undefined;

  if (request.agent) {
    const definition = ctx.definitions?.get(request.agent);
    // No fallback, deliberately. pi-subagents resolves an unknown type to `general-purpose`, whose
    // omitted tool list means EVERY tool — so a typo there granted the full surface. An unknown name
    // here is simply an error.
    if (!definition) {
      const known = [...(ctx.definitions?.keys() ?? [])].sort();
      return {
        ...empty,
        reason:
          `unknown agent "${request.agent}"` +
          (known.length > 0 ? ` — known definitions: ${known.join(", ")}` : " — no definitions were found"),
      };
    }

    // ADR-0017: authorisation comes BEFORE anything is said about the file. Which definitions this
    // session may spawn is a governance question about the SESSION; whether the file declares its tools
    // properly is a diagnostic about the DEFINITION, and answering the second one first would report a
    // malformed-file error to a caller who was never allowed to spawn it either way.
    //
    // Recorded as a denial rather than a bare refusal, deliberately: `denied` is the escalation signal
    // ADR-0008 designates, and asking to run a definition this session was not granted IS an attempt to
    // exceed the grant. A refusal that left `denied` empty would keep it out of every audit query.
    if (!maySpawnDefinition(ctx.ownGrant, definition.name)) {
      const authorising = agentCapability(definition.name);
      const held = ctx.ownGrant.filter((c) => c.startsWith("agent:")).sort();
      return {
        ...empty,
        requested: [authorising],
        result: { ...empty.result, denied: [authorising] },
        reason:
          `cannot spawn "${definition.name}" — this session does not hold ${authorising} ` +
          `(the definition lives at ${definition.source}). ` +
          (held.length > 0
            ? `It may spawn: ${held.join(", ")}.`
            : `It may spawn no definitions at all; add ${authorising} to its grant to allow this one.`),
      };
    }

    // ADR-0018. Recorded from here on — after authorisation, because the digest is a fact about a file
    // this caller was allowed to read, and before every remaining outcome, because a spawn refused for a
    // malformed declaration is still a spawn of THIS version of the definition.
    //
    // Assigned into `empty`, which every subsequent refusal spreads. That is the R-28 discipline applied
    // to a record field rather than an argument: instead of eight `definitionDigest` spellings that a
    // ninth return could forget, there is one, and forgetting it is not expressible. The success return
    // does not spread `empty`, so it names the field explicitly.
    definitionDigest = digestDefinition(definition);
    Object.assign(empty, { definitionDigest });

    const ceiling = ceilingForDefinition(definition);
    if (ceiling.undeclared) {
      return {
        ...empty,
        reason:
          `agent "${definition.name}" declares no \`allowed-tools\`, so it cannot be spawned — add one ` +
          `to ${definition.source}. An undeclared capability set is treated as NONE, never as everything.`,
      };
    }
    if (ceiling.patterns.length > 0) {
      return {
        ...empty,
        reason:
          `agent "${definition.name}" restricts a tool with a pattern (${ceiling.patterns.join(", ")}), ` +
          `which pi's --tools cannot express — it matches whole tool names only. Granting the bare tool ` +
          `would widen the declaration and dropping it would silently narrow, so neither is done.`,
      };
    }
    requested = ceiling.capabilities;
    systemPrompt = definition.body;
  } else {
    requested = (request.tools ?? []).map(normaliseCapability);
  }

  // Unknown is reported before denied, and separately: "does not exist here" and "you lack authority"
  // have different causes and different fixes. Collapsing them hides typos and stale grants.
  if (ctx.catalog) {
    const unknown = unknownCapabilities(requested, ctx.catalog);
    if (unknown.length > 0) {
      return {
        ...empty,
        requested,
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
      requested,
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
    return { ...empty, requested, result, reason: String(error instanceof Error ? error.message : error) };
  }
  if (result.gatedBlocked.length > 0) {
    return { ...empty, requested, result, reason: `${result.gatedBlocked.join(", ")} requires explicit approval` };
  }

  const canSubDelegate = result.effective.includes(DELEGATE_CAPABILITY);
  const plan = planSpawn({
    effective: result.effective,
    prompt: request.task,
    model: request.model,
    provider: request.provider,
    thinking: request.thinking,
    skillPaths: ctx.skillPaths,
    contextFiles: ctx.contextFiles,
    systemPrompt,
    print: ctx.interactive ? false : undefined,
  });

  // R-32. A `skill:` capability the catalog cannot place is refused rather than dropped. Dropping it
  // would hand back a child whose grant claims a skill it does not have — the ledger would record a
  // capability that never reached the process, which is precisely the kind of lie an audit trail must
  // not contain. `unknownCapabilities` above catches names absent from the catalog entirely; this
  // catches one that is known but whose path we could not resolve, which is a different fault.
  if (plan.unresolvedSkills.length > 0) {
    return {
      ...empty,
      requested,
      result,
      reason:
        `cannot locate ${plan.unresolvedSkills.join(", ")} on disk — granted but unresolvable, so the ` +
        `child would silently lack it`,
    };
  }

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
  // The child's own share of the subtree budget, and its identity. Both attenuate downward like depth: a
  // child can never be handed more budget than its parent had left, so the total bound holds across
  // process boundaries with no shared state.
  if (ctx.fanoutBudget !== undefined) env[ENV_FANOUT] = String(ctx.fanoutBudget);
  if (ctx.childSpawnId) env[ENV_PARENT_ID] = ctx.childSpawnId;
  if (ctx.gated.length > 0) env[ENV_GATED] = ctx.gated.join(",");
  // Approvals ride down with the grant, but only ever for what this child actually received — so
  // `approved ⊆ grant` holds at every level (ADR-0010). Written even when empty, so this object states
  // the child's approval set outright rather than leaving it to whatever the caller merges over; see
  // `mergeChildEnv`, which is what actually stops the parent's value leaking through.
  env[ENV_APPROVED] = inheritApprovals(ctx.approved ?? [], result.effective).join(",");
  if (ctx.ledgerPath) env[ENV_LEDGER] = ctx.ledgerPath;

  return {
    ok: true,
    args,
    env,
    effective: result.effective,
    result,
    childDepth,
    requested,
    childId: ctx.childSpawnId,
    ...(definitionDigest ? { definitionDigest } : {}),
  };
}
