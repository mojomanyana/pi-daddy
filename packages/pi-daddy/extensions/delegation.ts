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
import { maySpawnDefinition } from "../src/delegate.ts";
import { MAX_CHILDREN_PER_CALL, splitBudget } from "../src/fanout.ts";
import {
  PAINT_INTERVAL_MS, appendTail, emptyTail, renderProgress, replaceTail, throttle, type ChildProgress,
} from "../src/progress.ts";
import { registerChainTool } from "./delegate-chain.ts";
import { GovernanceRefusal, refusal } from "../src/refusals.ts";
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
    sink: (index: number) => (update: {
      chunk?: string;
      snapshot?: string[];
      paneId?: string;
      agentName?: string;
      state?: ChildProgress["state"];
    }) => {
      const child = children[index];
      if (!child) return;
      if (update.paneId) child.paneId = update.paneId;
      // **Reported, not derived.** It used to be rebuilt here from the label and the child id, which was true
      // until `runHerdrPane` began uniquifying the name to stop herdr's `agent_name_taken` — after which the
      // block named an agent that did not exist, and an operator following it would find nothing. The name is
      // known only where it is minted, so it travels from there.
      if (update.agentName) child.agentName = update.agentName;
      // Two shapes, deliberately distinct, because the two executors are: a subprocess APPENDS bytes, a pane
      // reports a SNAPSHOT that replaces. Collapsing them into one "output" field is what caused the herdr
      // path's amplification, so the difference is spelled out in the type rather than remembered.
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
   * registered. See R-39: without this the answer is permanently `none`.
   */
  refreshSpawnable: () => void;
}


/**
 * Register `delegate` and `delegate_all` — but only if this session may delegate.
 *
 * The conditional is the whole of S-5: an unconditionally-registered `delegate` appears in every child's
 * ceiling, so a delegator without it was told every single agent type "requires tool:delegate".
 */
export function registerDelegationTools(pi: ExtensionAPI, session: GrantsSession): DelegationRegistration {
  if (!session.mayDelegate) return { refreshSpawnable: () => {} };

  /**
   * Definitions this session is actually authorised to spawn (ADR-0017), for the tool description.
   *
   * Listing all of them would tell the model it can spawn things every attempt at which is refused — the
   * R-28 shape again, a description disagreeing with the enforcer. Computed from the same
   * `maySpawnDefinition` the planner uses.
   */
  const spawnable = () =>
    [...session.definitions.keys()].filter((name) => maySpawnDefinition(session.ownGrant, name)).sort();

  /**
   * **R-39.** This used to be computed once, right here, and it was always `[]`.
   *
   * `registerDelegationTools` is called synchronously from the extension factory, while
   * `session.definitions` is only populated in the `session_start` hook — which fires afterwards. So every
   * model in every governed session was told `Available: none.` and did the reasonable thing: it used
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
    `become the sub-agent's system prompt. Available: ${names.join(", ") || "none"}.`;

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

  const childShape = Type.Object({
    task: Type.String({ description: "The task for this sub-agent. It receives only this." }),
    agent: Type.Optional(Type.String({ description: describeAgent(spawnable()) })),
    tools: Type.Optional(Type.Array(Type.String(), { description: "Capabilities, when no 'agent' fits." })),
    model: Type.Optional(Type.String({ description: "Model as provider/id. Defaults to this session's." })),
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
      task: Type.String({ description: "The task for the sub-agent. It receives only this." }),
      agent: Type.Optional(Type.String({ description: describeAgent(spawnable()) })),
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
      // ADR-0032: one child, same block. `_onUpdate` was discarded here, so a delegation showed the bare word
      // `delegate` for up to DEFAULT_TIMEOUT_MS — twenty minutes by default.
      const progress = progressReporter(session, [params.agent ?? "delegate"], onUpdate as never);
      const outcome = await runOneDelegation(
        session,
        {
          task: params.task,
          agent: params.agent,
          tools: params.tools,
          model: params.model,
          correlation: params.correlation,
          workspace: params.workspace,
        },
        newDelegationOccurrence(session, 0),
        // A single blocking delegation spends nothing from the subtree budget: cardinality is already
        // bounded to one by the call being blocking, which is the accident fan-out removes. Passing the
        // budget through unchanged means a child can still fan out with what this session was given.
        session.fanoutBudget,
        ctx,
        signal,
        { onProgress: progress.sink(0) },
      );
      progress.settle([outcome]);

      if (!outcome.ok) {
        if (isCriticalAssuranceBlock(outcome)) throw new Error(outcome.text);
        // THROW, do not return. `AgentToolResult` has no `isError` field: pi sets it only when `execute`
        // throws (`pi-agent-core/dist/agent-loop.js` — a normal return is hardcoded `isError: false`).
        // Returning `isError: true` was silently discarded, so every refusal this package made was
        // recorded by pi as a SUCCESSFUL tool call. Found by the integration suite on its first run.
        const detail = outcome.text ? `\n\n${outcome.text}` : "";
        const message = `delegation refused: ${outcome.reason}${detail}`;
        if (outcome.refusal) throw new GovernanceRefusal({ ...outcome.refusal, message });
        throw new Error(message);
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
    parameters: delegateAllParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const children = params.children ?? [];
      const split = splitBudget(session.fanoutBudget, children.length);
      if (!split.ok) {
        // Thrown, not returned: a returned `isError` is discarded by pi, so a refusal that came back as a
        // normal result would read to the orchestrator as a successful fan-out of zero children.
        throw new GovernanceRefusal(refusal("FANOUT_EXCEEDED", `fan-out refused: ${split.reason}`));
      }

      // ADR-0032: ONE status block covering every child. `onUpdate` replaces the tool's rendered result, so a
      // painter per child would have each overwriting the others.
      const progress = progressReporter(session, children.map((c) => c.agent ?? "delegate"), onUpdate as never);

      // Concurrent by construction. Each child gets its own budget share and its own ledger id, so the
      // records form a tree and two siblings can never be confused for one another.
      // EVERY sibling's error, not just the first. `??=` discarded the rest with no log anywhere, and one
      // of the discardable ones is `HerdrWriterCloseError`, whose entire meaning is "a pane may still be
      // live and its writer lease is deliberately retained" — a resource-retention notice, not a per-child
      // failure. Losing it meant nobody was told a lease is held with no owner until the process exits
      // (R-116).
      const infrastructureErrors: unknown[] = [];
      const outcomes = await Promise.all(
        children.map(async (child, index): Promise<DelegationOutcome> => {
          try {
            return await runOneDelegation(
              session, child,
              newDelegationOccurrence(session, index),
              split.perChild, ctx, signal, { onProgress: progress.sink(index) },
            );
          } catch (error) {
            infrastructureErrors.push(error);
            return childFailureOutcome(error, session.depth + 1);
          }
        }),
      );
      progress.settle(outcomes);
      // The upstream controller's verdict outranks our own infrastructure noise — it is the answer the
      // caller is waiting for, and ADR-0034 requires it to pass through unchanged. But an infrastructure
      // failure must not VANISH behind it, which is what happened when a retained-lease error and a
      // critical block landed in the same fan-out (R-117).
      throwFanoutInfrastructure(outcomes, infrastructureErrors);

      const failed = outcomes.filter((o) => !o.ok);
      // Every child is reported, including the ones that failed. R-03's rule: a missing result must never
      // be indistinguishable from an empty one, and a fan-out that hid its refusals would let an
      // orchestrator summarise four reviews when only three happened.
      const report = buildFanoutReport(outcomes, children);

      if (failed.length === children.length) {
        // All of them failed, so there is no partial result to hand back — and a tool that returns text
        // when nothing ran is exactly how a wrong summary gets written.
        const message = `fan-out failed: every child was refused or failed.\n\n${report}`;
        throw totalFanoutFailure(failed, message);
      }

      return {
        content: [{ type: "text", text: report }],
        details: {
          children: outcomes.length,
          failed: failed.length,
          budgetPerChild: split.perChild,
          granted: outcomes.map((o) => o.granted),
          refusals: outcomes.map((o) => o.refusal ?? null),
        },
      };
    },
  });

  // ADR-0033. Registered here so all three tools appear together and share the `mayDelegate` guard, but its logic
  // lives in its own file: `delegate` and `delegate_all` differ only in cardinality, while a chain differs in
  // composition, and this file is near the 400-line ceiling.
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
