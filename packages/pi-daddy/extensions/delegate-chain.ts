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
import { DELEGATE_SUBJECT } from "../src/approval.ts";
import { composeStepTask, PLACEHOLDER } from "../src/chain.ts";
import { planDelegation } from "../src/delegate.ts";
import { MAX_CHAIN_STEPS, childSpawnId, splitBudget } from "../src/fanout.ts";
import { PAINT_INTERVAL_MS, appendTail, emptyTail, renderProgress, replaceTail, throttle, type ChildProgress } from "../src/progress.ts";
import type { Capability } from "../src/resolve.ts";
import { obtainApprovals, snapshotOf } from "./approvals.ts";
import { runOneDelegation } from "./run-delegation.ts";
import type { GrantsSession } from "./session.ts";

/** One step of a chain, as the model describes it. */
interface StepSpec {
  task: string;
  agent?: string;
  tools?: string[];
  model?: string;
}

/**
 * Every gated capability the whole chain will need, and which definition each belongs to.
 *
 * Collected by planning each step with **no UI** — `planWithApprovals` is deliberately not used, because it would
 * open a dialog per step during the very phase whose purpose is to ask once. `planDelegation` is the pure planner
 * underneath it.
 *
 * A step's task is unknown at this point for everything after the first; that is fine, and the module header says
 * why. `"(planning)"` is a placeholder that reaches no child and is never stored.
 */
async function unionOfGates(
  session: GrantsSession,
  steps: StepSpec[],
  perStepBudget: number,
): Promise<{ gated: Capability[]; subjects: Map<Capability, string> }> {
  const gated: Capability[] = [];
  const subjects = new Map<Capability, string>();
  const context = await session.delegationContext();

  for (const [index, step] of steps.entries()) {
    const plan = planDelegation(
      { task: "(planning)", agent: step.agent, tools: step.tools, model: step.model },
      { ...context, fanoutBudget: perStepBudget, spawnId: session.ownSpawnId, childSpawnId: childSpawnId(session.ownSpawnId, index) },
    );
    for (const capability of plan.result.gatedBlocked) {
      if (subjects.has(capability)) continue;
      gated.push(capability);
      // The subject an approval is keyed to: the definition when there is one, `<delegate>` otherwise (ADR-0019).
      subjects.set(capability, step.agent ?? DELEGATE_SUBJECT);
    }
  }
  return { gated, subjects };
}

export function registerChainTool(pi: ExtensionAPI, session: GrantsSession): void {
  if (!session.mayDelegate) return;

  const stepShape = Type.Object({
    task: Type.String({
      description:
        `What this step should do. Write ${PLACEHOLDER} where the previous step's output belongs; if you omit it, ` +
        `that output is appended instead. The first step never receives one.`,
    }),
    agent: Type.Optional(Type.String({ description: "Definition to spawn for this step." })),
    tools: Type.Optional(Type.Array(Type.String(), { description: "Capabilities, when no 'agent' fits." })),
    model: Type.Optional(Type.String({ description: "Model as provider/id. Defaults to this session's." })),
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

      // Cardinality first, before any planning: a chain too long for the budget must not raise a dialog on its way
      // to being refused. `splitBudget` is reused rather than re-derived, so a chain and a fan-out cannot disagree
      // about what the budget means.
      const split = splitBudget(session.fanoutBudget, steps.length);
      if (!split.ok) throw new Error(`chain refused: ${split.reason}`);

      // ONE gate for the whole chain. See `unionOfGates` and the module header for why this is exact.
      const { gated, subjects } = await unionOfGates(session, steps, split.perChild);
      let preApproved: InheritableApproval[] = [];
      if (gated.length > 0) {
        // Keyed to the FIRST subject that needed each capability, which is what the dialog names. A capability
        // gated for two definitions is asked about once; each step then re-checks it against its own ceiling, so
        // nothing is widened by sharing the answer.
        const outcome = await obtainApprovals(session, gated, subjects.get(gated[0]) ?? DELEGATE_SUBJECT, "definition", ctx, undefined, signal);
        if (outcome.approved.length < gated.length) {
          // Fail closed, and spawn NOTHING. Running the steps that happen to be ungated would be a partial chain
          // whose output looks like a whole one.
          const missing = gated.filter((c) => !outcome.approved.includes(c));
          throw new Error(
            `chain refused: ${missing.join(", ")} ${missing.length === 1 ? "was" : "were"} not approved, so no ` +
              `step ran. A chain is gated as a unit — running only its ungated steps would return a partial ` +
              `result that reads like a complete one.${outcome.reason ? ` (${outcome.reason})` : ""}`,
          );
        }
        preApproved = outcome.approved.map((capability) => ({
          capability,
          subject: subjects.get(capability) ?? DELEGATE_SUBJECT,
          scope: outcome.scopes[capability] ?? ("once" as const),
          bodySha256: snapshotOf(session, subjects.get(capability) ?? DELEGATE_SUBJECT)?.bodySha256,
        }));
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

      const outcomes: Array<{ ok: boolean; text: string; reason?: string; step: number; agent?: string }> = [];
      let previous: string | undefined;
      let aborted = false;

      for (const [index, step] of steps.entries()) {
        const childId = childSpawnId(session.ownSpawnId, index);
        const outcome = await runOneDelegation(
          session,
          { ...step, task: composeStepTask(step.task, previous) },
          { parentId: session.ownSpawnId, childId },
          split.perChild,
          ctx,
          signal,
          {
            preApproved,
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
        outcomes.push({ ok: outcome.ok, text: outcome.text, reason: outcome.reason, step: index + 1, agent: step.agent });

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
        throw new Error(`chain failed at its first step.\n\n${report}`);
      }

      return {
        content: [{ type: "text", text: `${report}${tail}` }],
        details: { steps: steps.length, completed: outcomes.filter((o) => o.ok).length, aborted, budgetPerStep: split.perChild },
      };
    },
  });
}
