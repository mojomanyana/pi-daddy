/**
 * Loaded by the actual Pi CLI at every level of a governed tree; never calls a remote provider.
 *
 * Default (the three-level tree): the root (no `PI_DADDY_DEPTH`) delegates once to a child holding `read` and
 * `delegate`, then ends. Child (depth 1): delegates once to a leaf holding `read`, then ends. Leaf (depth 2): ends.
 *
 * `DADDY_TEST_CHILD_USAGE=thrown` at the root (review of 2026-11-17): three delegation calls that throw after their
 * children ran, a vetoed `delegate`, a `delegate_all` with a vetoed child beside one that answers, and a
 * `delegate_chain` whose second step vetoes, then the root ends. Each child's task names its usage (`usage=<tokens>`)
 * and whether it vetoes: a veto answers `BLOCKED_CRITICAL_ASSURANCE` and exits 3, as an upstream controller does.
 *
 * Every scripted model call carries a fixed usage, a distinct power of two in tokens and in cost, so a call counted
 * twice or not at all changes every total.
 */
import { createAssistantMessageEventStream, type TranscriptContext } from "@earendil-works/pi-ai";
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
/** The thrown scenario: the root's four calls, and each child's one call by its task's `usage=<tokens>`. */
export const THROWN = {
  root: [usage(1, 0.5), usage(2, 1), usage(4, 0.25), usage(8, 0.125)],
  children: Object.fromEntries(
    [16, 32, 64, 128, 256].map((tokens) => [tokens, usage(tokens, 1 / tokens)] as const),
  ) as Record<number, ReturnType<typeof usage>>,
};
const read = ["read"];
const THROWN_CALLS = [
  toolStep("delegate", { task: "VETO usage=16", tools: read }, "vetoed"),
  toolStep(
    "delegate_all",
    {
      children: [
        { task: "ANSWER usage=32", tools: read },
        { task: "VETO usage=64", tools: read },
      ],
    },
    "fan-out",
  ),
  toolStep(
    "delegate_chain",
    {
      steps: [
        { task: "ANSWER usage=128", tools: read },
        { task: "VETO usage=256", tools: read },
      ],
    },
    "chain",
  ),
];

/** The child's task as Daddy sent it: its first user message, searched as text. */
const taskOf = (context: TranscriptContext) =>
  JSON.stringify(context.messages.find((message) => message.role === "user")?.content ?? "");

export default function (pi: ExtensionAPI) {
  const depth = Number(process.env.PI_DADDY_DEPTH ?? "0");
  const level = depth === 0 ? "root" : depth === 1 ? "child" : "leaf";
  const thrown = level === "root" && process.env.DADDY_TEST_CHILD_USAGE === "thrown";
  let requests = 0,
    index = 0;
  const script = providerConfig(({ context }) => {
    const task = taskOf(context);
    if (thrown) return THROWN_CALLS[index] ?? textStep("ROOT DONE");
    if (/\bVETO usage=/.test(task)) {
      // An upstream controller's veto: the token first, then a non-zero exit (`isCriticalAssuranceBlock`).
      process.once("exit", () => (process.exitCode = 3));
      return textStep("BLOCKED_CRITICAL_ASSURANCE\nfixture veto");
    }
    if (/\bANSWER usage=/.test(task)) return textStep("ANSWERED");
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
        const named = /usage=(\d+)/.exec(taskOf(context));
        const fixed = thrown
          ? THROWN.root[index]
          : named && level !== "root"
            ? THROWN.children[Number(named[1])]
            : CALLS[level][index];
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
