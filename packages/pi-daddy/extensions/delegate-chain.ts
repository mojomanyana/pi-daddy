import { operationIdShape, claimDelegationOperation, existingOperationOutcome } from "./delegation-operations.ts";
import { publicEvidenceCall } from "./public-evidence.ts";
import { executionEvidenceContent } from "./execution-evidence.ts";
import { assertDefinitionIdentity } from "./definition-describe.ts";
/**
 * `delegate_chain` — a governed sequential pipeline, planned and gated as one unit (ADR-0033).
 *
 * Its own file rather than a third tool in `delegation.ts`, which is near the 400-line ceiling. The seam is real
 * anyway: `delegate` and `delegate_all` differ only in cardinality, while a chain differs in **composition** — each
 * step's task is built from the previous step's output, and the whole thing is planned before any of it runs.
 *
 * **Nothing here re-implements a governance rule.** Every step goes through `runOneDelegation`, so the grant, the
 * ceiling, `agent:<name>` authorisation, the depth bound, the ledger and `--tools` enforcement are exactly what a
 * single `delegate` gets. What a chain adds is the handoff (`src/kernel/chain.ts`), one gate instead of N, a budget unit
 * per step, and abort-on-failure.
 *
 * **Why the upfront gate is exact rather than an approximation**, which is the least obvious thing here: an approval
 * is keyed `capability@subject` and **the task is never part of it** (ADR-0021 — the task is not stored anywhere). So
 * the union of a chain's gated capabilities is fully determined before any step's task exists, even though steps
 * 2..N have no task until their predecessor runs. That is what makes asking once honest instead of optimistic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { InheritableApproval } from "../src/kernel/approval.ts";
import { DELEGATE_SUBJECT } from "../src/kernel/approval.ts";
import { reconcileDelegationCapacity, reserveDelegationCapacity } from "./session-capacity.ts";
import { chainStepSpec, PLACEHOLDER, HANDOFF_MAX_BYTES } from "../src/kernel/chain.ts";
import { MAX_CHAIN_STEPS, childSpawnId } from "../src/kernel/fanout.ts";
import {
  PAINT_INTERVAL_MS,
  appendTail,
  emptyTail,
  renderProgress,
  replaceTail,
  throttle,
  type ChildProgress,
} from "../src/kernel/progress.ts";
import { correlationShape } from "./correlation-shape.ts";
import { recordChainRefusal } from "./chain-ledger.ts";
import { obtainApprovals, snapshotOf, type ApprovalOutcome } from "./approvals.ts";
import { runOneDelegation } from "./run-delegation.ts";
import { isCriticalAssuranceBlock } from "./execute-child.ts";
import type { GrantsSession } from "./session.ts";
import { GovernanceRefusal, refusal, type StructuredRefusal } from "../src/kernel/refusals.ts";
import { chainApprovalFacts, newChainApprovalAudit, rememberChainApproval } from "./chain-approval-facts.ts";
import { newExecutionId } from "../src/kernel/execution-id.ts";
import { planChain, type GateRequest } from "./chain-plan.ts";
import { contextShape } from "./context-shape.ts";
import { preflightModel, runtimePairUnavailable } from "../src/kernel/model-preflight.ts";
import { resolveDefinitionRuntime } from "./definition-runtime.ts";
import { withoutRetiredDelegationArguments } from "./retired-inputs.ts";
import { assertDelegationAuthority } from "./delegation-authority.ts";

/** One chain step is one execution occurrence, however many capability dialogs contributed to its answer. */
function mergeGateOutcomes(outcomes: readonly ApprovalOutcome[]): ApprovalOutcome {
  const merged = {
    approved: [...new Set(outcomes.flatMap((outcome) => outcome.approved))],
    sources: Object.assign({}, ...outcomes.map((outcome) => outcome.sources)),
    scopes: Object.assign({}, ...outcomes.map((outcome) => outcome.scopes)),
    recordedScopes: Object.assign({}, ...outcomes.map((outcome) => outcome.recordedScopes)),
    bindings: Object.assign({}, ...outcomes.map((outcome) => outcome.bindings)),
    expiresAt: Object.assign({}, ...outcomes.map((outcome) => outcome.expiresAt)),
    uses: Object.assign({}, ...outcomes.map((outcome) => outcome.uses)),
    humanDenied: outcomes.some((outcome) => outcome.humanDenied),
  } satisfies ApprovalOutcome;
  const last = outcomes.findLast((outcome) => outcome.gateOutcome !== undefined);
  const banked = outcomes.flatMap((outcome) => outcome.banked ?? []);
  return {
    ...merged,
    ...(last?.gateOutcome ? { gateOutcome: last.gateOutcome } : {}),
    ...(last?.refusalCode ? { refusalCode: last.refusalCode } : {}),
    ...(last?.reason ? { reason: last.reason } : {}),
    ...(banked.length > 0 ? { banked } : {}),
  };
}

export function registerChainTool(pi: ExtensionAPI, session: GrantsSession): void {
  const stepShape = Type.Object({
    operation_id: operationIdShape(),
    definitionId: Type.Optional(
      Type.String({ description: "Snapshot id returned by delegate_describe; required for Principal phases." }),
    ),
    task: Type.String({
      description:
        `What this step should do. Write ${PLACEHOLDER} where the previous step's output belongs; if you omit it, ` +
        `that output is appended instead. The first step never receives one.`,
    }),
    agent: Type.Optional(Type.String({ description: "Definition to spawn for this step." })),
    tools: Type.Optional(Type.Array(Type.String(), { description: "Capabilities, when no 'agent' fits." })),
    model: Type.Optional(Type.String({ description: "Model as provider/id. Defaults to this session's." })),
    thinking: Type.Optional(
      Type.Union(
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)),
        { description: "Requested Pi thinking level; unsupported model/level combinations fail in the child." },
      ),
    ),
    context: Type.Optional(contextShape()),
    correlation: Type.Optional(correlationShape()),
    workspace: Type.Optional(
      Type.Object({
        workspace_id: Type.String(),
        access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
      }),
    ),
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
    prepareArguments: withoutRetiredDelegationArguments,
    async execute(_toolCallId, args, signal, onUpdate, ctx) {
      assertDelegationAuthority(session);
      const steps = args.steps ?? [];
      await session.ensureDefinitions?.();
      for (const step of steps) assertDefinitionIdentity(session, step);

      // **Every cheap refusal happens before any human is asked.** Yesterday's lesson on the `delegate` path: with
      // `PI_DADDY_HERDR=1` and herdr down, the gate ran first, an operator approved `bash`, a 30-day entry was
      // written, and the delegation was then refused anyway. `runOneDelegation` checks the executor before its own
      // gate; a chain hoists its gate above `runOneDelegation`, so the check has to be repeated here or that
      // ordering is simply bypassed.
      if (session.executor.refusal)
        throw new GovernanceRefusal(refusal("EXECUTOR_UNAVAILABLE", `chain refused: ${session.executor.refusal}`));

      if (steps.length < 1 || steps.length > MAX_CHAIN_STEPS)
        throw new GovernanceRefusal(refusal("FANOUT_EXCEEDED", `chain needs 1 to ${MAX_CHAIN_STEPS} steps`));

      // Plan every step first. A step that can never run refuses the chain HERE, before anyone is asked — see
      // `planChain`.
      const executionIds = steps.map(() => newExecutionId());
      await reconcileDelegationCapacity(session);
      const firstClaim = await claimDelegationOperation(
        session,
        steps[0],
        {
          executionId: executionIds[0],
          parentExecutionId: session.ownExecutionId ?? null,
          parentId: session.ownSpawnId,
          childId: childSpawnId(session.ownSpawnId, 0),
        },
        ctx,
        signal,
      );
      const capture = publicEvidenceCall(
        session.publicEvidence,
        _toolCallId,
        "delegate_chain",
        steps,
        executionIds.map((id, index) => (index === 0 ? (firstClaim?.operation.executionId ?? id) : id)),
      );
      if (firstClaim?.reused) {
        const outcome = existingOperationOutcome(firstClaim, session.depth + 1);
        return capture.finish(
          {
            isError: false,
            content: [
              { type: "text", text: outcome.text },
              executionEvidenceContent("delegate_chain", [outcome], steps.length),
            ],
            details: { outcomes: [outcome], steps: steps.length, completed: 0, aborted: true },
          },
          [outcome],
        );
      }
      let firstReservation: ReturnType<typeof reserveDelegationCapacity>;
      try {
        firstReservation = reserveDelegationCapacity(session, executionIds[0]);
      } catch (error) {
        await firstClaim?.finish?.("not-started");
        throw error;
      }
      try {
        const parentExecutionId = session.ownExecutionId ?? null;
        const piModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const runtimeChoices = new Map<
          import("../src/kernel/chain.ts").ChainStep,
          import("./definition-runtime.ts").ResolvedDefinitionRuntime
        >();
        const chainPlan = await planChain(
          session,
          steps,
          executionIds,
          (model) =>
            preflightModel(model, ctx.modelRegistry, session.modelResolutionCache, session.allowUnresolvedModels),
          (step) => {
            const selected = resolveDefinitionRuntime({
              definition: step.agent,
              explicit: { model: step.model, thinking: step.thinking },
              session: session.definitionRuntimeOverrides,
              settings: session.definitionRuntimeSettings,
              piModel,
              piThinking: session.currentThinking?.(),
              authoredPreferences: step.agent ? session.definitions.get(step.agent)?.runtimePreferences : undefined,
              unavailable: (choice) => runtimePairUnavailable(choice, ctx.modelRegistry, session.allowUnresolvedModels),
            });
            runtimeChoices.set(step, selected);
            return selected.model;
          },
        );
        if (chainPlan.doomed) {
          const message =
            `chain refused at step ${chainPlan.doomed.step}: ${chainPlan.doomed.reason} No step ran, and nobody was ` +
            `asked to approve anything — a step that cannot run must not bank authority for a spawn that will never happen.`;
          await recordChainRefusal({
            session,
            plan: chainPlan.doomed.plan,
            stepIndex: chainPlan.doomed.step - 1,
            executionId: executionIds[chainPlan.doomed.step - 1],
            parentExecutionId,
            agent: chainPlan.doomed.agent,
            reason: message,
            refusal: chainPlan.doomed.refusal,
          });
          if (chainPlan.doomed.refusal) throw new GovernanceRefusal({ ...chainPlan.doomed.refusal, message });
          throw new Error(message);
        }

        // One dialog per `capability@subject`, each naming the step that needs it, all before the first step runs.
        const preApproved: InheritableApproval[] = [];
        const approvalAudit = newChainApprovalAudit();
        const approvalStep = new Map<string, number>();
        const approvedDecisions: Array<{ request: GateRequest; outcome: Awaited<ReturnType<typeof obtainApprovals>> }> =
          [];
        let declined: { request: GateRequest; outcome: Awaited<ReturnType<typeof obtainApprovals>> } | undefined;

        for (const request of chainPlan.requests) {
          const outcome = await obtainApprovals(
            session,
            [request.capability],
            request.subject,
            request.path,
            ctx,
            request.task,
            signal,
          );
          if (!outcome.approved.includes(request.capability)) {
            // **Stop asking.** The chain's outcome is already fixed, and every further dialog banks authority — a
            // `session` yes into `sessionApprovals` and an `always` yes onto disk for 30 days — for a chain that will
            // not run. The single-delegate path breaks on the first no for the same reason.
            declined = { request, outcome };
            break;
          }
          // Auto is provisional and belongs to an actual step admission, never the upfront union.
          if (outcome.sources[request.capability] === "auto") continue;
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
          const message =
            `chain refused: ${request.capability} was not approved for ${request.subject}, so no step ran. A chain ` +
            `is gated as a unit — running only its approved steps would return a partial result that reads like a complete one.`;
          const structured = outcome.refusalCode ? refusal(outcome.refusalCode, message) : undefined;
          const decisions = new Map<
            number,
            { request: GateRequest; outcomes: ApprovalOutcome[]; refusal?: typeof structured }
          >();
          for (const approved of approvedDecisions) {
            const decision = decisions.get(approved.request.stepIndex) ?? {
              request: approved.request,
              outcomes: [],
            };
            decision.outcomes.push(approved.outcome);
            decisions.set(approved.request.stepIndex, decision);
          }
          const deniedDecision = decisions.get(request.stepIndex) ?? { request, outcomes: [] };
          deniedDecision.request = request;
          deniedDecision.outcomes.push(outcome);
          deniedDecision.refusal = structured;
          decisions.set(request.stepIndex, deniedDecision);

          for (const [stepIndex, decision] of [...decisions].sort(([left], [right]) => left - right)) {
            await recordChainRefusal({
              session,
              plan: decision.request.plan,
              stepIndex,
              executionId: executionIds[stepIndex],
              parentExecutionId,
              agent: steps[stepIndex]?.agent,
              reason: message,
              refusal: decision.refusal,
              approval: mergeGateOutcomes(decision.outcomes),
            });
          }
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
          try {
            (onUpdate as ((partial: { content: Array<{ type: "text"; text: string }> }) => void) | undefined)?.({
              content: [{ type: "text", text: renderProgress(children, session.executor.kind, Date.now()) }],
            });
          } catch {
            // Display only: a broken partial-result sink must not become a child cancellation mechanism.
          }
        }, PAINT_INTERVAL_MS);

        const outcomes: Array<import("./execute-child.ts").DelegationOutcome & { step: number; agent?: string }> = [];
        let previous: string | undefined;
        let aborted = false;
        let blockedReason: "full-final-too-large-for-handoff" | undefined;
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
            return (
              chainPlan.uses.get(index)?.has(key) && (approval.scope !== "once" || approvalStep.get(key) === index)
            );
          });
          const outcome = await runOneDelegation(
            session,
            chainStepSpec(step, previous),
            {
              parentId: session.ownSpawnId,
              childId,
              executionId: executionIds[index],
              parentExecutionId,
            },
            index === 0 ? firstReservation.childAllowance : undefined,
            ctx,
            signal,
            {
              ...(index === 0 ? { capacityReservation: firstReservation, operationClaim: firstClaim } : {}),
              resolvedRuntime: runtimeChoices.get(step),
              onDefinition: (definition) => capture.selected(index, definition),
              preApproved: availableForStep,
              toolCallId: _toolCallId,
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
              taskFromExecutionId: index === 0 ? undefined : executionIds[index - 1],
            },
          );

          children[index].state = outcome.ok ? "completed" : "failed";
          children[index].settledAt = Date.now();
          outcomes.push({
            ...outcome,
            step: index + 1,
            agent: step.agent,
          });
          if (isCriticalAssuranceBlock(outcome)) throw new Error(outcome.text);

          // Spend any `once` this step was handed, before the next step sees the list.
          available = available.filter(
            (approval) =>
              approval.scope !== "once" || approvalStep.get(`${approval.capability}@${approval.subject}`) !== index,
          );

          if (!outcome.ok || outcome.control === "failed" || outcome.final?.state === "unavailable") {
            // **Abort, and mark the rest.** Continuing would make the next step's task an error message, which is
            // never what an orchestrator wants. Everything completed is still returned — R-03's rule.
            aborted = true;
            for (let rest = index + 1; rest < children.length; rest += 1) children[rest].state = "failed";
            break;
          }
          if (index + 1 < steps.length && Buffer.byteLength(outcome.text, "utf8") > HANDOFF_MAX_BYTES) {
            aborted = true;
            blockedReason = "full-final-too-large-for-handoff";
            for (let rest = index + 1; rest < children.length; rest += 1) children[rest].state = "failed";
            break;
          }
          previous = outcome.text;
        }
        paint.flush();

        const report = outcomes
          .map((o) => {
            const label = `### step ${o.step}${o.agent ? ` (${o.agent})` : ""}`;
            if (o.operation?.reused) return `${label} — existing operation\n\n${o.text}`;
            return o.ok && o.control !== "failed"
              ? `${label} — completed\n\n${o.text || "(no output)"}`
              : `${label} — FAILED: ${o.reason}${o.text ? `\n\n${o.text}` : ""}`;
          })
          .join("\n\n---\n\n");

        const skipped = steps.length - outcomes.length;
        const tail = aborted
          ? `\n\n---\n\n**The chain stopped at step ${outcomes.length}.** ${skipped} later step(s) did not run, ` +
            (blockedReason
              ? `because the complete final exceeds the ${HANDOFF_MAX_BYTES}-byte handoff limit; it is preserved above and no partial handoff was used.`
              : `because the previous step did not supply a qualified successful final for the next task.`)
          : "";

        if (
          outcomes.length === 1 &&
          !outcomes[0].ok &&
          !outcomes[0].work &&
          !outcomes[0].final &&
          !outcomes[0].cleanup
        ) {
          const message = `chain failed at its first step.\n\n${report}`;
          if (outcomes[0].refusal) throw new GovernanceRefusal({ ...outcomes[0].refusal, message });
          throw new Error(message);
        }
        return capture.finish(
          {
            isError: (aborted && !outcomes.at(-1)?.operation?.reused) || outcomes.some((o) => o.control === "failed"),
            content: [
              { type: "text", text: `${report}${tail}` },
              executionEvidenceContent("delegate_chain", outcomes, steps.length),
            ],
            details: {
              outcomes,
              steps: steps.length,
              completed: outcomes.filter((o) => o.ok).length,
              aborted,
              budgetPerStep: firstReservation.childAllowance,
              ...(blockedReason ? { blockedReason } : {}),
              refusals: outcomes.map((outcome) => outcome.refusal ?? null),
            },
          },
          outcomes,
        );
      } finally {
        firstReservation.finalize({ state: "not-started", reason: "chain ended before its first execution" });
        await firstClaim?.finish?.("not-started").catch(() => undefined);
      }
    },
  });
}
