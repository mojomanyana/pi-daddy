/**
 * Governed delegation, as pi sees it: `delegate` and `delegate_all`.
 *
 * Unlike the tripwire in `grants.ts` this PROVISIONS — the grant is an argument, so the orchestrator hands
 * each child exactly the capabilities it should have. Both tools are registered only when this session may
 * delegate, so withholding `tool:delegate` genuinely makes a session a leaf (S-5).
 *
 * Split out of `extensions/grants.ts`. Everything reads the live session through the object it is handed;
 * nothing here keeps its own copy of the grant, the catalog or the definitions, because a copy taken at
 * load time is a copy taken before the tool surface is observed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DELEGATE_SUBJECT, shouldSeekApproval } from "../src/approval.ts";
import { planDelegation } from "../src/delegate.ts";
import { MAX_CHILDREN_PER_CALL, childSpawnId, splitBudget } from "../src/fanout.ts";
import { appendRecord, buildRecord } from "../src/ledger.ts";
import { mergeChildEnv } from "../src/propagation.ts";
import type { Capability } from "../src/resolve.ts";
import { ENV_CHILD_TIMEOUT, runChild, timeoutFromEnv } from "../src/run-child.ts";
import { runHerdrPane } from "../src/run-herdr.ts";
import { obtainApprovals, republishable, type ApprovalOutcome } from "./approvals.ts";
import { ENV_HERDR_KEEP_PANE, ENV_HERDR_WORKSPACE, type GrantsSession } from "./session.ts";

/** What one child was asked to do. The shape both tools accept, per child. */
interface ChildSpec {
  task: string;
  agent?: string;
  tools?: string[];
  model?: string;
}

/** The slice of pi's `ExtensionContext` a delegation needs. */
interface DelegationToolContext {
  cwd: string;
  model?: { provider: string; id: string };
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
async function runOneDelegation(
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

  // Deliberately NOT pre-filling `approved` here — pre-filling would satisfy any inherited-approval gate
  // silently, before `gatedBlocked` ever surfaces, so `obtainApprovals` would never run and the ledger
  // would lose the `approvalSource: "inherited"` record ADR-0010 relies on as inheritance's compensating
  // control. `approved ⊆ grant` still holds regardless — this is about the audit trail, not privilege.
  let plan = planDelegation(request, { ...(await session.delegationContext()), ...extra });

  let approvalOutcome: ApprovalOutcome | undefined;
  if (!plan.ok && shouldSeekApproval(plan.result)) {
    try {
      approvalOutcome = await obtainApprovals(
        session,
        plan.result?.gatedBlocked ?? [],
        DELEGATE_SUBJECT,
        "delegate",
        ctx as never,
        spec.task,
        signal,
      );
      const outcome = approvalOutcome;
      if (outcome.approved.length > 0) {
        plan = planDelegation(request, {
          // The scope is the REAL one: a `once` approval still authorises this spawn, and
          // `inheritApprovals` then keeps it from reaching the child. See ADR-0014. R-29 is what makes
          // this safe under fan-out: a `once` is consumed by exactly one concurrent caller.
          ...(await session.delegationContext([
            ...republishable(session),
            ...outcome.approved.map((capability) => ({
              capability,
              subject: DELEGATE_SUBJECT,
              scope: outcome.scope ?? ("once" as const),
            })),
          ])),
          ...extra,
        });
      }
      if (!plan.ok && approvalOutcome.reason) plan = { ...plan, reason: approvalOutcome.reason };
    } catch (error) {
      plan = { ...plan, reason: `grants: approval flow failed, denying (${String(error)})` };
    }
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
        requested: plan.requested,
        parentGrant: session.ownGrant,
        result: plan.result,
        blocked: !plan.ok,
        reason: plan.reason,
        approved: approvalOutcome?.approved,
        approvalSource: approvalOutcome?.source,
        approvalScope: approvalOutcome?.scope,
        humanDenied: approvalOutcome?.humanDenied,
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

/**
 * Register `delegate` and `delegate_all` — but only if this session may delegate.
 *
 * The conditional is the whole of S-5: an unconditionally-registered `delegate` appears in every child's
 * ceiling, so a delegator without it was told every single agent type "requires tool:delegate".
 */
export function registerDelegationTools(pi: ExtensionAPI, session: GrantsSession): void {
  if (!session.mayDelegate) return;

  pi.registerTool({
    name: "delegate",
    label: "Delegate (governed)",
    description:
      "Delegate a task to a sub-agent holding ONLY the capabilities you grant it. You cannot grant what " +
      "you do not hold. Prefer 'agent' — it spawns a definition whose capabilities and instructions were " +
      "written by the operator. Use 'tools' only when no definition fits. Grant 'delegate' if the " +
      "sub-agent must itself delegate further; withhold it to make the sub-agent a leaf.",
    parameters: Type.Object({
      task: Type.String({ description: "The task for the sub-agent. It receives only this." }),
      agent: Type.Optional(
        Type.String({
          description:
            `Name of a definition to spawn — its allowed-tools become the grant and its instructions ` +
            `become the sub-agent's system prompt. Available: ${[...session.definitions.keys()].sort().join(", ") || "none"}.`,
        }),
      ),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Capabilities to grant when no 'agent' is named, e.g. [\"read\",\"grep\"] or " +
            "[\"tool:read\",\"ext:pkg/tool\"]. Empty means no tools. Ignored when 'agent' is given.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          // A bare id resolves across all known providers and can land on one there is no key for, so the
          // form is named rather than implied — see the "Verified live" defect in the README.
          description:
            "Model for the sub-agent as provider/id, e.g. \"openai-codex/gpt-5.6-sol\". " +
            "Defaults to this session's model, already provider-qualified.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const outcome = await runOneDelegation(
        session,
        { task: params.task, agent: params.agent, tools: params.tools, model: params.model },
        { parentId: session.ownSpawnId, childId: childSpawnId(session.ownSpawnId, 0) },
        // A single blocking delegation spends nothing from the subtree budget: cardinality is already
        // bounded to one by the call being blocking, which is the accident fan-out removes. Passing the
        // budget through unchanged means a child can still fan out with what this session was given.
        session.fanoutBudget,
        ctx,
        signal,
      );

      if (!outcome.ok) {
        // THROW, do not return. `AgentToolResult` has no `isError` field: pi sets it only when `execute`
        // throws (`pi-agent-core/dist/agent-loop.js` — a normal return is hardcoded `isError: false`).
        // Returning `isError: true` was silently discarded, so every refusal this package made was
        // recorded by pi as a SUCCESSFUL tool call. Found by the integration suite on its first run.
        const detail = outcome.text ? `\n\n${outcome.text}` : "";
        throw new Error(`delegation refused: ${outcome.reason}${detail}`);
      }

      return {
        content: [{ type: "text", text: outcome.text || "(no output)" }],
        details: { granted: outcome.granted, depth: outcome.depth, exitCode: outcome.exitCode },
      };
    },
  });

  /**
   * Bounded SYNCHRONOUS fan-out — ADR-0015's option A′.
   *
   * One call spawns several governed children concurrently and returns when the last one finishes. There is
   * deliberately no background mode, no result-by-id and no child registry, and that scoping is the whole
   * design: **fan-out and background are separable, fan-out carries most of the value, and background
   * carries nearly all of the state-machine holes.** Because the turn still owns the children, the parent
   * cannot exit before them, the tool-call signal is still live, the timeout still outlives every child,
   * results are returned rather than stored, and there are no ids to dangle across a compaction.
   *
   * Every child goes through `runOneDelegation`, so each one is planned, gated, audited and bounded by
   * exactly the same rules as a single `delegate`. What fan-out adds is a **cardinality bound** (the
   * budget) and **sibling identity** (F8) — the two things ADR-0008 never had, because a blocking
   * `delegate` bounded cardinality to one by accident.
   */
  pi.registerTool({
    name: "delegate_all",
    label: "Delegate to several sub-agents (governed, parallel)",
    description:
      "Run several sub-agents CONCURRENTLY and return all their results. Each child is governed exactly " +
      "as with `delegate`: it holds only what you grant it, and you cannot grant what you do not hold. " +
      `At most ${MAX_CHILDREN_PER_CALL} children per call, and a session-wide budget bounds the total ` +
      "across the whole delegation subtree. Children cannot see each other or share context. Use this " +
      "when independent tasks can proceed in parallel — several reviewers over one diff, say — and read " +
      "every child's outcome, because one can be refused while the others succeed.",
    parameters: Type.Object({
      children: Type.Array(
        Type.Object({
          task: Type.String({ description: "The task for this sub-agent. It receives only this." }),
          agent: Type.Optional(Type.String({ description: "Definition to spawn; its allowed-tools become the grant." })),
          tools: Type.Optional(Type.Array(Type.String(), { description: "Capabilities, when no 'agent' fits." })),
          model: Type.Optional(Type.String({ description: "Model as provider/id. Defaults to this session's." })),
        }),
        {
          minItems: 1,
          maxItems: MAX_CHILDREN_PER_CALL,
          description: "The sub-agents to run concurrently. Each is independent and unaware of the others.",
        },
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const children = params.children ?? [];
      const split = splitBudget(session.fanoutBudget, children.length);
      if (!split.ok) {
        // Thrown, not returned: a returned `isError` is discarded by pi, so a refusal that came back as a
        // normal result would read to the orchestrator as a successful fan-out of zero children.
        throw new Error(`fan-out refused: ${split.reason}`);
      }

      // Concurrent by construction. Each child gets its own budget share and its own ledger id, so the
      // records form a tree and two siblings can never be confused for one another.
      const outcomes = await Promise.all(
        children.map((child, index) =>
          runOneDelegation(
            session,
            child,
            { parentId: session.ownSpawnId, childId: childSpawnId(session.ownSpawnId, index) },
            split.perChild,
            ctx,
            signal,
          ),
        ),
      );

      const failed = outcomes.filter((o) => !o.ok);
      // Every child is reported, including the ones that failed. R-03's rule: a missing result must never
      // be indistinguishable from an empty one, and a fan-out that hid its refusals would let an
      // orchestrator summarise four reviews when only three happened.
      const report = outcomes
        .map((outcome, index) => {
          const label = `### child ${index + 1}${children[index].agent ? ` (${children[index].agent})` : ""}`;
          return outcome.ok
            ? `${label} — completed\n\n${outcome.text || "(no output)"}`
            : `${label} — FAILED: ${outcome.reason}${outcome.text ? `\n\n${outcome.text}` : ""}`;
        })
        .join("\n\n---\n\n");

      if (failed.length === children.length) {
        // All of them failed, so there is no partial result to hand back — and a tool that returns text
        // when nothing ran is exactly how a wrong summary gets written.
        throw new Error(`fan-out failed: every child was refused or failed.\n\n${report}`);
      }

      return {
        content: [{ type: "text", text: report }],
        details: {
          children: outcomes.length,
          failed: failed.length,
          budgetPerChild: split.perChild,
          granted: outcomes.map((o) => o.granted),
        },
      };
    },
  });
}
