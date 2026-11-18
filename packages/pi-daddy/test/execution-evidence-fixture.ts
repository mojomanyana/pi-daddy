/** Actual Pi provider serialization, exercised offline: no credential or request is created. */
import assert from "node:assert/strict";
import { normalizeContext, type JsonValue, type Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
const model: Model<"openai-codex-responses"> = {
  id: "offline-conversion-fixture",
  name: "offline conversion fixture",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://unused.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 10000,
};
export function providerToolOutput(result: {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}) {
  const [message] = convertResponsesMessages(
    model,
    normalizeContext({
      messages: [
        {
          role: "toolResult",
          toolCallId: "call-evidence",
          toolName: "delegate",
          timestamp: 1,
          ...result,
          details: result.details as JsonValue,
          isError: result.isError ?? false,
        },
      ],
    }),
    new Set(["openai-codex"]),
  );
  assert.equal(message.type, "function_call_output");
  assert.ok("output" in message && typeof message.output === "string");
  return message.output as string;
}
/** The exact introductions by version, written out independently of the production strings. */
export const EVIDENCE_INTRODUCTION = {
  1: "Runtime execution evidence (process settlement; not workspace cleanup or task acceptance):\n```json\n",
  2:
    "Runtime execution evidence summary (process settlement; not workspace cleanup or task acceptance; " +
    "a settled cleanup has a verified identity-bound receipt; complete receipts stay in tool details, " +
    "outside model context):\n```json\n",
} as const;
/** The last evidence block of either version, so content recorded before version 2 still parses. */
export function evidenceFromProvider(result: Parameters<typeof providerToolOutput>[0]) {
  const output = providerToolOutput(result);
  const [found] = ([1, 2] as const)
    .map((version) => ({ version, marker: EVIDENCE_INTRODUCTION[version] }))
    .map((item) => ({ ...item, offset: output.lastIndexOf(item.marker) }))
    .filter((item) => item.offset >= 0)
    .sort((a, b) => b.offset - a.offset);
  assert.ok(found, "provider-visible tool output must contain runtime evidence, not only UI details");
  const start = found.offset + found.marker.length;
  const evidence = JSON.parse(output.slice(start, output.indexOf("\n```", start)));
  assert.equal(evidence.version, found.version, "the introduction and its JSON must name the same version");
  return evidence;
}
