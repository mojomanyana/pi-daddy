/** Model-free provider: produces real Pi streaming events without an HTTP request. */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  TranscriptContext,
  SimpleStreamOptions,
  Model,
  Api,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

export const PROVIDER = "p01-scripted";
export const MODEL = "contract-fixture";
export const FINAL = "  final first\nfinal second\u2028final third\u2029  ";
export type Step = {
  content?: AssistantMessage["content"];
  stopReason?: "stop" | "toolUse" | "error";
  errorMessage?: string;
};
export type Request = { model: Model<Api>; context: TranscriptContext; options?: SimpleStreamOptions };
export const textStep = (text = FINAL): Step => ({ content: [{ type: "text", text }] });
export const toolStep = (name: string, args: unknown, id = "call-1"): Step => ({
  content: [{ type: "toolCall", id, name, arguments: args as ToolCall["arguments"] }],
  stopReason: "toolUse",
});

export function providerConfig(next: (request: Request) => Step): ProviderConfig {
  return {
    baseUrl: "http://scripted.invalid",
    apiKey: "fixture-only-not-a-credential",
    api: "p01-scripted-api",
    models: [
      {
        id: MODEL,
        name: "P01 local fixture",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const step = next({ model, context: structuredClone(context), options });
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "pending",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: structuredClone(message) });
        for (const block of step.content ?? []) {
          const contentIndex = message.content.length;
          if (block.type === "text") {
            message.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex, partial: structuredClone(message) });
            message.content[contentIndex] = block;
            stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: structuredClone(message) });
            stream.push({ type: "text_end", contentIndex, content: block.text, partial: structuredClone(message) });
          } else if (block.type === "thinking") {
            message.content.push({ type: "thinking", thinking: "" });
            stream.push({ type: "thinking_start", contentIndex, partial: structuredClone(message) });
            message.content[contentIndex] = block;
            stream.push({
              type: "thinking_delta",
              contentIndex,
              delta: block.thinking,
              partial: structuredClone(message),
            });
            stream.push({
              type: "thinking_end",
              contentIndex,
              content: block.thinking,
              partial: structuredClone(message),
            });
          } else if (block.type === "toolCall") {
            message.content.push(block);
            stream.push({ type: "toolcall_start", contentIndex, partial: structuredClone(message) });
            stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: structuredClone(message) });
          } else {
            throw new Error("Fixture supports only text, thinking and tool calls");
          }
        }
        message.stopReason = step.stopReason ?? "stop";
        if (message.stopReason === "error") {
          message.errorMessage = step.errorMessage ?? "fixture terminal error";
          stream.push({ type: "error", reason: "error", error: message });
        } else {
          stream.push({ type: "done", reason: message.stopReason, message });
        }
        stream.end();
      });
      return stream;
    },
  };
}
