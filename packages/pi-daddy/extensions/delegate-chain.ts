/**
 * `delegate_chain` — a governed sequential pipeline, planned and gated as one unit (ADR-0033).
 *
 * Its own file rather than a third tool in `delegation.ts`, which is near the 400-line ceiling. The seam is real
 * anyway: `delegate` and `delegate_all` differ only in cardinality, while a chain differs in **composition** — each
 * step's task is built from the previous step's output, and the whole thing is planned before any of it runs.
 *
 * **Nothing here re-implements a governance rule.** Every step goes through `runOneDelegation`, so the grant, the
 * ceiling, `agent:<name>` authorisation, the depth bound, the ledger and `--tools` enforcement are exactly what a
 * single `delegate` gets. What a chain adds is the handoff (`src/chain.ts`), one gate instead of N, a budget unit
 * per step, and abort-on-failure.
 *
 * **Why the upfront gate is exact rather than an approximation**, which is the least obvious thing here: an approval
 * is keyed `capability@subject` and **the task is never part of it** (ADR-0021 — the task is not stored anywhere). So
 * the union of a chain's gated capabilities is fully determined before any step's task exists, even though steps
 * 2..N have no task until their predecessor runs. That is what makes asking once honest instead of optimistic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { InheritableApproval } from "../src/approval.ts";
import { DELEGATE_SUBJECT, shouldSeekApproval } from "../src/approval.ts";
import { chainStepSpec, PLACEHOLDER, type ChainStep } from "../src/chain.ts";
import { planDelegation } from "../src/delegate.ts";
import { MAX_CHAIN_STEPS, childSpawnId, splitBudget } from "../src/fanout.ts";
import { PAINT_INTERVAL_MS, appendTail, emptyTail, renderProgress, replaceTail, throttle, type ChildProgress } from "../src/progress.ts";
import type { Capability } from "../src/resolve.ts";
import { recordChainRefusal } from "./chain-ledger.ts";
import { obtainApprovals, snapshotOf } from "./approvals.ts";
import { runOneDelegation } from "./run-delegation.ts";
import { isCriticalAssuranceBlock } from "./execute-child.ts";
import type { GrantsSession } from "./session.ts";
import { GovernanceRefusal, refusal, type StructuredRefusal } from "../src/refusals.ts";
import { chainApprovalFacts, newChainApprovalAudit, rememberChainApproval } from "./chain-approval-facts.ts";

/** One step of a chain, as the model describes it. */
type StepSpec = ChainStep;

/**
 * One dialog's worth of gate: a single capability, for a single subject, described by the step that needs it.
 *
 * **One request per `capability@subject`, not per subject.** Grouping by subject alone merged every `tools:`-only
 * step under the constant `<delegate>` and froze the *first* step's task into the dialog — so an operator approved
 * `tool:write` while reading a task that only listed files. The dialog is the one place a human learns what they are
 * authorising, so it names the step that actually needs the capability.
 */
interface GateRequest {
  subject: string;
  /** `"definition"` offers `always`; `"delegate"` must not (ADR-0019). Derived from the subject, never assumed. */
  path: "definition" | "delegate";
  capability: Capability;
  /** The task of the step that needs this capability. */
  task: string;
  stepIndex: number;
  plan: ReturnType<typeof planDelegation>;
}

/** Either every gate the chain will hit, or the first step that can never run and why. */
interface ChainPlan {
  requests: GateRequest[];
  /** Exact approval keys each step would spend, including duplicate subjects across steps. */
  uses: Map<number, Set<string>>;
  /** Set when a step is refused for a reason no approval can fix. The chain must refuse before asking anyone. */
  doomed?: { step: number; reason: string; plan: ReturnType<typeof planDelegation>; agent?: string; refusal?: StructuredRefusal };
}

/**
 * Plan every step and collect the gates — or find a step that can never run.
 *
 * **`plan.ok` is honoured here, and ignoring it was a privilege path.** The first version read only
 * `gatedBlocked`, so a step refused for an unheld `agent:` id, an unknown definition, an empty task or a universal
 * capability still raised its gate and the answer was still banked. Measured: `delegate({tools:["bash","agent:x"]})`
 * asks nobody and refuses, while the same step inside a chain raised a dialog, took *Allow for this session*, refused
 * anyway — and left `tool:bash` pre-approved for every later delegation in the session. On the `agent:` path it
 * banked a **30-day** entry, including for a step whose task was whitespace, whose dialog therefore read `task:`
 * followed by nothing.
 *
 * `shouldSeekApproval` is the rule every other gate in this package already applies, and its own docstring names
 * this hazard: *"both banked against a spawn that never happened, and both reachable by a model that appends one
 * unheld capability to an otherwise ordinary request."* The chain reimplemented the decision beside it instead of
 * routing through it. So a doomed step now refuses the whole chain **before any dialog**, which is the same
 * principle the executor check follows.
 *
 * Planned with no UI: `planWithApprovals` would open a dialog per step during the very phase whose purpose is to ask
 * upfront. A step's task is unknown for everything after the first, which is fine — an approval key never contains
 * the task (ADR-0021), so the set of gates is fully determined without it.
 */
async function planChain(session: GrantsSession, steps: StepSpec[], perStepBudget: number): Promise<ChainPlan> {
  const requests: GateRequest[] = [];
  const uses = new Map<number, Set<string>>();
  const seen = new Set<string>();
  const context = await session.delegationContext();

  for (const [index, step] of steps.entries()) {
    // The real task, not a placeholder: the planner's own empty-task guard must run here rather than at spawn time,
    // or a step with a whitespace task raises a dialog and is refused afterwards. The handoff is absent at planning
    // time and cannot change which capabilities are gated.
    const plan = planDelegation(
      {
        task: step.task,
        agent: step.agent,
        tools: step.tools,
        model: step.model,
        correlation: step.workspace
          ? { ...(step.correlation ?? {}), workspace_id: step.workspace.workspace_id }
          : step.correlation,
        // Routing spec, not the model's correlation claim — see R-110 in `src/correlation.ts`.
        boundWorkspaceId: step.workspace?.workspace_id,
        boundContextId: step.correlation?.context_id,
      },
      { ...context, spawnId: session.ownSpawnId, childSpawnId: childSpawnId(session.ownSpawnId, index) },
    );

    // A gate is the ONLY refusal an approval can lift. Anything else is doomed, and asking about it banks authority
    // for a spawn that will never happen.
    if (!plan.ok && !shouldSeekApproval(plan.result)) {
      return {
        requests: [], uses, doomed: {
          step: index + 1, reason: plan.reason ?? "this step cannot run", plan, agent: step.agent,
          ...(plan.refusal ? { refusal: plan.refusal } : {}),
        },
      };
    }

    // A correlated approval is bound to the exact task. Step N's final task does not exist until step N-1
    // finishes, so asking upfront would bind the template and then spend it on different instructions.
    // Legacy chains keep their upfront dialogs; correlated steps gate when their composed task exists.
    if (plan.approvalBinding) continue;

    const subject = step.agent ?? DELEGATE_SUBJECT;
    uses.set(index, new Set(plan.result.gatedBlocked.map((capability) => `${capability}@${subject}`)));
    for (const capability of plan.result.gatedBlocked) {
      const key = `${capability}@${subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requests.push({
        subject, path: step.agent ? "definition" : "delegate", capability, task: step.task, stepIndex: index, plan,
      });
    }
  }
  return { requests, uses };
}

export function registerChainTool(pi: ExtensionAPI, session: GrantsSession): void {
  // No `mayDelegate` guard here: `registerDelegationTools` already returns before calling this, so a second check
  // was dead code that made the leaf half of a wiring test pass for the wrong reason. The guard lives in one place.

  const stepShape = Type.Object({
    task: Type.String({
      description:
        `What this step should do. Write ${PLACEHOLDER} where the previous step's output belongs; if you omit it, ` +
        `that output is appended instead. The first step never receives one.`,
    }),
    agent: Type.Optional(Type.String({ description: "Definition to spawn for this step." })),
    tools: Type.Optional(Type.Array(Type.String(), { description: "Capabilities, when no 'agent' fits." })),
    model: Type.Optional(Type.String({ description: "Model as provider/id. Defaults to this session's." })),
    correlation: Type.Optional(Type.Object({
      schema_version: Type.Optional(Type.String()), run_id: Type.Optional(Type.String()),
      task_id: Type.Optional(Type.String()), workspace_id: Type.Optional(Type.String()),
      context_id: Type.Optional(Type.String()), phase: Type.Optional(Type.String()),
      assurance: Type.Optional(Type.String()), assurance_effective: Type.Optional(Type.String()),
      policy_label: Type.Optional(Type.String()), assurance_source: Type.Optional(Type.String()),
      assurance_scope: Type.Optional(Type.Any()), activated_at: Type.Optional(Type.String()),
      plan_digest: Type.Optional(Type.String()), definition_digest: Type.Optional(Type.String()),
      task_digest: Type.Optional(Type.String()), base_sha: Type.Optional(Type.String()),
      head_sha: Type.Optional(Type.String()), tree_sha: Type.Optional(Type.String()),
      event_seq: Type.Optional(Type.Number()), last_change_seq: Type.Optional(Type.Number()),
      last_authority_seq: Type.Optional(Type.Number()), check_receipt_id: Type.Optional(Type.String()),
    })),
    workspace: Type.Optional(Type.Object({
      workspace_id: Type.String(),
      access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
    })),
  });

  const params = Type.Object({
    steps: Type.Array(stepShape, {
      minItems: 1,
      maxItems: MAX_CHAIN_STEPS,
      description: "The steps to run IN ORDER. Each one sees the previous one's output.",
    }),
  });

  pi.registerTool({
    name: "delegate_chain",
    label: "Delegate a chain of sub-agents (governed, sequential)",
    description:
      "Run sub-agents ONE AFTER ANOTHER, each receiving the previous one's output. Use this when a step needs " +
      "what an earlier step produced — a decision feeding a design feeding an implementation. Use `delegate_all` " +
      "instead when the tasks are independent and can run at the same time, and `delegate` for a single child. " +
      `At most ${MAX_CHAIN_STEPS} steps, each spending one unit of the session's fan-out budget. Every step is ` +
      "governed exactly as a single `delegate` is: it holds only what you grant it, and you cannot grant what you " +
      "do not hold. A failed step ABORTS the rest, and you still receive everything that completed.",
    parameters: params,
    async execute(_toolCallId, args, signal, onUpdate, ctx) {
      const steps = args.steps ?? [];

      // **Every cheap refusal happens before any human is asked.** Yesterday's lesson on the `delegate` path: with
      // `PI_GRANTS_HERDR=1` and herdr down, the gate ran first, an operator approved `bash`, a 30-day entry was
      // written, and the delegation was then refused anyway. `runOneDelegation` checks the executor before its own
      // gate; a chain hoists its gate above `runOneDelegation`, so the check has to be repeated here or that
      // ordering is simply bypassed.
      if (session.executor.refusal) throw new GovernanceRefusal(refusal("EXECUTOR_UNAVAILABLE", `chain refused: ${session.executor.refusal}`));

      // Cardinality next, still before the gate. `splitBudget` is reused rather than re-derived, so a chain and a
      // fan-out cannot disagree about what the budget means.
      const split = splitBudget(session.fanoutBudget, steps.length);
      if (!split.ok) throw new GovernanceRefusal(refusal("FANOUT_EXCEEDED", `chain refused: ${split.reason}`));

      // Plan every step first. A step that can never run refuses the chain HERE, before anyone is asked — see
      // `planChain`.
      const chainPlan = await planChain(session, steps, split.perChild);
      if (chainPlan.doomed) {
        const message = `chain refused at step ${chainPlan.doomed.step}: ${chainPlan.doomed.reason} No step ran, and nobody was ` +
          `asked to approve anything — a step that cannot run must not bank authority for a spawn that will never happen.`;
        await recordChainRefusal({
          session, plan: chainPlan.doomed.plan, stepIndex: chainPlan.doomed.step - 1,
          agent: chainPlan.doomed.agent, reason: message, refusal: chainPlan.doomed.refusal,
        });
        if (chainPlan.doomed.refusal) throw new GovernanceRefusal({ ...chainPlan.doomed.refusal, message });
        throw new Error(message);
      }

      // One dialog per `capability@subject`, each naming the step that needs it, all before the first step runs.
      const preApproved: InheritableApproval[] = [];
      const approvalAudit = newChainApprovalAudit();
      const approvalStep = new Map<string, number>();
      const approvedDecisions: Array<{ request: GateRequest; outcome: Awaited<ReturnType<typeof obtainApprovals>> }> = [];
      let declined: { request: GateRequest; outcome: Awaited<ReturnType<typeof obtainApprovals>> } | undefined;

      for (const request of chainPlan.requests) {
        const outcome = await obtainApprovals(session, [request.capability], request.subject, request.path, ctx, request.task, signal);
        if (!outcome.approved.includes(request.capability)) {
          // **Stop asking.** The chain's outcome is already fixed, and every further dialog banks authority — a
          // `session` yes into `sessionApprovals` and an `always` yes onto disk for 30 days — for a chain that will
          // not run. The single-delegate path breaks on the first no for the same reason.
          declined = { request, outcome };
          break;
        }
        preApproved.push({
          capability: request.capability,
          subject: request.subject,
          scope: outcome.scopes[request.capability] ?? ("once" as const),
          // Pinned to THIS subject's body (ADR-0022). Stamped from a single shared subject, the pin was verified
          // against one definition's instructions while the capability was spent on another's.
          bodySha256: snapshotOf(session, request.subject)?.bodySha256,
        });
        rememberChainApproval(approvalAudit, request.capability, request.subject, outcome);
        approvalStep.set(`${request.capability}@${request.subject}`, request.stepIndex);
        approvedDecisions.push({ request, outcome });
      }

      if (declined) {
        const { request, outcome } = declined;
        const message = `chain refused: ${request.capability} was not approved for ${request.subject}, so no step ran. A chain ` +
          `is gated as a unit — running only its approved steps would return a partial result that reads like a complete one.`;
        const structured = outcome.refusalCode ? refusal(outcome.refusalCode, message) : undefined;
        for (const approved of approvedDecisions) {
          await recordChainRefusal({
            session, plan: approved.request.plan, stepIndex: approved.request.stepIndex,
            agent: steps[approved.request.stepIndex]?.agent, reason: message, approval: approved.outcome,
          });
        }
        await recordChainRefusal({
          session, plan: request.plan, stepIndex: request.stepIndex, agent: steps[request.stepIndex]?.agent,
          reason: message, refusal: structured, approval: outcome,
        });
        if (structured) throw new GovernanceRefusal(structured);
        throw new Error(message);
      }

      const children: ChildProgress[] = steps.map((step) => ({
        label: step.agent ?? "delegate",
        state: "starting",
        startedAt: Date.now(),
        tail: emptyTail,
      }));
      const paint = throttle(() => {
        (onUpdate as ((partial: { content: Array<{ type: "text"; text: string }> }) => void) | undefined)?.({
          content: [{ type: "text", text: renderProgress(children, session.executor.kind, Date.now()) }],
        });
      }, PAINT_INTERVAL_MS);

      const outcomes: Array<{
        ok: boolean; text: string; reason?: string; refusal?: StructuredRefusal; step: number; agent?: string;
      }> = [];
      let previous: string | undefined;
      let aborted = false;
      /**
       * Approvals still available to later steps.
       *
       * **`once` is consumed by the first step that spends it, and not honouring that was a confused deputy.**
       * Measured: three steps of one definition, one dialog naming step 1's task — *"survey the north field"* — and
       * three children spawned, the last of which had been told *"…and burn the evidence"*. Steps 2 and 3 were never
       * described to anyone. Two sequential plain `delegate` calls raise two dialogs, because a `once` answer never
       * enters `sessionApprovals`; the chain was the outlier. R-29 exists for this exact shape one level down.
       *
       * A later step needing the same capability now reaches its own gate and prompts with its OWN task, which is
       * what `once` means.
       */
      let available = [...preApproved];

      for (const [index, step] of steps.entries()) {
        const childId = childSpawnId(session.ownSpawnId, index);
        const availableForStep = available.filter((approval) => {
          const key = `${approval.capability}@${approval.subject}`;
          return chainPlan.uses.get(index)?.has(key) &&
            (approval.scope !== "once" || approvalStep.get(key) === index);
        });
        const outcome = await runOneDelegation(
          session,
          chainStepSpec(step, previous),
          { parentId: session.ownSpawnId, childId },
          split.perChild,
          ctx,
          signal,
          {
            preApproved: availableForStep,
            // Only approvals actually offered to this step are attributed or consumed here.
            approvalFacts: chainApprovalFacts(approvalAudit, availableForStep, step.agent ?? DELEGATE_SUBJECT),
            onProgress: (update) => {
              const child = children[index];
              if (!child) return;
              if (update.paneId) child.paneId = update.paneId;
              if (update.agentName) child.agentName = update.agentName;
              if (update.chunk) child.tail = appendTail(child.tail, update.chunk);
              if (update.snapshot) child.tail = replaceTail(update.snapshot);
              if (update.state) child.state = update.state;
              else if (child.state === "starting") child.state = "running";
              paint.call();
            },
            // Provenance: which child's output composed THIS step's task (ADR-0033). Absent for step 1.
            taskFrom: index === 0 ? undefined : childSpawnId(session.ownSpawnId, index - 1),
          },
        );

        children[index].state = outcome.ok ? "completed" : "failed";
        children[index].settledAt = Date.now();
        outcomes.push({
          ok: outcome.ok, text: outcome.text, reason: outcome.reason, refusal: outcome.refusal,
          step: index + 1, agent: step.agent,
        });
        if (isCriticalAssuranceBlock(outcome)) throw new Error(outcome.text);

        // Spend any `once` this step was handed, before the next step sees the list.
        available = available.filter((approval) =>
          approval.scope !== "once" || approvalStep.get(`${approval.capability}@${approval.subject}`) !== index,
        );

        if (!outcome.ok) {
          // **Abort, and mark the rest.** Continuing would make the next step's task an error message, which is
          // never what an orchestrator wants. Everything completed is still returned — R-03's rule.
          aborted = true;
          for (let rest = index + 1; rest < children.length; rest += 1) children[rest].state = "failed";
          break;
        }
        previous = outcome.text;
      }
      paint.flush();

      const report = outcomes
        .map((o) => {
          const label = `### step ${o.step}${o.agent ? ` (${o.agent})` : ""}`;
          return o.ok ? `${label} — completed\n\n${o.text || "(no output)"}` : `${label} — FAILED: ${o.reason}${o.text ? `\n\n${o.text}` : ""}`;
        })
        .join("\n\n---\n\n");

      const skipped = steps.length - outcomes.length;
      const tail = aborted
        ? `\n\n---\n\n**The chain stopped at step ${outcomes.length}.** ${skipped} later step(s) did not run, ` +
          `because each one's task is built from the previous step's output and there was none to pass on.`
        : "";

      if (outcomes.length === 1 && !outcomes[0].ok) {
        // Nothing completed at all, so there is no partial result to hand back — and a tool that returns text when
        // nothing ran is how a wrong summary gets written.
        const message = `chain failed at its first step.\n\n${report}`;
        if (outcomes[0].refusal) throw new GovernanceRefusal({ ...outcomes[0].refusal, message });
        throw new Error(message);
      }

      return {
        content: [{ type: "text", text: `${report}${tail}` }],
        details: {
          steps: steps.length, completed: outcomes.filter((o) => o.ok).length, aborted,
          budgetPerStep: split.perChild, refusals: outcomes.map((outcome) => outcome.refusal ?? null),
        },
      };
    },
  });
}
