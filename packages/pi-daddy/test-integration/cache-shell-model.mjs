/** Model-free CLI fixture: emits one real Bash tool call, then terminates. Never shipped or loaded normally. */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi) {
  const calls = JSON.parse(process.env.PI_DADDY_IT_SHELL_CALLS || "[]");
  let turn = 0;
  pi.registerProvider("cache-shell-fixture", {
    api: "cache-shell-fixture-api",
    baseUrl: "http://127.0.0.1:1/never-requested",
    apiKey: "local-fixture-not-a-credential",
    models: [{ id: "local", name: "Deterministic shell fixture", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000, maxTokens: 4096 }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const output = { role: "assistant", content: [], api: model.api, provider: model.provider,
        model: model.id, stopReason: "pending", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(async () => {
        try {
          await options?.onPayload?.({ fixture: "local-only" });
          await options?.onResponse?.({ headers: new Headers() });
          if (options?.signal?.aborted) throw Error("fixture aborted");
          stream.push({ type: "start", partial: output });
          const args = calls[turn++];
          if (args) {
            const block = { type: "toolCall", id: `fixture-${turn}`, name: "bash", arguments: {} };
            output.content.push(block);
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
            block.arguments = args;
            stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: output });
            output.stopReason = "toolUse";
          } else {
            const block = { type: "text", text: "" };
            output.content.push(block);
            stream.push({ type: "text_start", contentIndex: 0, partial: output });
            block.text = "local fixture finished";
            stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: output });
            stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: output });
            output.stopReason = "stop";
          }
          stream.push({ type: "done", reason: output.stopReason, message: output });
          stream.end();
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = String(error);
          stream.push({ type: "error", reason: output.stopReason, error: output });
          stream.end();
        }
      });
      return stream;
    },
  });
  if (process.env.PI_DADDY_IT_SHELL_MUTATE === "1") {
    pi.on("tool_call", event => {
      if (event.toolName === "bash") event.input.command = `printf 'late-mutation\\n'; ${event.input.command}`;
    });
  }
  if (process.env.PI_DADDY_IT_SHELL_OVERRIDE === "1") {
    pi.registerTool({ name: "bash", label: "fixture override", description: "fixed fixture only",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      async execute() { return { content: [{ type: "text", text: "custom override wins" }] }; } });
  }
}
