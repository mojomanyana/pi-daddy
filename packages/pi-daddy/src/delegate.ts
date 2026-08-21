/**
 * Governed delegation planning. Owning the spawn makes the grant an argument; each child receives its own
 * environment, and `tool:delegate` determines whether it is a delegator or a leaf.
 */

import { planSpawn } from "./spawn.ts";
import { ceilingForDefinition, digestDefinition, type DefinitionDigest, type SkillDefinition } from "./definitions.ts";
import { WORKSPACE_WILDCARD, assertNarrowing, type Capability, type ResolveResult } from "./resolve.ts";
import {
  DELEGATE_CAPABILITY,
  agentCapability,
  mayRouteToWorkspace,
  maySpawnDefinition,
  normaliseCapability,
  workspaceCapability,
} from "./capabilities.ts";

// Re-exported so the split stays internal: `delegate.ts` has been the import site for these since 0.6.0 and
// four modules plus the test suite name it. Moving the definitions without moving the door would be churn
// charged to every caller for a line count they did not cause.
export { DELEGATE_CAPABILITY, agentCapability, maySpawnDefinition, normaliseCapability } from "./capabilities.ts";
import {
  ENV_APPROVED, ENV_DEPTH, ENV_FANOUT, ENV_GATED, ENV_GRANT, ENV_LEDGER, ENV_MAX_DEPTH, ENV_PARENT_ID,
  inheritableGrant,
} from "./propagation.ts";
import { inheritApprovals, type InheritableApproval } from "./approval.ts";
import { suggestForUnknown, unknownCapabilities, type Catalog } from "./catalog.ts";
import { GovernanceRefusal, refusal, type RefusalCode, type StructuredRefusal } from "./refusals.ts";
import {
  digestTask,
  normaliseCorrelation,
  type ApprovalBinding,
  type CorrelationMetadata,
} from "./correlation.ts";
import { resolveDelegationApproval } from "./delegation-approval.ts";
import type { Delegation, DelegationContext, DelegationRequest } from "./delegate-types.ts";
import { assertCapabilitiesArePropagatable, isWellFormedCapability } from "./capabilities.ts";
export type { Delegation, DelegationContext, DelegationRequest } from "./delegate-types.ts";

export function planDelegation(request: DelegationRequest, ctx: DelegationContext): Delegation {
  const childDepth = ctx.depth + 1;
  const denied = (plan: Delegation, code: RefusalCode): Delegation =>
    plan.reason ? { ...plan, refusal: refusal(code, plan.reason) } : plan;
  // G6 / B-I3: every refusal carries a result, including the four below that return before `resolve()`
  // is ever called. The extension guarded its ledger write with `if (ledgerPath && plan.result)`, so
  // those four governance decisions — disabled, too deep, no task, unknown capability — were never
  // audited at all. An empty result is the honest record: nothing was resolved, and that is the fact.
  // Bounded/whitelisted correlation is a REFUSAL, not an exception escaping the planner. It is reachable
  // from a model-facing tool parameter on all three delegation tools, and throwing from here produced a
  // governed refusal with no code and no ledger line at all — the ledger file was never even created
  // (R-112). Caught here so it becomes an ordinary recorded decision.
  let correlation: CorrelationMetadata | undefined;
  let correlationRefused: StructuredRefusal | undefined;
  try {
    correlation = normaliseCorrelation(request.correlation);
  } catch (error) {
    correlationRefused = error instanceof GovernanceRefusal
      ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
      : refusal("CORRELATION_INVALID", String(error instanceof Error ? error.message : error));
  }
  const taskDigest = digestTask(request.task ?? "");
  const empty: Delegation = {
    ok: false,
    args: [],
    env: {},
    effective: [],
    childDepth,
    requested: [],
    taskDigest,
    ...(correlation ? { correlation } : {}),
    result: { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
  };

  if (correlationRefused) {
    return { ...empty, reason: correlationRefused.message, refusal: correlationRefused };
  }
  if (ctx.maxDepth <= 0) {
    return denied({ ...empty, reason: "delegation is disabled (maxDepth 0)" }, "DEPTH_EXCEEDED");
  }
  if (childDepth > ctx.maxDepth) {
    return denied({ ...empty, reason: `delegation depth limit reached (${ctx.maxDepth})` }, "DEPTH_EXCEEDED");
  }
  if (!request.task?.trim()) return denied({ ...empty, reason: "a delegation needs a task" }, "TASK_MISSING");

  // ADR-0035. Routing a child to a registered workspace is an authority the CALLER must hold, checked here
  // for the same reason `maySpawnDefinition` is checked below: it is a governance question about this
  // session, answerable before anything is said about the target.
  //
  // Recorded as a denial rather than a bare refusal, exactly as DEFINITION_NOT_AUTHORIZED is: asking to
  // route somewhere this session was not granted IS an attempt to exceed the grant, so it belongs in
  // `denied` where `isEscalationAttempt` and every audit query can see it. Before this, nothing checked —
  // the registry inherited into every child and a child routed to `staging` could route its grandchild to
  // `prod` (R-131, measured in `docs/probes/g36-workspace-attenuation`).
  //
  // Well-formedness FIRST, because `boundWorkspaceId` is a model-facing tool parameter and the next line
  // turns it into a capability id. `workspace_id: "prod,tool:bash"` produced a WORKSPACE_NOT_AUTHORIZED
  // whose `denied` array held `workspace:prod,tool:bash` — no authority minted (the refusal is terminal),
  // but `denied` is the channel `isEscalationAttempt` and `/grants ledger` count, and seeding it with an id
  // that re-splits into two capabilities makes the one signal that matters unparseable. `GRANT_ID_MALFORMED`
  // already exists and says the true thing; 0.18.1 is what happens when a comma goes unremarked.
  if (request.boundWorkspaceId && !isWellFormedCapability(workspaceCapability(request.boundWorkspaceId))) {
    return denied({
      ...empty,
      reason:
        `workspace id ${JSON.stringify(request.boundWorkspaceId)} is not usable as a capability id — it ` +
        `would become ${JSON.stringify(workspaceCapability(request.boundWorkspaceId))}, and a grant is ` +
        `comma-separated, so this would be read as several capabilities.`,
    }, "GRANT_ID_MALFORMED");
  }
  if (request.boundWorkspaceId && !mayRouteToWorkspace(ctx.ownGrant, request.boundWorkspaceId)) {
    const authorising = workspaceCapability(request.boundWorkspaceId);
    const held = ctx.ownGrant.filter((c) => c.startsWith("workspace:")).sort();
    return denied({
      ...empty,
      requested: [authorising],
      result: { ...empty.result, denied: [authorising] },
      reason:
        `cannot route a child to workspace "${request.boundWorkspaceId}" — this session does not hold ` +
        `${authorising}. ` +
        (held.length > 0
          ? `It may route to: ${held.join(", ")}.`
          : `It may route to no workspace at all; add ${authorising} to its grant to allow this one.`),
    }, "WORKSPACE_NOT_AUTHORIZED");
  }

  // ADR-0016. A named definition replaces the model's tool list with an operator-authored ceiling.
  let requested: Capability[];
  let systemPrompt: string | undefined;
  let definitionDigest: DefinitionDigest | undefined;
  /** The definition being spawned, hoisted so the gate below can name its authorising id (ADR-0024). */
  let spawned: SkillDefinition | undefined;

  if (request.agent) {
    const definition = ctx.definitions?.get(request.agent);
    spawned = definition;
    // No fallback, deliberately. pi-subagents resolves an unknown type to `general-purpose`, whose
    // omitted tool list means EVERY tool — so a typo there granted the full surface. An unknown name
    // here is simply an error.
    if (!definition) {
      const known = [...(ctx.definitions?.keys() ?? [])].sort();
      return denied({
        ...empty,
        reason:
          `unknown agent "${request.agent}"` +
          (known.length > 0 ? ` — known definitions: ${known.join(", ")}` : " — no definitions were found"),
      }, "UNKNOWN_DEFINITION");
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
      return denied({
        ...empty,
        requested: [authorising],
        result: { ...empty.result, denied: [authorising] },
        reason:
          `cannot spawn "${definition.name}" — this session does not hold ${authorising} ` +
          `(the definition lives at ${definition.source}). ` +
          (held.length > 0
            ? `It may spawn: ${held.join(", ")}.`
            : `It may spawn no definitions at all; add ${authorising} to its grant to allow this one.`),
      }, "DEFINITION_NOT_AUTHORIZED");
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
      return denied({
        ...empty,
        reason:
          `agent "${definition.name}" declares no \`allowed-tools\`, so it cannot be spawned — add one ` +
          `to ${definition.source}. An undeclared capability set is treated as NONE, never as everything.`,
      }, "UNDECLARED_TOOLS");
    }
    if (ceiling.patterns.length > 0) {
      return denied({
        ...empty,
        reason:
          `agent "${definition.name}" restricts a tool with a pattern (${ceiling.patterns.join(", ")}), ` +
          `which pi's --tools cannot express — it matches whole tool names only. Granting the bare tool ` +
          `would widen the declaration and dropping it would silently narrow, so neither is done.`,
      }, "CEILING_PATTERNS_UNRESOLVED");
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
      // Name the likely intent where there is one. `ceilingForDefinition` refuses to TRANSLATE names
      // (lowercasing and no more), so an author who wrote Claude Code's `Glob` gets `tool:glob` and a
      // refusal — correct, and previously unhelpful, because pi's equivalent is `find` and no amount of
      // staring at "not present in this session's catalog" says so. The hint changes nothing about the
      // refusal; it just stops the author having to guess which of nine built-ins was meant.
      const hints = unknown
        .map((c) => {
          const s = suggestForUnknown(c, ctx.catalog!);
          return s === null ? null : `${c} → did you mean ${s}?`;
        })
        .filter((h): h is string => h !== null);
      return denied({
        ...empty,
        requested,
        reason:
          `unknown capabilit${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")} — not present in ` +
          `this session's catalog (typo, or an uninstalled package?)` +
          (hints.length > 0 ? ` — ${hints.join("; ")}` : ""),
      }, "UNKNOWN_TOOL");
    }
  }

  // ADR-0035, and the reason this is a REFUSAL rather than a silent strip. `workspace:*` is held and never
  // inherited, so a child that "was granted" it would receive an env without it — the ledger would record
  // an authority the child does not have, which is the mirror image of the defect R-131 records and just as
  // unreadable. `childEnv` strips it from a session's OWN grant because a root legitimately holds it; asking
  // to hand it to a child is a different act, and the honest answer is no.
  //
  // `NARROWING_VIOLATED` is the existing code for "this grant would not actually narrow", which is exactly
  // what handing routing authority over every registered root to a child does. `tool:*` reaches the same
  // outcome through `assertNarrowing` below; this is that rule, one namespace over.
  if (requested.includes(WORKSPACE_WILDCARD)) {
    return denied({
      ...empty,
      requested,
      reason:
        `cannot grant ${WORKSPACE_WILDCARD} to a child — it is held, never inherited, because a descendant ` +
        `holding it could route anywhere the registry lists and routing would stop attenuating below here. ` +
        `Name the workspaces this child may route to instead (workspace:<id>, one per id).`,
    }, "NARROWING_VIOLATED");
  }

  const { result, approvalBinding, bindingMismatch } = resolveDelegationApproval({
    task: request.task,
    agent: request.agent,
    boundWorkspaceId: request.boundWorkspaceId,
    boundContextId: request.boundContextId,
    requested,
    parentGrant: ctx.ownGrant,
    gated: ctx.gated,
    approved: ctx.approved,
    spawned,
    definitionDigest,
    correlation,
    parentId: ctx.spawnId ?? `d${ctx.depth}`,
  });
  if (approvalBinding) Object.assign(empty, { approvalBinding });

  if (result.denied.length > 0) {
    return denied({
      ...empty,
      requested,
      result,
      reason: `cannot grant ${result.denied.join(", ")} — this session does not hold it (capability escalation blocked)`,
    }, "CAPABILITY_ESCALATION");
  }
  // ADR-0011: narrowing is checked BEFORE the gate, and the order is load-bearing rather than
  // stylistic. `assertNarrowing` refuses regardless of approval, so with the old order this returned
  // "requires explicit approval" for a delegation that could never be approved — telling the operator
  // to go and find a human who cannot help. `shouldSeekApproval` now also refuses to prompt in this
  // case; this reordering makes the reported *reason* agree with what actually blocks the spawn.
  try {
    assertNarrowing(result);
  } catch (error) {
    // ADR-0011's narrowing invariant is the hardest rule this package enforces, and it was the one
    // refusal an external controller could not identify by code (R-109).
    return denied(
      { ...empty, requested, result, reason: String(error instanceof Error ? error.message : error) },
      "NARROWING_VIOLATED",
    );
  }
  if (result.gatedBlocked.length > 0) {
    const code = bindingMismatch ? "APPROVAL_SCOPE_MISMATCH" : "GATED_UNAPPROVED";
    const suffix = bindingMismatch ? " (an approval exists, but its task/workspace/context scope does not match)" : "";
    return denied(
      { ...empty, requested, result, reason: `${result.gatedBlocked.join(", ")} requires explicit approval${suffix}` },
      code,
    );
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
    return denied({
      ...empty,
      requested,
      result,
      reason:
        `cannot locate ${plan.unresolvedSkills.join(", ")} on disk — granted but unresolvable, so the ` +
        `child would silently lack it`,
    }, "DEFINITION_UNREADABLE");
  }

  // A child may only delegate further if it was granted the capability AND has the extension to do it.
  const args = [...plan.args];
  if (canSubDelegate && ctx.extensionPath) {
    // `-e` loads even under `--no-extensions`, which planSpawn sets — that is precisely why the
    // extension is added explicitly here and nowhere else.
    args.splice(args.length - 1, 0, "-e", ctx.extensionPath);
  }

  // `inheritableGrant`, not `result.effective` directly: this is the path a DELEGATED child's grant
  // actually travels, and the "held but never inherited" rule for `tool:*` and `workspace:*` was enforced
  // only in `childEnv`. A parent holding `workspace:*` could request it for its child and this line handed
  // it over, so the rule ADR-0035 advertises held by accident — masked downstream rather than enforced
  // here. One spelling of the rule, called from both paths.
  const inheritable = inheritableGrant(result.effective);
  const env: Record<string, string> = {
    [ENV_GRANT]: (assertCapabilitiesArePropagatable(inheritable), inheritable.join(",")),
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
  // Clamped to what the child actually INHERITS, not to what it was granted. The two differ only for a
  // non-inheritable wildcard, and passing down an approval for a capability the child does not hold would
  // leave banked authority with nothing to spend it on — `childEnv` clamps to `inheritable` for the same
  // reason on the other path.
  env[ENV_APPROVED] = inheritApprovals(ctx.approved ?? [], inheritable).join(",");
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
    taskDigest,
    ...(correlation ? { correlation } : {}),
    ...(approvalBinding ? { approvalBinding } : {}),
    ...(definitionDigest ? { definitionDigest } : {}),
  };
}
