/** Composition-only bridge. Snapshot definitions when dispatch actually selects them, never reread paths. */
import {
  capturePublicEvidence,
  type PublicEvidenceOwner,
  type PublicEvidenceRequest,
  type PublicDefinitionEvidence,
} from "../src/products/public-evidence.ts";
import { digestDefinition, type SkillDefinition } from "../src/kernel/definitions.ts";
import { executionEvidence } from "./execution-evidence.ts";
import type { DelegationOutcome } from "./execute-child.ts";
type Tool = "delegate_describe" | "delegate" | "delegate_all" | "delegate_chain";
interface Result {
  isError?: boolean;
  content: { type: "text"; text: string }[];
  details?: unknown;
}
export function publicEvidenceCall(
  owner: PublicEvidenceOwner | undefined,
  toolCallId: string,
  tool: Tool,
  specs: readonly { agent?: string; definitionId?: string }[],
  executionIds: readonly string[] = [],
) {
  const requested: PublicEvidenceRequest[] = specs.map((spec, index) => ({
    ordinal: index + 1,
    agent: spec.agent ?? null,
    requestedDefinitionId: spec.definitionId ?? null,
    definitionId: null,
    executionId: executionIds[index] ?? null,
  }));
  const definitions = new Map<number, PublicDefinitionEvidence>();
  return {
    selected(index: number, definition: SkillDefinition | undefined) {
      if (!owner) return;
      definitions.delete(index);
      if (requested[index]) requested[index].definitionId = null;
      if (!definition) return;
      const request = requested[index];
      if (!request || !definition.definitionId) return;
      request.definitionId = definition.definitionId;
      definitions.set(index, {
        agent: definition.name,
        definitionId: definition.definitionId,
        sourceHash: definition.sourceHash ?? null,
        bodySha256: digestDefinition(definition).sha256,
        binding: definition.binding ?? null,
        snapshot: definition.sourceSnapshot,
      });
    },
    finish<T extends Result>(result: T, outcomes: readonly DelegationOutcome[] = []): T {
      if (!owner) return result;
      let status: unknown;
      try {
        const ref = capturePublicEvidence(owner, {
          toolCallId,
          tool,
          response: { isError: result.isError ?? false, content: result.content },
          requested,
          runtimeEvidence: tool === "delegate_describe" ? null : executionEvidence(tool, outcomes, specs.length),
          definitions: [...definitions.values()],
          finals: outcomes.map((outcome, index) => ({
            ordinal: index + 1,
            executionId: requested[index]?.executionId ?? null,
            final:
              outcome.final?.state === "complete"
                ? {
                    state: "complete",
                    text: outcome.final.text,
                    sessionId: outcome.final.sessionId,
                    messageId: outcome.final.messageId,
                    leafId: outcome.final.leafId,
                    sha256: outcome.final.sha256,
                  }
                : null,
          })),
        });
        status = { status: "captured", ref: { path: ref.path, sha256: ref.sha256 } };
      } catch (error) {
        status = {
          status: "failed",
          reason: error instanceof Error ? error.message : "public evidence capture failed",
        };
      }
      return {
        ...result,
        content: [...result.content, { type: "text", text: "Public evidence capture: " + JSON.stringify(status) }],
      };
    },
  };
}
