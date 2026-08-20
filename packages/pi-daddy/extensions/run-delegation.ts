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

import { DELEGATE_SUBJECT, shouldSeekApproval } from "../src/approval.ts";
import { planDelegation } from "../src/delegate.ts";
import { appendRecord, buildRecord } from "../src/ledger.ts";
import {
  obtainApprovals,
  republishable,
  snapshotOf,
  unbankApprovals,
  type ApprovalOutcome,
  type ApprovalUIContext,
} from "./approvals.ts";
import type { InheritableApproval } from "../src/approval.ts";
import type { GrantsSession } from "./session.ts";
import type { CorrelationMetadata } from "../src/correlation.ts";
import { GovernanceRefusal, refusal as structuredRefusal } from "../src/refusals.ts";
import { executePlannedChild, type DelegationOutcome } from "./execute-child.ts";
import {
  governedWorkspaceAccess,
  prepareDelegationWorkspace,
  releaseDelegationWorkspace,
  type DelegationWorkspaceSpec,
  type PreparedWorkspace,
} from "./workspace-runtime.ts";

/** What one child was asked to do. The shape both tools accept, per child. */
interface ChildSpec {
  task: string;
  agent?: string;
  tools?: string[];
  model?: string;
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
interface DelegationToolContext extends ApprovalUIContext {
  cwd: string;
  model?: { provider: string; id: string };
}

/** A planned delegation, plus whatever approvals contributed to it. */
export interface GatedPlan {
  plan: ReturnType<typeof planDelegation>;
  /** Absent when the gate was never reached — i.e. the plan succeeded or failed for another reason. */
  approval?: ApprovalOutcome;
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

  let plan = planDelegation(request, { ...(await session.delegationContext(preApproved)), ...extra });
  if (plan.ok || !shouldSeekApproval(plan.result)) return { plan };

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
    if (outcome.approved.length > 0) {
      plan = planDelegation(request, {
        // The scope is the REAL one: a `once` approval still authorises this spawn, and
        // `inheritApprovals` then keeps it from reaching the child. See ADR-0014. R-29 is what makes
        // this safe under fan-out: a `once` is consumed by exactly one concurrent caller.
        ...(await session.delegationContext([
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
      });
    }
    if (!plan.ok && approval.reason) {
      plan = {
        ...plan,
        reason: approval.reason,
        ...(approval.refusalCode
          ? { refusal: structuredRefusal(approval.refusalCode, approval.reason) }
          : {}),
      };
    }
  } catch (error) {
    const message = `grants: approval flow failed, denying (${String(error)})`;
    plan = { ...plan, reason: message, refusal: structuredRefusal("APPROVAL_FLOW_FAILED", message) };
  }

  return { plan, approval };
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
export async function runOneDelegation(
  session: GrantsSession,
  spec: ChildSpec,
  ids: { parentId: string; childId: string },
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
    /** Progress for the parent's status block (ADR-0032). Display only. */
    onProgress?: (update: {
      /** Appended (process executor: a genuine byte stream). */
      chunk?: string;
      /** Replaces (herdr executor: a snapshot of a bounded terminal). The two are NOT interchangeable. */
      snapshot?: string[];
      paneId?: string;
      /** The name herdr actually knows this child by — minted in `runHerdrPane`, so it cannot be derived. */
      agentName?: string;
      state?: "running" | "completed" | "failed";
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
    approvalFacts?: Pick<ApprovalOutcome, "approved" | "sources" | "scopes" | "expiresAt" | "uses" | "humanDenied">;
  } = {},
): Promise<DelegationOutcome> {
  const { onProgress, preApproved, taskFrom, approvalFacts } = options;
  // pi resolves a BARE model id to an unauthenticated provider and the child dies at startup — the id
  // alone is not enough, it must be qualified with its provider (`Model<Api>` carries both).
  const defaultModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  const request = {
    task: spec.task,
    agent: spec.agent,
    tools: spec.tools,
    model: spec.model ?? defaultModel,
    correlation: spec.workspace
      ? { ...(spec.correlation ?? {}), workspace_id: spec.workspace.workspace_id }
      : spec.correlation,
    // The binding's workspace comes from the ROUTING SPEC, which is resolved against the operator
    // registry and leased before any human is asked — never from `correlation`, which is a model-supplied
    // claim that nothing validates when no spec accompanies it (R-110).
    boundWorkspaceId: spec.workspace?.workspace_id,
    boundContextId: spec.correlation?.context_id,
  };
  const extra = { fanoutBudget: budget, spawnId: ids.parentId, childSpawnId: ids.childId };

  // ADR-0031: herdr was DEMANDED (`PI_GRANTS_HERDR=1`) and is not answering. Refused rather than relocated —
  // the operator chose that over falling back, so the ledger can never name a child that ran somewhere nobody
  // chose.
  //
  // **Decided BEFORE the gate, and the ordering is a fix.** This sat after `planWithApprovals`, which opens the
  // approval dialog — so with herdr down a human was asked to approve `tool:bash`, answered *Always*, and was
  // then refused anyway. Measured: the answer still reached `process.env.PI_GRANTS_APPROVED`, still wrote a
  // **30-day project-wide** entry to the persisted store, and still produced a ledger line asserting a human
  // approved `bash` for a child that never existed. A refused operation must not leave authority behind, and
  // asking for permission that cannot be used is R-25's fatigue shape with nothing bought.
  //
  // `ctx: null` rather than skipping the plan entirely: the ledger still gets a full, honest record of what was
  // requested and refused, and stored approvals still count toward it — nothing is *hidden*, only nobody is
  // *asked*. It is the same argument `/grants` uses for its preview.
  const executorRefusal = session.executor.refusal;
  let preparedWorkspace: PreparedWorkspace | undefined;
  let approvalOutcome: ApprovalOutcome | undefined;
  let plan: ReturnType<typeof planDelegation>;
  let ledgerDenied = false;

  if (spec.workspace && !executorRefusal) {
    // Check non-liftable refusals before taking a lease, and take the lease before asking a human. This
    // preserves both anti-race rules: a doomed spawn cannot bank approval, and a conflicting writer starts
    // no child process.
    const preview = await planWithApprovals(session, request, extra, null, signal, preApproved);
    plan = preview.plan;
    if (plan.ok || shouldSeekApproval(plan.result)) {
      try {
        preparedWorkspace = await prepareDelegationWorkspace({
          spec: { ...spec.workspace, access: governedWorkspaceAccess(spec.workspace.access, plan.requested) },
          correlation: spec.correlation,
          childId: ids.childId,
          signal,
          ledgerPath: session.ledgerPath,
        });
        request.correlation = preparedWorkspace.correlation;
        const gated = await planWithApprovals(session, request, extra, ctx, signal, preApproved);
        plan = gated.plan;
        approvalOutcome = gated.approval;
      } catch (error) {
        const value = error instanceof GovernanceRefusal
          ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
          : structuredRefusal("WORKSPACE_LEASE_STALE", `workspace setup failed (${String(error)})`);
        plan = { ...plan, ok: false, reason: value.message, refusal: value };
      }
    }
  } else {
    const gated = await planWithApprovals(session, request, extra, executorRefusal ? null : ctx, signal, preApproved);
    plan = gated.plan;
    approvalOutcome = gated.approval;
  }

  if (executorRefusal) {
    const message = `grants: ${executorRefusal}`;
    plan = { ...plan, ok: false, reason: message, refusal: structuredRefusal("EXECUTOR_UNAVAILABLE", message) };
  }

  // G6 / B-I3: no `&& plan.result` guard — `planDelegation` always carries one now.
  if (session.ledgerPath) {
    await appendRecord(
      { path: session.ledgerPath, strict: true },
      buildRecord({
        // F8: real ids, not depth labels. Four concurrent siblings used to produce four lines identical
        // except `ts`, so the ledger could not be joined to a result, a process, or the child's own
        // lines one level down.
        parentId: ids.parentId,
        childId: ids.childId,
        depth: plan.childDepth,
        agentType: spec.agent ?? "delegate",
        // ADR-0031: where this child actually ran. Read off the live session, which the probe has settled
        // by now, so the record and the executor cannot disagree.
        executor: session.executor.kind,
        taskFrom,
        requested: plan.requested,
        parentGrant: session.ownGrant,
        result: plan.result,
        blocked: !plan.ok,
        reason: plan.reason,
        // `approvalOutcome` when this call's own gate ran; `approvalFacts` when a caller gated upfront on our behalf
        // (a chain). Without the second, an approved chain step recorded nothing about the human who authorised it.
        approved: approvalOutcome?.approved ?? approvalFacts?.approved,
        approvalSources: approvalOutcome?.sources ?? approvalFacts?.sources,
        approvalScopes: approvalOutcome?.recordedScopes ?? approvalFacts?.scopes,
        approvalExpiresAt: approvalOutcome?.expiresAt ?? approvalFacts?.expiresAt,
        approvalUses: approvalOutcome?.uses ?? approvalFacts?.uses,
        humanDenied: approvalOutcome?.humanDenied ?? approvalFacts?.humanDenied,
        gateOutcome: approvalOutcome?.gateOutcome,
        // ADR-0018: taken from the PLAN, never re-derived here. The B-I3 lesson — a call site that
        // recomputed the digest could record one the planner never used.
        definitionDigest: plan.definitionDigest,
        taskDigest: plan.taskDigest,
        correlation: plan.correlation,
        refusal: plan.refusal,
        now: new Date(),
      }),
    ).catch((error) => {
      // G6 / A-R4 + B-I2: fail closed. This path PROVISIONS, so an unrecorded delegation would be a
      // child running with granted capabilities and no audit line.
      plan = {
        ...plan,
        ok: false,
        reason: `grants: ledger write failed, denying — ${String(error)}`,
        refusal: structuredRefusal("LEDGER_WRITE_FAILED", `grants: ledger write failed, denying — ${String(error)}`),
      };
      ledgerDenied = true;
    });
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
        prepared: preparedWorkspace, childId: ids.childId, ledgerPath: session.ledgerPath, reason: "refused",
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

  return executePlannedChild({
    session,
    plan,
    agent: spec.agent,
    childId: ids.childId,
    cwd: ctx.cwd,
    preparedWorkspace,
    signal,
    onProgress,
  });
}
