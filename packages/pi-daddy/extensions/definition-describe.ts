/** Read-only handshake with the exact immutable definition dispatched by this extension instance. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { digestDefinition } from "../src/kernel/definitions.ts";
import { maySpawnDefinition } from "../src/kernel/delegate.ts";
import type { GrantsSession } from "./session.ts";
import { assertDelegationAuthority } from "./delegation-authority.ts";
export function assertDefinitionIdentity(
  session: GrantsSession,
  spec: { agent?: string; definitionId?: string },
): void {
  const definition = spec.agent ? session.definitions.get(spec.agent) : undefined;
  if (spec.definitionId !== undefined && (!definition || definition.definitionId !== spec.definitionId))
    throw Error("definition snapshot changed or is unavailable; call delegate_describe again");
  if (definition?.binding && !spec.definitionId)
    throw Error("Principal delegation requires delegate_describe definitionId");
}
export function registerDefinitionDescribe(pi: ExtensionAPI, session: GrantsSession): void {
  pi.registerTool({
    name: "delegate_describe",
    label: "Describe a governed definition",
    description:
      "Read the exact selected definition identity and Principal binding before delegation. Starts no child and grants nothing.",
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
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  });
}
