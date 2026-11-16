/** Read-only handshake with the exact immutable definition dispatched by this extension instance. */
import { publicEvidenceCall } from "./public-evidence.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { digestDefinition } from "../src/kernel/definitions.ts";
import { maySpawnDefinition } from "../src/kernel/delegate.ts";
import type { GrantsSession } from "./session.ts";
import { assertDelegationAuthority } from "./delegation-authority.ts";

export const definitionIdDescription =
  "Exact definitionId from delegate_describe.delegationArguments. Copy its agent together with this ID; " +
  "the ID alone does not select an agent. Required for Principal phases.";

class DefinitionInputError extends Error {}

export function assertDefinitionIdentity(
  session: GrantsSession,
  spec: { agent?: string; definitionId?: string },
): void {
  const definition = spec.agent ? session.definitions.get(spec.agent) : undefined;
  if (spec.definitionId !== undefined) {
    if (!spec.agent)
      throw new DefinitionInputError(
        "Missing delegation agent: definitionId does not select an agent. Copy BOTH agent and definitionId " +
          "from delegate_describe.delegationArguments, then add the task. No definition was selected.",
      );
    if (!definition)
      throw new DefinitionInputError(
        `Delegation agent ${JSON.stringify(spec.agent)} is not in the current selected definitions. ` +
          "Use the exact agent name returned by delegate_describe; refreshing an ID cannot correct a wrong agent name.",
      );
    if (definition.definitionId !== spec.definitionId)
      throw new DefinitionInputError(
        `Definition snapshot changed or is unavailable for agent ${JSON.stringify(spec.agent)}: ` +
          "the supplied definitionId does not match its current selection. " +
          "Call delegate_describe for that agent and copy BOTH fields from delegationArguments; do not shorten or invent the ID.",
      );
  }
  if (definition?.binding && !spec.definitionId)
    throw new DefinitionInputError(
      `Principal delegation for agent ${JSON.stringify(spec.agent)} is missing definitionId. ` +
        "Call delegate_describe for that agent and copy BOTH fields from delegationArguments.",
    );
}

/** Call only before any operation admission; downstream identity rechecks cannot assert this boundary. */
export function assertDefinitionInputsBeforeAdmission(
  session: GrantsSession,
  specs: readonly { agent?: string; definitionId?: string }[],
): void {
  try {
    for (const spec of specs) assertDefinitionIdentity(session, spec);
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
    description:
      "Read the exact selected definition identity and Principal binding before delegation. " +
      "Copy delegationArguments (agent and definitionId) into delegate or a batch/chain entry, then add its task. " +
      "Starts no child and grants nothing.",
    parameters: Type.Object({ agent: Type.String() }),
    async execute(_id, params) {
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
        selectedResources: definition.selectedResources ?? null,
      };
      const capture = publicEvidenceCall(session.publicEvidence, _id, "delegate_describe", [{ agent: params.agent }]);
      capture.selected(0, definition);
      return capture.finish({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });
    },
  });
}
