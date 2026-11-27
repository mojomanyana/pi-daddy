import { dashboardSummaryDescription } from "../src/products/activity-summary.ts";
import { operationIdShape, claimDelegationOperation } from "./delegation-operations.ts";
import { publicEvidenceCall } from "./public-evidence.ts";
import { executionEvidenceContent } from "./execution-evidence.ts";
import { delegationUsage } from "../src/executors/child-usage.ts";
import { childUsageReport } from "./child-usage-report.ts";
import { reconcileDelegationCapacity, reserveDelegationCapacity } from "./session-capacity.ts";
import {
  assertDefinitionInputsBeforeAdmission,
  bindDescribedDefinitions,
  definitionIdDescription,
  registerDefinitionDescribe,
} from "./definition-describe.ts";
/**
 * Governed delegation, as pi sees it: the `delegate` and `delegate_all` tool registrations.
 *
 * Unlike the tripwire in `grants.ts` this PROVISIONS — the grant is an argument, so the orchestrator hands
 * each child exactly the capabilities it should have. Both tools are registered only when this session may
 * delegate, so withholding `tool:delegate` genuinely makes a session a leaf (S-5).
 *
 * What a delegation actually DOES lives in `./run-delegation.ts`; this file is the pi-facing surface —
 * schemas, descriptions, and turning an outcome into the throw-or-return contract pi expects.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { maySpawnDefinition } from "../src/kernel/delegate.ts";
import { ceilingForDefinition } from "../src/kernel/definitions.ts";
import { childToolDeliveryRefusal, type ChildToolSource } from "../src/kernel/child-tools.ts";
import { CROSS_MODEL_PROXIED_TOOLS } from "../src/kernel/parent-tools.ts";
import { MAX_CHILDREN_PER_CALL, splitBudget } from "../src/kernel/fanout.ts";
import {
  PAINT_INTERVAL_MS,
  appendTail,
  emptyTail,
  renderProgress,
  replaceTail,
  throttle,
  type ChildProgress,
} from "../src/kernel/progress.ts";
import { registerChainTool } from "./delegate-chain.ts";
import { GovernanceRefusal, refusal } from "../src/kernel/refusals.ts";
import { runOneDelegation } from "./run-delegation.ts";
import {
  buildFanoutReport,
  childFailureOutcome,
  throwFanoutInfrastructure,
  totalFanoutFailure,
} from "./fanout-outcome.ts";
import { isCriticalAssuranceBlock, type DelegationOutcome } from "./execute-child.ts";
import { type GrantsSession } from "./session.ts";
import { newDelegationOccurrence } from "./execution-occurrence.ts";
import { correlationShape as buildCorrelationShape } from "./correlation-shape.ts";
import { assertDelegationAuthority } from "./delegation-authority.ts";
import { contextShape } from "./context-shape.ts";

/**
 * Wire a set of children to pi's partial-result channel — ADR-0032.
 *
 * **One block for the whole call**, not one per child: `onUpdate` replaces the tool's rendered result, so N
 * independent painters would each overwrite the others and the operator would see one child flickering.
 * `delegate` is simply the one-child case of the same thing, which is why both tools come through here.
 *
 * Painting is throttled, and the trailing frame matters more than the throttling: without it the final paint —
 * the one showing every child settled — is the one most likely to be dropped, so the block would freeze
 * mid-run. `flush()` at the end is what guarantees the last state is the one left on screen.
 *
 * **Nothing here is the result.** The tool's content still comes from each child's returned text.
 */
function progressReporter(
  session: GrantsSession,
  labels: string[],
  onUpdate: ((partial: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
) {
  const started = Date.now();
  const children: ChildProgress[] = labels.map((label) => ({
    label,
    state: "starting",
    startedAt: started,
    tail: emptyTail,
  }));

  const paint = throttle(() => {
    try {
      onUpdate?.({
        content: [{ type: "text", text: renderProgress(children, session.executor.kind, Date.now()) }],
      });
    } catch {
      // Display only. In particular, this callback can run inside runChild's security-sensitive onSpawn;
      // letting it escape makes runChild kill an otherwise healthy governed child.
    }
  }, PAINT_INTERVAL_MS);

  return {
    /** One sink per child index, shaped for `runOneDelegation`'s `onProgress`. */
    sink:
      (index: number) =>
      (update: {
        chunk?: string;
        snapshot?: string[];
        paneId?: string;
        agentName?: string;
        state?: ChildProgress["state"];
      }) => {
        const child = children[index];
        if (!child) return;
        if (update.paneId) child.paneId = update.paneId;
        // **Reported, not derived.** When an executor mints an agent name, it travels from there rather than
        // being reconstructed from label + child id.
        if (update.agentName) child.agentName = update.agentName;
        // Two shapes, deliberately distinct: a byte stream APPENDS chunks, while a terminal snapshot REPLACES
        // the tail. Keeping them distinct prevents snapshot amplification.
        if (update.chunk) child.tail = appendTail(child.tail, update.chunk);
        if (update.snapshot) child.tail = replaceTail(update.snapshot);
        if (update.state) child.state = update.state;
        else if (child.state === "starting") child.state = "running";
        paint.call();
      },
    /** Record how each child ended and leave the final frame on screen. */
    settle: (outcomes: Array<{ ok: boolean }>) => {
      const at = Date.now();
      outcomes.forEach((outcome, index) => {
        const child = children[index];
        if (!child) return;
        child.state = outcome.ok ? "completed" : "failed";
        child.settledAt = at;
      });
      paint.flush();
    },
  };
}

export interface DelegationRegistration {
  /**
   * Re-derive "which definitions may this session spawn?" into the registered tool schemas.
   *
   * Must be called once the session knows the answer — `session_start` loads the definitions, and the first
   * provider request tightens `ownGrant`. Both change the list, and neither has happened when the tools are
   * registered. See R-39: without this the answer is permanently `none`. Each call also re-reads the child-tool
   * inventory, which lacks Daddy's own tools until they are registered.
   */
  refreshSpawnable: () => void;
}

/**
 * Register delegation definitions at owner-bound session_start.
 *
 * Pi exposes factory registrations before `bindExtensions()`, so this timing keeps the pre-start surface
 * empty. Owner reconciliation precedes registration and activation, so a holder without `tool:delegate`
 * remains a leaf at every dispatch boundary.
 */
export function registerDelegationTools(pi: ExtensionAPI, session: GrantsSession): DelegationRegistration {
  /**
   * Definitions this session is actually authorised to spawn (ADR-0017) and whose declared tools a governed
   * child can load, for the tool description.
   *
   * Listing all of them would tell the model it can spawn things every attempt at which is refused — the
   * R-28 shape again, a description disagreeing with the enforcer. Computed from the same
   * `maySpawnDefinition` the planner uses, and from the same `childToolDeliveryRefusal` over the inputs
   * `session.delegationContext` hands it: the tool inventory, the extension path, and the parent-run facts
   * (depth, owner channel and the inventory preview of tools this root can run for a child). The planner's
   * per-call `context:` handling adds and removes no tool name, so the declared ceiling alone decides delivery.
   * One parent-run condition is per delegation: the child's model must be the root's own. The preview leaves
   * it to dispatch (`rootModel: "preview"`), so a definition is listed when a delegation that keeps this
   * session's model would be admitted, and a delegation on another model is refused with the reason.
   *
   * Both filters only remove names. This runs inside `session_start`, `ensureDefinitions` and the
   * provider-request hook, so the delivery filter must not throw: Pi's `getAllTools` asserts a bound, live
   * runtime, and an unreadable inventory falls back to the planner's own unobserved rule (native tools,
   * nothing external). A ceiling that cannot be read is not offered. The planner re-reads the inventory at
   * dispatch and remains the enforcer.
   */
  const spawnable = () => {
    let childToolSources: readonly ChildToolSource[] | undefined;
    try {
      childToolSources = session.childToolSources?.();
    } catch {
      // Left unobserved, as for a caller that supplies no inventory.
    }
    let parentRun: ReturnType<NonNullable<GrantsSession["parentToolContext"]>> | undefined;
    try {
      parentRun = session.parentToolContext?.();
    } catch {
      // None offered: the planner's preview reads the same inventory and fails the same way.
    }
    const delivery = {
      childToolSources,
      extensionPath: session.extensionPath,
      depth: session.depth,
      autoModeRef: session.autoMode?.reference,
      ...parentRun,
    };
    const offeredProxyNames = new Set((parentRun?.parentTools ?? []).map((t) => t.name));
    const deliverable = (definition: Parameters<typeof ceilingForDefinition>[0]) => {
      try {
        const ceiling = ceilingForDefinition(definition);
        if (ceiling.undeclared) return false;
        const hasCore = ceiling.capabilities.some(
          (c) => !c.startsWith("tool:") || !CROSS_MODEL_PROXIED_TOOLS.has(c.slice(5)),
        );
        const caps = hasCore
          ? ceiling.capabilities.filter(
              (c) =>
                !c.startsWith("tool:") ||
                !CROSS_MODEL_PROXIED_TOOLS.has(c.slice(5)) ||
                offeredProxyNames.has(c.slice(5)),
            )
          : ceiling.capabilities;
        return !childToolDeliveryRefusal(caps, delivery);
      } catch {
        return false; // An unreadable ceiling is not offered; dispatch fails on the same read.
      }
    };
    return [...session.definitions]
      .filter(([name, definition]) => maySpawnDefinition(session.ownGrant, name) && deliverable(definition))
      .map(([name]) => name)
      .sort();
  };

  /**
   * **R-39.** This used to be computed once, right here, and it was always `[]`.
   *
   * `registerDelegationTools` runs at `session_start`, before that hook loads definitions. So every model
   * in every governed session was told `Available: none.` and did the reasonable thing: it used
   * `delegate({tools})`, the path with no operator-authored instructions, no `agent:` prerequisite, no body
   * digest on the record, and no `always` approval available. **ADR-0017 and ADR-0019 bought expressiveness
   * the model was structurally prevented from using**, and every dialog was a `<delegate>` dialog again.
   *
   * The comment this replaces reasoned carefully about grant staleness and never noticed the map was empty.
   *
   * The repair rests on a measured fact: **pi serialises a tool's schema at request time, not at
   * registration**, so mutating the description after the definitions load reaches the provider. Verified
   * directly — a probe that rewrote a parameter description in `session_start` saw the new text arrive in
   * `before_provider_request`'s payload.
   */
  const describeAgent = (names: string[]) =>
    `Name of a definition to spawn — its allowed-tools become the grant and its instructions ` +
    `become the sub-agent's system prompt. delegate_describe binds its definitionId. ` +
    `Available: ${names.join(", ") || "none"}.`;

  const correlationShape = buildCorrelationShape();
  const workspaceShape = Type.Object({
    // `minLength: 1` because an empty id is not a "no workspace" signal — it is a malformed one, and the
    // planner now says so. Refused at the schema as well as in the planner: a model-facing parameter that
    // reaches a capability id should be bounded at both ends.
    workspace_id: Type.String({
      minLength: 1,
      description: "ID from the operator-owned workspace registry. Routing here needs workspace:<id> in the grant.",
    }),
    access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
  });

  const thinkingShape = Type.Optional(
    Type.Union(
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)),
      { description: "Requested Pi thinking level; unsupported model/level combinations fail in the child." },
    ),
  );
  const childShape = Type.Object({
    operation_id: operationIdShape(),
    definitionId: Type.Optional(Type.String({ description: definitionIdDescription })),
    dashboardSummary: Type.Optional(Type.String({ maxLength: 160, description: dashboardSummaryDescription })),
    task: Type.String({ description: "The task for this sub-agent. It receives only this." }),
    agent: Type.Optional(Type.String({ description: describeAgent(spawnable()) })),
    tools: Type.Optional(Type.Array(Type.String(), { description: "Capabilities, when no 'agent' fits." })),
    model: Type.Optional(Type.String({ description: "Model as provider/id. Defaults to this session's." })),
    thinking: thinkingShape,
    context: Type.Optional(contextShape()),
    attachedBriefs: Type.Optional(
      Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" }), {
        maxItems: 8,
        description: "Optional Scout brief SHA-256 hashes attached to this specialist assignment.",
      }),
    ),
    correlation: Type.Optional(correlationShape),
    workspace: Type.Optional(workspaceShape),
  });

  const delegateAllParams = Type.Object({
    children: Type.Array(childShape, {
      minItems: 1,
      maxItems: MAX_CHILDREN_PER_CALL,
      description: "The sub-agents to run concurrently. Each is independent and unaware of the others.",
    }),
  });

  const delegateParams = Type.Object({
    operation_id: operationIdShape(),
    definitionId: Type.Optional(Type.String({ description: definitionIdDescription })),
    dashboardSummary: Type.Optional(Type.String({ maxLength: 160, description: dashboardSummaryDescription })),
    task: Type.String({ description: "The task for the sub-agent. It receives only this." }),
    agent: Type.Optional(Type.String({ description: describeAgent(spawnable()) })),
    tools: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Capabilities to grant when no \'agent\' is named, e.g. ["read","grep"] or ' +
          '["tool:read","ext:pkg/tool"]. Empty means no tools. Ignored when \'agent\' is given.',
      }),
    ),
    model: Type.Optional(
      Type.String({
        // A bare id resolves across all known providers and can land on one there is no key for, so the
        // form is named rather than implied — see the "Verified live" defect in the README.
        description:
          'Model for the sub-agent as provider/id, e.g. "openai-codex/gpt-5.6-sol". ' +
          "Defaults to this session's model, already provider-qualified.",
      }),
    ),
    thinking: thinkingShape,
    context: Type.Optional(contextShape()),
    attachedBriefs: Type.Optional(
      Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" }), {
        maxItems: 8,
        description: "Optional Scout brief SHA-256 hashes attached to this specialist assignment.",
      }),
    ),
    correlation: Type.Optional(correlationShape),
    workspace: Type.Optional(workspaceShape),
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate (governed)",
    description:
      "Delegate a task to a sub-agent holding ONLY the capabilities you grant it. You cannot grant what " +
      "you do not hold. Prefer 'agent' — it spawns a definition whose capabilities and instructions were " +
      "written by the operator. Use 'tools' only when no definition fits. Grant 'delegate' if the " +
      "sub-agent must itself delegate further; withhold it to make the sub-agent a leaf.",
    parameters: delegateParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Reported through Pi's tool_result hook if this call throws after its child ran (2026-11-17).
      const taskAdmission = session.taskDispatch?.capture();
      const taskObservation = session.bindTaskObservation?.() ?? null;
      const usageReport = childUsageReport(session, _toolCallId);
      assertDelegationAuthority(session);
      await session.ensureDefinitions?.();
      // The call's own definitionId, else this session's last describe of the agent; checked the same way.
      const bound = bindDescribedDefinitions(session, [params]);
      const [spec] = bound.specs;
      const [definitionBinding] = bound.bindings;
      assertDefinitionInputsBeforeAdmission(session, bound.specs, bound.bindings);
      // ADR-0032: one child, same block. `_onUpdate` was discarded here, so a delegation showed the bare word
      // `delegate` for up to DEFAULT_TIMEOUT_MS — sixty minutes by default.
      const progress = progressReporter(session, [params.agent ?? "delegate"], onUpdate as never);
      const occurrence = newDelegationOccurrence(session, 0);
      const operationClaim = await claimDelegationOperation(
        session,
        spec,
        occurrence,
        ctx,
        signal,
        definitionBinding,
        taskObservation,
      );
      // Public capture keeps the caller's own request; the bound ID is in details.
      const capture = publicEvidenceCall(
        session.publicEvidence,
        _toolCallId,
        "delegate",
        [params],
        [operationClaim?.operation.executionId ?? occurrence.executionId],
      );
      const running = runOneDelegation(
        session,
        {
          operation_id: params.operation_id,
          definitionId: spec.definitionId,
          task: params.task,
          dashboardSummary: params.dashboardSummary,
          agent: params.agent,
          tools: params.tools,
          model: params.model,
          thinking: params.thinking,
          context:
            params.context?.mode === "files" && (!params.context.files || params.context.files.length === 0)
              ? { mode: "none" as const }
              : params.context,
          attachedBriefs: params.attachedBriefs,
          correlation: params.correlation,
          workspace: params.workspace,
        },
        occurrence,
        // Reserve one actual child plus the currently available disjoint subtree allowance.
        undefined,
        ctx,
        signal,
        {
          taskObservation,
          taskAdmission,
          operationClaim,
          definitionBinding,
          onProgress: progress.sink(0),
          toolCallId: _toolCallId,
          onDefinition: (definition) => capture.selected(0, definition),
        },
      );
      const outcome = await usageReport.settle(running);
      progress.settle([outcome]);

      if (isCriticalAssuranceBlock(outcome)) throw new Error(outcome.text);
      // A pre-launch refusal has no executed work/final to preserve; keep its established typed refusal.
      if (!outcome.ok && !outcome.work && !outcome.final && !outcome.cleanup) {
        const message = `delegation refused: ${outcome.reason}`;
        if (outcome.refusal) throw new GovernanceRefusal({ ...outcome.refusal, message });
        throw new Error(message);
      }
      // Pi 1.0.4 preserves returned isError. Keep every outcome dimension and useful output together.
      const failed = !outcome.operation?.reused && (!outcome.ok || outcome.control === "failed");
      // Pi adds `usage` to this session's totals; `details.childUsage` says what it covers (2026-11-17).
      const { usage, childUsage } = delegationUsage([outcome]);
      return capture.finish(
        {
          ...(usage ? { usage } : {}),
          isError: failed,
          content: [
            {
              type: "text",
              text: failed
                ? `delegation failed: ${outcome.reason ?? "required control failed"}${outcome.text ? `\n\n${outcome.text}` : ""}`
                : outcome.text || "(no output)",
            },
            executionEvidenceContent("delegate", [outcome], 1),
          ],
          details: { ...outcome, childUsage },
        },
        [outcome],
      );
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
    defaultActive: false,
    description:
      "Run several sub-agents CONCURRENTLY and return all their results. Each child is governed exactly " +
      "as with `delegate`: it holds only what you grant it, and you cannot grant what you do not hold. " +
      `At most ${MAX_CHILDREN_PER_CALL} children per call, and shared capacity bounds active descendants ` +
      "across the whole delegation subtree. Children cannot see each other or share context. Use this " +
      "when independent tasks can proceed in parallel — several reviewers over one diff, say — and read " +
      "every child's outcome, because one can be refused while the others succeed.",
    parameters: delegateAllParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const taskAdmission = session.taskDispatch?.capture();
      const taskObservation = session.bindTaskObservation?.() ?? null;
      const usageReport = childUsageReport(session, _toolCallId);
      assertDelegationAuthority(session);
      const children = params.children ?? [];
      // Correctable definition inputs must not consume earlier siblings' operation IDs.
      await session.ensureDefinitions?.();
      const bound = bindDescribedDefinitions(session, children);
      assertDefinitionInputsBeforeAdmission(session, bound.specs, bound.bindings);
      if (session.capacityRefusal) throw new GovernanceRefusal(session.capacityRefusal);
      await reconcileDelegationCapacity(session);
      const occurrences = children.map((_, index) => newDelegationOccurrence(session, index));
      const claims: Array<import("../src/kernel/dispatch-operation.ts").OperationClaim | undefined> = [];
      try {
        for (const [index, child] of bound.specs.entries())
          claims.push(
            await claimDelegationOperation(
              session,
              child,
              occurrences[index],
              ctx,
              signal,
              bound.bindings[index],
              taskObservation,
            ),
          );
      } catch (error) {
        await Promise.all(claims.map((claim) => claim?.finish?.("not-started")));
        throw error;
      }
      const fresh = children.filter((_, index) => !claims[index]?.reused).length;
      const split = fresh === 0 ? { ok: true as const, perChild: 0 } : splitBudget(session.capacity.available, fresh);
      if (!split.ok) {
        await Promise.all(claims.map((claim) => claim?.finish?.("not-started")));
        // Thrown, not returned: a returned `isError` is discarded by pi, so a refusal that came back as a
        // normal result would read to the orchestrator as a successful fan-out of zero children.
        throw new GovernanceRefusal(refusal("FANOUT_EXCEEDED", `fan-out refused: ${split.reason}`));
      }

      // ADR-0032: ONE status block covering every child. `onUpdate` replaces the tool's rendered result, so a
      // painter per child would have each overwriting the others.
      const progress = progressReporter(
        session,
        children.map((c) => c.agent ?? "delegate"),
        onUpdate as never,
      );

      // Concurrent by construction. Each child gets its own budget share and its own ledger id, so the
      // records form a tree and two siblings can never be confused for one another.
      // EVERY sibling's error, not just the first. `??=` discarded the rest with no log anywhere, which could
      // drop a lease-retention notice rather than reporting all infrastructure failures (R-116).
      const infrastructureErrors: unknown[] = [];
      const capture = publicEvidenceCall(
        session.publicEvidence,
        _toolCallId,
        "delegate_all",
        children,
        occurrences.map((row, index) => claims[index]?.operation.executionId ?? row.executionId),
      );
      const pending = bound.specs.map(async (child, index): Promise<DelegationOutcome> => {
        let enteredDelegation = false;
        try {
          // Reserve each batch share synchronously here, before another dispatch can interleave.
          const capacityReservation = claims[index]?.reused
            ? undefined
            : reserveDelegationCapacity(session, occurrences[index].executionId, split.perChild);
          enteredDelegation = true;
          return await runOneDelegation(session, child, occurrences[index], split.perChild, ctx, signal, {
            taskObservation,
            taskAdmission,
            operationClaim: claims[index],
            definitionBinding: bound.bindings[index],
            capacityReservation,
            onDefinition: (definition) => capture.selected(index, definition),
            onProgress: progress.sink(index),
            toolCallId: _toolCallId,
          });
        } catch (error) {
          if (!enteredDelegation)
            await claims[index]?.finish?.("not-started", { cleanup: { state: "not-started" } }).catch(() => undefined);
          infrastructureErrors.push(error);
          return childFailureOutcome(error, session.depth + 1);
        }
      });
      const outcomes = await Promise.all(pending);
      // Both throws below follow children that ran: a vetoed child's siblings, or every child failed after running.
      usageReport.add(...outcomes);
      progress.settle(outcomes);
      // The upstream controller's verdict outranks our own infrastructure noise — it is the answer the
      // caller is waiting for, and ADR-0034 requires it to pass through unchanged. But an infrastructure
      // failure must not VANISH behind it, which is what happened when a retained-lease error and a
      // critical block landed in the same fan-out (R-117).
      throwFanoutInfrastructure(outcomes, infrastructureErrors);

      const failed = outcomes.filter((o) => !o.ok && !o.operation?.reused);
      // Every child is reported, including the ones that failed. R-03's rule: a missing result must never
      // be indistinguishable from an empty one, and a fan-out that hid its refusals would let an
      // orchestrator summarise four reviews when only three happened.
      const report = buildFanoutReport(outcomes, children);
      if (failed.length === children.length && outcomes.every((o) => !o.work && !o.final && !o.cleanup))
        throw totalFanoutFailure(failed, `fan-out failed: every child was refused or failed.\n\n${report}`);

      const { usage, childUsage } = delegationUsage(outcomes);
      return capture.finish(
        {
          ...(usage ? { usage } : {}),
          isError: outcomes.some((o) => !o.operation?.reused && (!o.ok || o.control === "failed")),
          content: [
            { type: "text", text: report },
            executionEvidenceContent("delegate_all", outcomes, children.length),
          ],
          details: {
            outcomes,
            children: outcomes.length,
            failed: failed.length,
            budgetPerChild: split.perChild,
            granted: outcomes.map((o) => o.granted),
            refusals: outcomes.map((o) => o.refusal ?? null),
            retention: outcomes.map((o) => o.retention ?? null),
            childUsage,
          },
        },
        outcomes,
      );
    },
  });

  // ADR-0033. Registered here so all three tools appear together and share the `mayDelegate` guard, but its logic
  // lives in its own file: `delegate` and `delegate_all` differ only in cardinality, while a chain differs in
  // composition, and this file is near the 400-line ceiling.
  registerDefinitionDescribe(pi, session);
  registerChainTool(pi, session);

  return {
    // Written through the CONSTRUCTED schema (`properties.agent`) rather than the object handed to
    // `Type.Optional`, because `Optional` shallow-copies — mutating the input would update a discarded
    // clone. Both tools are refreshed from one place so they cannot disagree about what is spawnable.
    refreshSpawnable: () => {
      const names = spawnable();
      const description = describeAgent(names);
      (delegateParams.properties.agent as { description?: string }).description = description;
      (childShape.properties.agent as { description?: string }).description = description;
    },
  };
}
