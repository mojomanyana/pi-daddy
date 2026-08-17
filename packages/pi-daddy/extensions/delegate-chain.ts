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
import { chainStepSpec, PLACEHOLDER } from "../src/chain.ts";
import { planDelegation } from "../src/delegate.ts";
import { MAX_CHAIN_STEPS, childSpawnId, splitBudget } from "../src/fanout.ts";
import { PAINT_INTERVAL_MS, appendTail, emptyTail, renderProgress, replaceTail, throttle, type ChildProgress } from "../src/progress.ts";
import type { Capability } from "../src/resolve.ts";
import { appendRecord, buildRecord } from "../src/ledger.ts";
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

/** One subject's gated capabilities, and the task of the first step that needed them. */
interface GateGroup {
  subject: string;
  /** `"definition"` offers `always`; `"delegate"` must not (ADR-0019). Derived per group, never assumed. */
  path: "definition" | "delegate";
  capabilities: Capability[];
  /** Shown in the dialog, so an operator sees WHAT the step will do — as a single `delegate` does. */
  task: string;
}

/**
 * Every gate the chain will hit, **grouped by the subject an approval is keyed to**.
 *
 * **Grouped, not unioned — and that is a correction to ADR-0033.** The ADR specified one dialog for the whole
 * chain, illustrated as *"this chain needs `tool:bash` for build, review, debug, git-ops"*. **That dialog cannot
 * exist.** An approval is keyed `capability@subject`, so one dialog means one subject; asking once for a union
 * spanning four definitions is asking about one of them and spending the answer on the other three. Three
 * independent reviewers found it, and the measured consequence was that a 30-day entry keyed to `build` satisfied
 * `review` and `git-ops` in every later session with no dialog at all — ADR-0014's A-S6 falsified.
 *
 * So the guarantee is narrowed to what is actually achievable and still worth having: **every dialog is raised
 * upfront, before any step runs, and there is at most one per `capability@subject`.** For the operator's own
 * pipeline that is two dialogs together at the start rather than two arriving minutes apart mid-run, which was the
 * point.
 *
 * Planned with **no UI** — `planWithApprovals` would open a dialog per step during the very phase whose purpose is
 * to ask upfront. `planDelegation` is the pure planner underneath it.
 *
 * A step's task is unknown here for everything after the first, which is fine: an approval key never contains the
 * task (ADR-0021), so the set of gates is fully determined without it. `"(planning)"` reaches no child.
 */
async function gateGroups(session: GrantsSession, steps: StepSpec[], perStepBudget: number): Promise<GateGroup[]> {
  const groups = new Map<string, GateGroup>();
  const context = await session.delegationContext();

  for (const [index, step] of steps.entries()) {
    const plan = planDelegation(
      { task: "(planning)", agent: step.agent, tools: step.tools, model: step.model },
      { ...context, fanoutBudget: perStepBudget, spawnId: session.ownSpawnId, childSpawnId: childSpawnId(session.ownSpawnId, index) },
    );
    if (plan.result.gatedBlocked.length === 0) continue;

    const subject = step.agent ?? DELEGATE_SUBJECT;
    const group =
      groups.get(subject) ??
      // `path` follows the subject, exactly as `runOneDelegation` derives it. Hardcoding `"definition"` offered
      // *Always allow in this project (30 days)* for a model-chosen `tools:` list — the one thing ADR-0019 says
      // must never be persisted, because "a key the model controls is not a key".
      { subject, path: step.agent ? ("definition" as const) : ("delegate" as const), capabilities: [], task: step.task };
    for (const capability of plan.result.gatedBlocked) {
      if (!group.capabilities.includes(capability)) group.capabilities.push(capability);
    }
    groups.set(subject, group);
  }
  return [...groups.values()];
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
      if (session.executor.refusal) throw new Error(`chain refused: ${session.executor.refusal}`);

      // Cardinality next, still before the gate. `splitBudget` is reused rather than re-derived, so a chain and a
      // fan-out cannot disagree about what the budget means.
      const split = splitBudget(session.fanoutBudget, steps.length);
      if (!split.ok) throw new Error(`chain refused: ${split.reason}`);

      // One dialog per `capability@subject`, all raised now — see `gateGroups` for why this is grouped rather than
      // unioned, and what ADR-0033 got wrong.
      const groups = await gateGroups(session, steps, split.perChild);
      const preApproved: InheritableApproval[] = [];
      const declined: Capability[] = [];
      let humanDenied = false;

      for (const group of groups) {
        const outcome = await obtainApprovals(session, group.capabilities, group.subject, group.path, ctx, group.task, signal);
        humanDenied = humanDenied || outcome.humanDenied;
        for (const capability of group.capabilities) {
          if (!outcome.approved.includes(capability)) {
            declined.push(capability);
            continue;
          }
          preApproved.push({
            capability,
            subject: group.subject,
            scope: outcome.scopes[capability] ?? ("once" as const),
            // Pinned to THIS subject's body. It was stamped from the union's single subject, so ADR-0022's pin was
            // verified against one definition's instructions while the capability was spent on another's — and that
            // mispinned entry is what the other definition's own children inherited.
            bodySha256: snapshotOf(session, group.subject)?.bodySha256,
          });
        }
      }

      if (declined.length > 0) {
        // **Recorded before it is thrown.** A gate-refused chain used to leave no ledger line at all, which
        // contradicts `docs/SPEC.md`'s "one record per governed decision — including refusals" and leaves
        // `/grants ledger`'s approval tally blind to every chain. A human was asked and said no; that is exactly
        // the event the trail exists for.
        if (session.ledgerPath) {
          await appendRecord(
            { path: session.ledgerPath, strict: true },
            buildRecord({
              parentId: session.ownSpawnId,
              childId: childSpawnId(session.ownSpawnId, 0),
              depth: session.depth + 1,
              agentType: steps[0]?.agent ?? "delegate_chain",
              requested: declined,
              parentGrant: session.ownGrant,
              result: { effective: [], denied: [], clipped: [], gatedBlocked: declined, universal: [], subsumedBy: [] },
              blocked: true,
              humanDenied,
              reason: `chain refused: ${declined.join(", ")} not approved; no step ran`,
              executor: session.executor.kind,
              now: new Date(),
            }),
          ).catch(() => undefined);
        }
        throw new Error(
          `chain refused: ${declined.join(", ")} ${declined.length === 1 ? "was" : "were"} not approved, so no ` +
            `step ran. A chain is gated as a unit — running only its ungated steps would return a partial ` +
            `result that reads like a complete one.`,
        );
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
          chainStepSpec(step, previous),
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
