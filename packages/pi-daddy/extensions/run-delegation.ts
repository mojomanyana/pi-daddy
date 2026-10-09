import {
  claimDelegationOperation,
  existingOperationOutcome,
  finishDelegationOperation,
} from "./delegation-operations.ts";
import type { OperationClaim } from "../src/kernel/dispatch-operation.ts";
import { reconcileDelegationCapacity, reserveDelegationCapacity } from "./session-capacity.ts";
import type { CapacityReservation } from "../src/kernel/capacity.ts";
import { assertDefinitionIdentity } from "./definition-describe.ts";
/**
 * Plan, gate, audit and run ONE governed child — the whole of a delegation except its tool surface.
 *
 * Split from `extensions/delegation.ts` when ADR-0019 pushed that file to 403 lines and
 * `test/file-size.test.ts` refused it. Raising the cap the day after adding it would have neutered the
 * guard, so the file was split the way the failure message said to. The seam is the natural one: this
 * module is *what a delegation does*, `delegation.ts` is *how pi is told about it*.
 *
 * Everything reads the live session through the object it is handed; nothing here keeps its own copy of
 * the grant, the catalog or the definitions, because a copy taken at load time is a copy taken before the
 * tool surface is observed.
 */

import { nativeDelegationContext } from "./delegation-native.ts";
import { DELEGATE_SUBJECT, shouldSeekApproval } from "../src/kernel/approval.ts";
import { planDelegation } from "../src/kernel/delegate.ts";
import {
  obtainApprovals,
  republishable,
  snapshotOf,
  unbankApprovals,
  type ApprovalOutcome,
  type ApprovalUIContext,
} from "./approvals.ts";
import type { InheritableApproval } from "../src/kernel/approval.ts";
import type { GrantsSession } from "./session.ts";
import type { CorrelationMetadata } from "../src/kernel/correlation.ts";
import { preflightModel, runtimePairUnavailable, type ModelCatalogue } from "../src/kernel/model-preflight.ts";
import { GovernanceRefusal, refusal as structuredRefusal } from "../src/kernel/refusals.ts";
import { executePlannedChild, type DelegationOutcome } from "./execute-child.ts";
import { recordDelegationDecision, type ApprovalLedgerFacts } from "./delegation-ledger.ts";
import type { ExecutionOccurrenceIds } from "./execution-occurrence.ts";
import { resolveDefinitionRuntime } from "./definition-runtime.ts";
import {
  governedWorkspaceAccess,
  prepareDelegationWorkspace,
  releaseDelegationWorkspace,
  type DelegationWorkspaceSpec,
  type PreparedWorkspace,
} from "./workspace-runtime.ts";

/** What one child was asked to do. The shape both tools accept, per child. */
export interface ChildSpec {
  operation_id?: string;
  definitionId?: string;
  task: string;
  agent?: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  /** ADR-0078: what of the parent's session crosses. Validated in the kernel, never here. */
  context?: unknown;
  correlation?: CorrelationMetadata;
  workspace?: DelegationWorkspaceSpec;
}

/**
 * The slice of pi's `ExtensionContext` a delegation needs.
 *
 * It extends `ApprovalUIContext` rather than being cast to it at the call site. pi hands `execute` its full
 * context, so `ui`/`hasUI`/`mode` were always present — but the local type omitted them and an `as never`
 * bridged the gap, which is the same "a value that was whatever happened to be in scope" shape the module
 * header lists four defects for.
 */
export interface DelegationToolContext extends ApprovalUIContext {
  cwd: string;
  model?: { provider: string; id: string };
  modelRegistry: ModelCatalogue;
}

/** A planned delegation, plus whatever approvals contributed to it. */
export interface GatedPlan {
  plan: ReturnType<typeof planDelegation>;
  /** Opt-in observation of the exact context used by the final planner invocation. */
  definition?: import("../src/kernel/definitions.ts").SkillDefinition;
  /** Absent when the gate was never reached — i.e. the plan succeeded or failed for another reason. */
  approval?: ApprovalOutcome;
}

/** Discard provisional Auto facts when OFF or a policy error requires a fresh decision. */
function forgetAutoApprovals(outcome: ApprovalOutcome, capabilities: string[]): void {
  outcome.approved = outcome.approved.filter((capability) => !capabilities.includes(capability));
  for (const field of ["sources", "scopes", "recordedScopes", "bindings", "expiresAt", "uses"] as const)
    for (const capability of capabilities) delete outcome[field][capability];
}

/**
 * Plan a delegation and satisfy its gate as far as approvals allow.
 *
 * **Spelled once, on purpose.** The enforcer and the `/grants` listing both come through here, so a preview
 * cannot claim an outcome a spawn would not produce (R-38, and R-28 before it). The two differ in exactly
 * one respect, which is the one thing a read-only diagnostic must not do: pass `ctx: null` and no human is
 * asked — stored approvals still count, and the plan's own reason is left to speak for whatever is left.
 *
 * Deliberately NOT pre-filling `approved` on the first plan: pre-filling would satisfy an inherited-approval
 * gate silently, before `gatedBlocked` ever surfaced, so `obtainApprovals` would never run and the ledger
 * would lose the `approvalSource: "inherited"` record ADR-0010 relies on as inheritance's compensating
 * control. `approved ⊆ grant` holds regardless — this is about the audit trail, not privilege.
 */
export async function planWithApprovals(
  session: GrantsSession,
  request: ChildSpec & { model?: string },
  extra: Record<string, unknown>,
  ctx: ApprovalUIContext | null,
  signal?: AbortSignal,
  /**
   * Approvals a caller has ALREADY obtained, so this plan does not ask again — ADR-0033's upfront gate.
   *
   * `delegate_chain` collects the union of its steps' gated capabilities and asks once, then hands the answer to
   * every step. Without this each step would re-open the dialog *after* the operator had already answered for the
   * whole chain, which is R-25's fatigue shape with nothing bought.
   *
   * It cannot widen anything: `planDelegation` intersects `approved` with the grant on every path, so a
   * pre-approval for something the session does not hold is still refused. What it changes is who is asked.
   */
  preApproved?: InheritableApproval[],
): Promise<GatedPlan> {
  // Spelled ONCE. It is asked for twice — when the human is prompted, and when the answer is fed back into
  // the re-plan — and two spellings of one argument is the defect R-28 was.
  const approvalSubject = request.agent ?? DELEGATE_SUBJECT;

  let definition: GatedPlan["definition"];
  const observedPlan = (context: Parameters<typeof planDelegation>[1]) => {
    const next = planDelegation(request, context);
    definition =
      session.publicEvidence && next.definitionDigest && request.agent
        ? context.definitions?.get(request.agent)
        : undefined;
    return next;
  };
  let plan = observedPlan({ ...(await session.delegationContext(preApproved)), ...extra });
  if (plan.ok || !shouldSeekApproval(plan.result)) return { plan, ...(definition ? { definition } : {}) };

  let approval: ApprovalOutcome | undefined;
  try {
    approval = await obtainApprovals(
      session,
      plan.result?.gatedBlocked ?? [],
      // ADR-0019. A definition IS a human-authored subject — operator-written, and nameable only by a
      // session holding `agent:<name>` (ADR-0017) — so the approval is keyed to it and `always` is on
      // offer. The `tools:` form keeps `<delegate>` and keeps being denied `always`, because there the
      // original reasoning is untouched: the model chose both the task and the tool list.
      approvalSubject,
      request.agent ? "definition" : "delegate",
      ctx,
      request.task,
      signal,
      plan.approvalBinding,
    );
    const outcome = approval;
    while (outcome.approved.length > 0) {
      const context = {
        // The scope is the REAL one: a `once` approval still authorises this spawn, and
        // `inheritApprovals` then keeps it from reaching the child. See ADR-0014. R-29 is what makes
        // this safe under fan-out: a `once` is consumed by exactly one concurrent caller.
        ...(await session.delegationContext([
          ...(preApproved ?? []),
          ...republishable(session),
          ...outcome.approved.map((capability) => ({
            capability,
            subject: approvalSubject,
            // F1b: this capability's OWN scope. It was `outcome.scope` — one variable overwritten by the
            // last capability answered — so approving A `once` and B `session` re-stamped A as `session`
            // and handed a whole subtree an approval a human gave for a single spawn. That is ADR-0014's
            // A-S1 defect, reopened by a mixed answer.
            scope: outcome.scopes[capability] ?? ("once" as const),
            // F1a: and the pin. Without it every freshly-approved capability crossed to the child
            // UNPINNED, and `verifyInherited` honours an unpinned entry by decision — so ADR-0022's
            // headline property was false on the hot path, for the approvals it was written to cover.
            // Taken from this session's snapshot, the same source `republishable` uses.
            bodySha256: snapshotOf(session, approvalSubject)?.bodySha256,
            ...(outcome.bindings[capability] ? { binding: outcome.bindings[capability] } : {}),
          })),
        ])),
        ...extra,
      };
      const automatic = outcome.approved.filter((capability) => outcome.sources[capability] === "auto");
      // The owner serializes this check with OFF. Permission is admitted here, after context preparation;
      // a later OFF does not cancel a delegation already admitted to its load-bearing ledger write.
      if (automatic.length > 0 && !(await session.autoMode?.admit(signal))) {
        const renewed = await obtainApprovals(
          session,
          automatic,
          approvalSubject,
          request.agent ? "definition" : "delegate",
          ctx,
          request.task,
          signal,
          plan.approvalBinding,
        );
        forgetAutoApprovals(outcome, automatic);
        outcome.approved.push(...renewed.approved);
        for (const field of ["sources", "scopes", "recordedScopes", "bindings", "expiresAt", "uses"] as const)
          Object.assign(outcome[field], renewed[field]);
        outcome.banked = [...(outcome.banked ?? []), ...(renewed.banked ?? [])];
        outcome.humanDenied ||= renewed.humanDenied;
        outcome.gateOutcome = renewed.gateOutcome;
        outcome.refusalCode = renewed.refusalCode;
        outcome.reason = renewed.reason;
        if (automatic.some((capability) => !renewed.approved.includes(capability))) break;
        continue;
      }
      plan = observedPlan(context);
      break;
    }
    if (!plan.ok && approval.reason) {
      plan = {
        ...plan,
        reason: approval.reason,
        ...(approval.refusalCode ? { refusal: structuredRefusal(approval.refusalCode, approval.reason) } : {}),
      };
    }
  } catch (error) {
    const message = `grants: approval flow failed, denying (${String(error)})`;
    if (approval) {
      const failed = approval;
      forgetAutoApprovals(
        failed,
        failed.approved.filter((capability) => failed.sources[capability] === "auto"),
      );
      approval.gateOutcome = "error";
      approval.refusalCode = "APPROVAL_FLOW_FAILED";
      approval.reason = message;
    }
    plan = { ...plan, reason: message, refusal: structuredRefusal("APPROVAL_FLOW_FAILED", message) };
  }

  return { plan, approval, ...(definition ? { definition } : {}) };
}

/**
 * Plan, gate, audit and run ONE governed child. Shared by `delegate` and `delegate_all`.
 *
 * Extracted rather than copied, for the reason R-28 exists: this is where the grant is resolved, the
 * human is asked, and the ledger is written, and two call sites spelling that out separately is how one
 * of them comes to omit a step. `delegate_all` differs from `delegate` only in running several of these
 * concurrently and reporting each outcome — not in any governance rule.
 *
 * Returns an outcome instead of throwing, because a fan-out must be able to report "three succeeded, one
 * was refused". `delegate` converts a failure back into a throw to keep its own contract, which matters:
 * `AgentToolResult` has no `isError` field, so a returned error is silently discarded by pi.
 */
async function runOneDelegationImplementation(
  session: GrantsSession,
  spec: ChildSpec,
  ids: ExecutionOccurrenceIds,
  budget: number | undefined,
  ctx: DelegationToolContext,
  signal: AbortSignal | undefined,
  /**
   * Progress for the parent's status block (ADR-0032). Optional, so nothing here depends on being watched.
   *
   * One sink for both executors: the herdr path additionally reports a pane id, and the process path never
   * has one. Every field is display-only — the child's answer is still the returned outcome.
   */
  /**
   * The optional tail, as ONE object rather than positional arguments.
   *
   * **R-28's lesson, applied before it cost anything.** Adding `preApproved` as a seventh positional parameter put
   * it in front of `onProgress`, and two existing call sites silently passed a progress sink where approvals were
   * expected. TypeScript caught it only because the types happen to differ — which is luck, not a control, and
   * R-28 was precisely "a defect in an argument list that 226 pure tests could not see". An object makes the
   * mistake unspellable.
   */
  options: {
    operationClaim?: OperationClaim;
    /** Trusted observation at the actual executor boundary, not a caller/tool parameter. */
    onExecutorEntry?: () => void;
    /** Trusted reservation made before a chain's upfront gate. */
    capacityReservation?: CapacityReservation;
    /** Exact pair selected during the chain preflight; never reselect after its approval. */
    onDefinition?: (definition: import("../src/kernel/definitions.ts").SkillDefinition | undefined) => void;
    resolvedRuntime?: import("./definition-runtime.ts").ResolvedDefinitionRuntime;
    /** Actual public execute argument, never read from model-authored correlation or output. */
    toolCallId?: string;
    /** Progress for the parent's status block (ADR-0032). Display only. */
    onProgress?: (update: {
      /** Appended (process executor: a genuine byte stream). */
      chunk?: string;
      /** Replaces (herdr executor: a snapshot of a bounded terminal). The two are NOT interchangeable. */
      snapshot?: string[];
      paneId?: string;
      /** The name herdr actually knows this child by — minted in `runHerdrPane`, so it cannot be derived. */
      agentName?: string;
      state?: "starting" | "running" | "completed" | "failed";
    }) => void;
    /** Approvals already obtained by the caller — see `planWithApprovals`. `delegate_chain` uses it. */
    preApproved?: InheritableApproval[];
    /**
     * The child whose output composed this child's task (ADR-0033).
     *
     * Recorded, never acted on: it exists so "who wrote this instruction?" is answerable from the trail, which is
     * the question the chain's framed-rather-than-enforced handoff makes worth asking.
     */
    taskFrom?: string;
    /** Unique occurrence whose output composed this task; separate from the logical taskFrom position. */
    taskFromExecutionId?: string;
    /**
     * What the caller's own gate decided, for the LEDGER — not for the plan.
     *
     * **Required because pre-filling `approved` silences the record.** The doc comment on `planWithApprovals` above
     * warns about exactly this: satisfying the gate on the first plan means `obtainApprovals` never runs, so
     * `approval` is undefined and this record writes no `approved`, `approvalSources`, `approvalScopes` or
     * `humanDenied`. Measured: a chain step that spent `tool:bash` on a human's click was indistinguishable from one
     * where nothing was ever gated — `/grants ledger` counted it in neither `bySource` nor `unattributed`, so it did
     * not even show up as a gap, and ADR-0010's compensating control was blind to every chain step.
     */
    approvalFacts?: ApprovalLedgerFacts;
  } = {},
): Promise<DelegationOutcome> {
  let capacity: CapacityReservation | undefined;
  let capacityRefusal: import("../src/kernel/refusals.ts").StructuredRefusal | undefined;
  try {
    if (!options.capacityReservation) await reconcileDelegationCapacity(session);
    capacity = options.capacityReservation ?? reserveDelegationCapacity(session, ids.executionId, budget);
    if (capacity.executionId !== ids.executionId || (budget !== undefined && capacity.childAllowance !== budget))
      throw new GovernanceRefusal(
        structuredRefusal("FANOUT_EXCEEDED", "capacity reservation does not match its execution"),
      );
  } catch (error) {
    if (!(error instanceof GovernanceRefusal)) throw error;
    capacityRefusal = structuredRefusal(error.code, error.message, error.details);
  }
  let executorEntered = false;
  try {
    await session.ensureDefinitions?.();
    assertDefinitionIdentity(session, spec);

    const { toolCallId, onProgress, preApproved, taskFrom, taskFromExecutionId, approvalFacts } = options;
    // pi resolves a BARE model id to an unauthenticated provider and the child dies at startup — the id
    // alone is not enough, it must be qualified with its provider (`Model<Api>` carries both).
    const defaultModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    let runtimeRefusal: import("../src/kernel/refusals.ts").StructuredRefusal | undefined;
    let configured: import("./definition-runtime.ts").ResolvedDefinitionRuntime = {
      model: spec.model ?? defaultModel,
      modelSource: spec.model ? "explicit" : "pi",
      thinkingSource: "pi",
    };
    try {
      configured =
        options.resolvedRuntime ??
        resolveDefinitionRuntime({
          definition: spec.agent,
          explicit: { model: spec.model, thinking: spec.thinking },
          session: session.definitionRuntimeOverrides,
          settings: session.definitionRuntimeSettings,
          piModel: defaultModel,
          piThinking: session.currentThinking?.(),
          authoredPreferences: spec.agent ? session.definitions.get(spec.agent)?.runtimePreferences : undefined,
          unavailable: (choice) => runtimePairUnavailable(choice, ctx.modelRegistry, session.allowUnresolvedModels),
        });
    } catch (error) {
      runtimeRefusal = structuredRefusal("MODEL_UNRESOLVED", `runtime selection refused: ${String(error)}`);
    }
    const resolvedRuntime = configured;
    const request = {
      task: spec.task,
      agent: spec.agent,
      tools: spec.tools,
      model: configured.model,
      thinking: configured.thinking,
      context: spec.context,
      correlation: spec.workspace
        ? { ...(spec.correlation ?? {}), workspace_id: spec.workspace.workspace_id }
        : spec.correlation,
      // The binding's workspace comes from the ROUTING SPEC, which is resolved against the operator
      // registry and leased before any human is asked — never from `correlation`, which is a model-supplied
      // claim that nothing validates when no spec accompanies it (R-110).
      boundWorkspaceId: spec.workspace?.workspace_id,
      boundContextId: spec.correlation?.context_id,
    };

    // ADR-0031: herdr was DEMANDED (`PI_DADDY_HERDR=1`) and is not answering. Refused rather than relocated —
    // the operator chose that over falling back, so the ledger can never name a child that ran somewhere nobody
    // chose.
    //
    // **Decided BEFORE the gate, and the ordering is a fix.** This sat after `planWithApprovals`, which opens the
    // approval dialog — so with herdr down a human was asked to approve `tool:bash`, answered *Always*, and was
    // then refused anyway. Measured: the answer still reached `process.env.PI_DADDY_APPROVED`, still wrote a
    // **30-day project-wide** entry to the persisted store, and still produced a ledger line asserting a human
    // approved `bash` for a child that never existed. A refused operation must not leave authority behind, and
    // asking for permission that cannot be used is R-25's fatigue shape with nothing bought.
    //
    // `ctx: null` rather than skipping the plan entirely: the ledger still gets a full, honest record of what was
    // requested and refused, and stored approvals still count toward it — nothing is *hidden*, only nobody is
    // *asked*. It is the same argument `/grants` uses for its preview.
    let executorRefusal = session.executor.refusal;
    const modelRefusal =
      runtimeRefusal ??
      preflightModel(request.model, ctx.modelRegistry, session.modelResolutionCache, session.allowUnresolvedModels);
    const { extra, refusal: nativeRefusal } = await nativeDelegationContext(
      session,
      ids,
      capacity?.childAllowance ?? 0,
      Boolean(executorRefusal || modelRefusal || capacityRefusal),
    );
    executorRefusal ||= nativeRefusal;

    const planContext = extra;
    let preparedWorkspace: PreparedWorkspace | undefined;
    let approvalOutcome: ApprovalOutcome | undefined;
    let plan: ReturnType<typeof planDelegation>;

    if (spec.workspace && !executorRefusal && !modelRefusal && !capacityRefusal) {
      // Check non-liftable refusals before taking a lease, and take the lease before asking a human. This
      // preserves both anti-race rules: a doomed spawn cannot bank approval, and a conflicting writer starts
      // no child process.
      const preview = await planWithApprovals(session, request, planContext, null, signal, preApproved);
      plan = preview.plan;
      options.onDefinition?.(preview.definition);
      if (plan.ok || shouldSeekApproval(plan.result)) {
        try {
          preparedWorkspace = await prepareDelegationWorkspace({
            ...(session.workspacePin ? { workspacePin: session.workspacePin } : {}),
            spec: { ...spec.workspace, access: governedWorkspaceAccess(spec.workspace.access, plan.requested) },
            correlation: spec.correlation,
            childId: ids.childId,
            episodeId: session.episodeId,
            executionId: ids.executionId,
            parentExecutionId: ids.parentExecutionId,
            signal,
            ledgerPath: session.ledgerPath,
          });
          request.correlation = preparedWorkspace.correlation;
          const gated = await planWithApprovals(session, request, planContext, ctx, signal, preApproved);
          plan = gated.plan;
          options.onDefinition?.(gated.definition);
          approvalOutcome = gated.approval;
        } catch (error) {
          const value =
            error instanceof GovernanceRefusal
              ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
              : structuredRefusal("WORKSPACE_LEASE_STALE", `workspace setup failed (${String(error)})`);
          plan = { ...plan, ok: false, reason: value.message, refusal: value };
        }
      }
    } else {
      const gated = await planWithApprovals(
        session,
        request,
        planContext,
        executorRefusal || modelRefusal || capacityRefusal ? null : ctx,
        signal,
        preApproved,
      );
      plan = gated.plan;
      options.onDefinition?.(gated.definition);
      approvalOutcome = gated.approval;
    }

    if (capacityRefusal) {
      plan = { ...plan, ok: false, reason: capacityRefusal.message, refusal: capacityRefusal };
    } else if (executorRefusal) {
      const message = `grants: ${executorRefusal}`;
      plan = { ...plan, ok: false, reason: message, refusal: structuredRefusal("EXECUTOR_UNAVAILABLE", message) };
    } else if (modelRefusal) {
      // This is a routing preflight, not a grant decision: preserve the resolved capability facts and replace
      // only the outcome. It is still recorded by the common refusal path, and no lease, dialog or child starts.
      plan = { ...plan, ok: false, reason: modelRefusal.message, refusal: modelRefusal };
    }

    // The capability decision provisions the child, so this append remains load-bearing and fails closed.
    try {
      await recordDelegationDecision({
        session,
        plan,
        ids,
        agent: spec.agent,
        taskFrom,
        taskFromExecutionId,
        approval: approvalOutcome,
        approvalFacts,
      });
    } catch (error) {
      plan = {
        ...plan,
        ok: false,
        reason: `grants: ledger write failed, denying — ${String(error)}`,
        refusal: structuredRefusal("LEDGER_WRITE_FAILED", `grants: ledger write failed, denying — ${String(error)}`),
      };
    }

    if (!plan.ok) {
      // EVERY refusal reached after the gate ran. Gating on `ledgerDenied` left three post-gate refusals
      // stranding a 30-day approval — most reachably a human declining the SECOND of two gated capabilities,
      // which needs no fault at all. The predicate is now the rule itself, so it cannot drift from it again.
      if (ctx) await unbankApprovals(session, ctx, approvalOutcome?.banked);
      // Guarded: this contains a `strict: true` append, and on the path where the ledger is already known
      // unwritable an unguarded call replaced the governance refusal, and its code, with a ledger error.
      try {
        await releaseDelegationWorkspace({
          prepared: preparedWorkspace,
          childId: ids.childId,
          episodeId: session.episodeId,
          executionId: ids.executionId,
          parentExecutionId: ids.parentExecutionId,
          ledgerPath: session.ledgerPath,
          reason: "refused",
        });
      } catch (error) {
        plan = { ...plan, reason: `${plan.reason ?? "refused"}; workspace release record failed: ${String(error)}` };
      }
      return {
        ok: false,
        text: "",
        reason: plan.reason,
        granted: [],
        depth: plan.childDepth,
        exitCode: null,
        ...(plan.refusal ? { refusal: plan.refusal } : {}),
      };
    }

    executorEntered = true;
    return await executePlannedChild({
      capacityReservation: capacity,
      operationClaim: options.operationClaim,
      onExecutorEntry: options.onExecutorEntry,
      session,
      plan,
      agent: spec.agent,
      childId: ids.childId,
      executionId: ids.executionId,
      parentExecutionId: ids.parentExecutionId,
      toolCallId: options.toolCallId,
      cwd: ctx.cwd,
      preparedWorkspace,
      resolvedRuntime,
      signal,
      onProgress,
    });
  } finally {
    capacity?.finalize(
      executorEntered
        ? { state: "unknown", reason: "execution returned without qualified cleanup" }
        : { state: "not-started", reason: "delegation ended before entering the executor" },
    );
  }
}

/** Duplicate references never enter the executor, consume capacity, or become chain input. */
export async function runOneDelegation(
  ...args: Parameters<typeof runOneDelegationImplementation>
): Promise<DelegationOutcome> {
  const [session, spec, ids, , ctx, signal] = args;
  const options = args[6] ?? {};
  const claim = options.operationClaim ?? (await claimDelegationOperation(session, spec, ids, ctx, signal));
  if (claim?.reused) {
    options.capacityReservation?.finalize({ state: "not-started", reason: "existing operation reused" });
    return existingOperationOutcome(claim, session.depth + 1);
  }
  let executorEntered = false;
  try {
    args[6] = {
      ...options,
      operationClaim: claim,
      onExecutorEntry: () => {
        executorEntered = true;
        options.onExecutorEntry?.();
      },
    };
    const result = await runOneDelegationImplementation(...args);
    if (claim) {
      try {
        await finishDelegationOperation(claim, result);
      } catch (error) {
        // A post-execution observation failure must not erase the native final or settlement receipt.
        result.control = "failed";
        result.reason = [result.reason, `operation status update failed: ${String(error)}`].filter(Boolean).join("; ");
        result.operation = { ...claim.operation, state: "uncertain", reused: false };
      }
    }
    return result;
  } catch (error) {
    if (claim)
      await claim.finish!(
        executorEntered ? "uncertain" : "not-started",
        executorEntered ? undefined : { cleanup: { state: "not-started" } },
      ).catch(() => undefined);
    throw error;
  }
}
