/** Read-only handshake with the exact immutable definition dispatched by this extension instance. */
import { publicEvidenceCall } from "./public-evidence.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ceilingForDefinition, digestDefinition } from "../src/kernel/definitions.ts";
import { definitionContextContract } from "../src/kernel/context-handoff.ts";
import { maySpawnDefinition } from "../src/kernel/delegate.ts";
import { replaySafeCeiling } from "../src/kernel/replay-safe.ts";
import { hostModel, liveParentTools } from "./parent-tool-host.ts";
import type { GrantsSession } from "./session.ts";
import type { ReloadLifecycle } from "./reload-environment.ts";
import { assertDelegationAuthority } from "./delegation-authority.ts";

export const definitionIdDescription =
  "Optional; omit it after delegate_describe, which binds the agent's current definitionId for this session " +
  "(required for Principal phases).";

class DefinitionInputError extends Error {}

/** Where a delegation's definitionId came from: its own arguments, or this session's last describe of the agent. */
export type DefinitionIdSource = "supplied" | "remembered";
/**
 * The definitionId a delegation was checked against, and its source. Returned in tool result details only: the
 * ledger schema stays compatible with independently released readers; richer evidence needs an optional contract.
 */
export interface DefinitionBinding {
  definitionId: string;
  source: DefinitionIdSource;
}

/**
 * Owner decision 2026-11-17: the harness carries the IDs. Each omitted definitionId is filled from this Pi
 * session's last successful describe of the same agent (kept on the reload lifecycle, see `ReloadLifecycle`).
 * A supplied ID wins and never enters that memory. Call once per tool call, before any check, so every
 * entry of one call is bound from one reading. The identity check that follows is the same either way.
 */
export function bindDescribedDefinitions<T extends { agent?: string; definitionId?: string }>(
  session: GrantsSession,
  specs: readonly T[],
): { specs: T[]; bindings: Array<DefinitionBinding | undefined> } {
  const described = session.reloadLifecycle?.describedDefinitions;
  const bindings = specs.map((spec): DefinitionBinding | undefined => {
    if (spec.definitionId !== undefined) return { definitionId: spec.definitionId, source: "supplied" };
    const remembered = spec.agent === undefined ? undefined : described?.get(spec.agent);
    return remembered === undefined ? undefined : { definitionId: remembered, source: "remembered" };
  });
  return {
    specs: specs.map((spec, index) => {
      const binding = bindings[index];
      return binding?.source === "remembered" ? { ...spec, definitionId: binding.definitionId } : spec;
    }),
    bindings,
  };
}

/** A new, resumed or forked session, or a move in the session tree, has not seen this session's describes. */
export function forgetDescribedDefinitions(lifecycle: ReloadLifecycle): void {
  delete lifecycle.describedDefinitions;
}

export function assertDefinitionIdentity(
  session: GrantsSession,
  spec: { agent?: string; definitionId?: string },
  source: DefinitionIdSource = "supplied",
): void {
  const definition = spec.agent ? session.definitions.get(spec.agent) : undefined;
  if (spec.definitionId !== undefined) {
    if (!spec.agent)
      throw new DefinitionInputError(
        "Missing delegation agent: definitionId does not select an agent. Name the agent. No definition was selected.",
      );
    if (!definition && source === "supplied")
      throw new DefinitionInputError(
        `Delegation agent ${JSON.stringify(spec.agent)} is not in the current selected definitions. ` +
          "Use the exact agent name returned by delegate_describe; refreshing an ID cannot correct a wrong agent name.",
      );
    if (definition?.definitionId !== spec.definitionId)
      throw new DefinitionInputError(
        `Definition snapshot changed or is unavailable for agent ${JSON.stringify(spec.agent)}: ` +
          (source === "remembered"
            ? "it changed since this session described it. Describe it again with delegate_describe."
            : "the supplied definitionId does not match its current selection. " +
              "Describe it again with delegate_describe and omit the ID."),
      );
  }
  if (definition?.binding && !spec.definitionId)
    throw new DefinitionInputError(
      `Principal delegation for agent ${JSON.stringify(spec.agent)} has no described definition. ` +
        "Describe it first with delegate_describe.",
    );
}

/** Call only before any operation admission; downstream identity rechecks cannot assert this boundary. */
export function assertDefinitionInputsBeforeAdmission(
  session: GrantsSession,
  specs: readonly { agent?: string; definitionId?: string }[],
  bindings: readonly (DefinitionBinding | undefined)[] = [],
): void {
  try {
    for (const [index, spec] of specs.entries()) assertDefinitionIdentity(session, spec, bindings[index]?.source);
  } catch (error) {
    if (!(error instanceof DefinitionInputError)) throw error;
    error.message +=
      " This call stopped before operation admission; it started no child. " +
      "This does not establish whether an earlier call used the same operation ID.";
    throw error;
  }
}

export function registerDefinitionDescribe(pi: ExtensionAPI, session: GrantsSession): void {
  pi.registerTool({
    name: "delegate_describe",
    label: "Describe a governed definition",
    exposure: "deferred" as const,
    defaultActive: false,
    description:
      "Read the exact selected definition identity, context ceiling/default and Principal binding before delegation. " +
      "Binds its definitionId to this agent's later delegations in this session. Starts no child and grants nothing.",
    parameters: Type.Object({ agent: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const lifecycle = session.reloadLifecycle;
      assertDelegationAuthority(session);
      await session.ensureDefinitions?.();
      if (!maySpawnDefinition(session.ownGrant, params.agent))
        throw Error("definition is outside this session's grant");
      const definition = session.definitions.get(params.agent);
      if (!definition?.definitionId)
        throw Error("selected definition is unavailable; reload after correcting discovery");
      const details = {
        version: 1,
        agent: params.agent,
        sourceHash: definition.sourceHash,
        bodySha256: digestDefinition(definition).sha256,
        binding: definition.binding ?? null,
        definitionId: definition.definitionId,
        delegationArguments: { agent: params.agent, definitionId: definition.definitionId },
        contextContract: definitionContextContract(ceilingForDefinition(definition).capabilities),
        selectedResources: definition.selectedResources ?? null,
        // Declared tools this session would run for the child itself, through its own tool pipeline (2026-11-17),
        // for a child on this session's own provider and model, which is the only kind it runs them for. Like the
        // rest of this answer, an observation: it grants nothing and admission still decides.
        parentRunTools: liveParentTools(session, ceilingForDefinition(definition).capabilities, ctx, hostModel(ctx)),
        // 2026-11-17: its declared tools only read, so a failure without an answer may be run once more (see
        // `replay-safe.ts` for when). Every admitted plan's tools are exactly these (context modes only read), so the
        // ceiling answers for the plan.
        replaySafe: replaySafeCeiling(ceilingForDefinition(definition)),
      };
      const capture = publicEvidenceCall(session.publicEvidence, _id, "delegate_describe", [{ agent: params.agent }]);
      capture.selected(0, definition);
      const result = capture.finish({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });
      // Only an answer actually returned binds; the lifecycle read at entry, so a replaced owner never receives it.
      if (lifecycle) (lifecycle.describedDefinitions ??= new Map()).set(params.agent, definition.definitionId);
      return result;
    },
  });
}
