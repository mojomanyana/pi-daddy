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
export function evidenceFromProvider(result: Parameters<typeof providerToolOutput>[0]) {
  const output = providerToolOutput(result);
  const marker =
    "Runtime execution evidence (process settlement; not workspace cleanup or task acceptance):\n```json\n";
  const offset = output.lastIndexOf(marker);
  assert.ok(offset >= 0, "provider-visible tool output must contain runtime evidence, not only UI details");
  return JSON.parse(output.slice(offset + marker.length, output.lastIndexOf("\n```")));
}
