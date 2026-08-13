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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DELEGATE_SUBJECT, shouldSeekApproval } from "../src/approval.ts";
import { maySpawnDefinition, planDelegation } from "../src/delegate.ts";
import { MAX_CHILDREN_PER_CALL, childSpawnId, splitBudget } from "../src/fanout.ts";
import { appendRecord, buildRecord } from "../src/ledger.ts";
import { mergeChildEnv } from "../src/propagation.ts";
import type { Capability } from "../src/resolve.ts";
import { ENV_CHILD_TIMEOUT, runChild, timeoutFromEnv } from "../src/run-child.ts";
import { runHerdrPane } from "../src/run-herdr.ts";
import { obtainApprovals, republishable, type ApprovalOutcome, type ApprovalUIContext } from "./approvals.ts";
import { ENV_HERDR_KEEP_PANE, ENV_HERDR_WORKSPACE, type GrantsSession } from "./session.ts";

/** What one child was asked to do. The shape both tools accept, per child. */
interface ChildSpec {
  task: string;
  agent?: string;
  tools?: string[];
  model?: string;
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
): Promise<GatedPlan> {
  // Spelled ONCE. It is asked for twice — when the human is prompted, and when the answer is fed back into
  // the re-plan — and two spellings of one argument is the defect R-28 was.
  const approvalSubject = request.agent ?? DELEGATE_SUBJECT;

  let plan = planDelegation(request, { ...(await session.delegationContext()), ...extra });
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
            scope: outcome.scope ?? ("once" as const),
          })),
        ])),
        ...extra,
      });
    }
    if (!plan.ok && approval.reason) plan = { ...plan, reason: approval.reason };
  } catch (error) {
    plan = { ...plan, reason: `grants: approval flow failed, denying (${String(error)})` };
  }

  return { plan, approval };
}

interface DelegationOutcome {
  ok: boolean;
  text: string;
  reason?: string;
  granted: Capability[];
  depth: number;
  exitCode: number | null;
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
): Promise<DelegationOutcome> {
  // pi resolves a BARE model id to an unauthenticated provider and the child dies at startup — the id
  // alone is not enough, it must be qualified with its provider (`Model<Api>` carries both).
  const defaultModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  const request = { task: spec.task, agent: spec.agent, tools: spec.tools, model: spec.model ?? defaultModel };
  const extra = { fanoutBudget: budget, spawnId: ids.parentId, childSpawnId: ids.childId };

  // Planning and the gate live in `planWithApprovals`, shared with the `/grants` preview so the two cannot
  // disagree (R-38). This call is the enforcing one: it passes `ctx`, so a human CAN be asked.
  let { plan, approval: approvalOutcome } = await planWithApprovals(session, request, extra, ctx, signal);

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
        requested: plan.requested,
        parentGrant: session.ownGrant,
        result: plan.result,
        blocked: !plan.ok,
        reason: plan.reason,
        approved: approvalOutcome?.approved,
        approvalSources: approvalOutcome?.sources,
        approvalScope: approvalOutcome?.scope,
        humanDenied: approvalOutcome?.humanDenied,
        // ADR-0018: taken from the PLAN, never re-derived here. The B-I3 lesson — a call site that
        // recomputed the digest could record one the planner never used.
        definitionDigest: plan.definitionDigest,
        now: new Date(),
      }),
    ).catch((error) => {
      // G6 / A-R4 + B-I2: fail closed. This path PROVISIONS, so an unrecorded delegation would be a
      // child running with granted capabilities and no audit line.
      plan = { ...plan, ok: false, reason: `grants: ledger write failed, denying — ${String(error)}` };
    });
  }

  if (!plan.ok) {
    return { ok: false, text: "", reason: plan.reason, granted: [], depth: plan.childDepth, exitCode: null };
  }

  // G8: bounded output, a wall-clock timeout with SIGTERM->SIGKILL escalation, and an abort observed
  // even if it happened before we got here. See src/run-child.ts for why each one exists.
  //
  // ADR-0016 point 6: two executors, one plan. `runChild` is the default because it needs nothing
  // installed; herdr gives the same governed argv a VISIBLE, attachable pane. Opt-in per session rather
  // than auto-detected — a governed run must not silently relocate because a binary is on PATH.
  const output = session.useHerdr
    ? await runHerdrPane({
        args: plan.args.slice(0, -1),
        // The task is delivered as a prompt, so it never reaches argv at all. `plan.args` still ends
        // with the neutralised task (planSpawn is executor-agnostic), hence the slice — and the leading
        // space `neutralisePrompt` added is stripped because there is no parser to defend against here.
        prompt: plan.args[plan.args.length - 1].trimStart(),
        // Grant/depth/ledger go on the PANE: `herdr agent start` has no --env, but a pane's environment
        // reaches the shell that launches the agent (docs/probes/g16-herdr).
        env: plan.env,
        cwd: ctx.cwd,
        name: `${spec.agent ?? "delegate"}-${ids.childId}`,
        workspace: process.env[ENV_HERDR_WORKSPACE],
        signal,
        timeoutMs: timeoutFromEnv(process.env[ENV_CHILD_TIMEOUT]),
        keepPane: process.env[ENV_HERDR_KEEP_PANE] === "1",
      })
    : await runChild({
        command: "pi",
        args: plan.args,
        // Explicit per-child env — the parent's own grant vars must not leak in. A plain spread would
        // not achieve that: a key `plan.env` does not set is a key the parent's value survives into, so
        // `mergeChildEnv` strips every governance variable first and lets only the plan put them back.
        env: mergeChildEnv(process.env, plan.env),
        cwd: ctx.cwd,
        signal,
        timeoutMs: timeoutFromEnv(process.env[ENV_CHILD_TIMEOUT]),
      });

  // G8: a child that failed is reported as a failure. A non-zero exit, a timeout and a truncated flood
  // all used to come back as ordinary tool results, so the orchestrator read them as answers.
  if (output.spawnError || output.aborted || output.timedOut || output.code !== 0) {
    const why = output.spawnError
      ? `could not be started: ${output.spawnError}`
      : output.aborted
        ? "was cancelled"
        : output.timedOut
          ? "exceeded its time limit and was killed"
          : `exited with code ${output.code}`;
    return {
      ok: false,
      text: output.text.trim(),
      reason: `the sub-agent ${why}`,
      granted: plan.effective,
      depth: plan.childDepth,
      exitCode: output.code,
    };
  }

  return {
    ok: true,
    text: output.text.trim(),
    granted: plan.effective,
    depth: plan.childDepth,
    exitCode: output.code,
  };
}
