/**
 * Loaded by the actual Pi CLI at every level of a three-level governed tree; never calls a remote provider.
 *
 * Root (no `PI_DADDY_DEPTH`): delegates once to a child holding `read` and `delegate`, then ends. Child (depth 1):
 * delegates once to a leaf holding `read`, then ends. Leaf (depth 2): ends. Every scripted model call carries a fixed
 * usage from `CALLS`, a distinct power of two in tokens and in cost, so a call counted twice or not at all changes
 * every total.
 */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { providerConfig, PROVIDER, textStep, toolStep } from "./scripted-provider.ts";

const usage = (tokens: number, cost: number) => ({
  input: tokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: tokens,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
export const CALLS = {
  root: [usage(1, 0.5), usage(2, 1)],
  child: [usage(4, 0.25), usage(8, 0.125)],
  leaf: [usage(16, 0.0625)],
};

export default function (pi: ExtensionAPI) {
  const depth = Number(process.env.PI_DADDY_DEPTH ?? "0");
  const level = depth === 0 ? "root" : depth === 1 ? "child" : "leaf";
  let requests = 0,
    index = 0;
  const script = providerConfig(() => {
    if (level === "root" && index === 0)
      return toolStep("delegate", { task: "Delegate the answer once more.", tools: ["read", "delegate"] }, "to-child");
    if (level === "child" && index === 0) return toolStep("delegate", { task: "Answer.", tools: ["read"] }, "to-leaf");
    return textStep(`${level.toUpperCase()} DONE`);
  });
  const scripted: ProviderConfig = {
    ...script,
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        // As an HTTP provider would: Daddy reads its own tool surface from the request payload.
        await options?.onPayload?.({ tools: [] }, model);
        index = requests++;
        const fixed = CALLS[level][index];
        for await (const event of script.streamSimple!(model, context, options)) {
          if (event.type === "done" && fixed) event.message.usage = structuredClone(fixed);
          stream.push(event);
        }
        stream.end();
      })();
      return stream;
    },
  };
  pi.registerProvider(PROVIDER, scripted);
}
