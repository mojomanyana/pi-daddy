/**
 * Loaded by the actual Pi CLI in a governed root AND in the child it delegates to; never calls a remote provider.
 *
 * Root (no `PI_DADDY_DEPTH`): a scripted model that describes `scout-public`, delegates to it with the returned
 * arguments, then ends with what the delegation returned; plus a local stand-in for `scout_research` that
 * records every call it receives. Child (`PI_DADDY_DEPTH=1`): a scripted model that calls `scout_research` once
 * and ends by repeating the tool result it received. The child registers no `scout_research` of its own: the
 * one it calls is Daddy's parent-run entrypoint. `DADDY_PARENT_RUN_BLOCK=1` makes the root's own `tool_call`
 * hook block that tool, as a permission extension would.
 *
 * Same model only (2026-11-17): the provider offers a second model, `OTHER_MODEL`. `DADDY_PARENT_RUN_CHILD_MODEL`
 * makes the root delegate with that explicit `model`. `DADDY_PARENT_RUN_SWITCHED=<file>` makes the root switch to
 * `OTHER_MODEL` (as `/model` would) once its child is running, then create the file; the child makes its call only
 * after the file exists, so the root's call-time check is what meets the change.
 *
 * `DADDY_PARENT_RUN_USAGE=1` makes the stand-in report `SCOUT_USAGE` as its tool-result usage, as a Scout that
 * accounted for its own model calls would; Pi then adds it to the waiting delegation's result (2026-11-17).
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { claimTaskWriter } from "../../extensions/task-worktree-writer.ts";
import { providerConfig, PROVIDER, textStep, toolStep, type Request } from "./scripted-provider.ts";

export const OTHER_MODEL = "contract-fixture-other";

export const CHILD_QUESTION = {
  question: "Which Pi release added nested tool calls from an extension tool?",
  scope: "Public changelog of the Pi coding agent only.",
};
export const SCOUT_TEXT = "SCOUT FIXTURE ANSWER: nested tool calls are documented in the public changelog.";
/** Fixed, binary-exact usage the stand-in reports when `DADDY_PARENT_RUN_USAGE=1`. */
export const SCOUT_USAGE = {
  input: 64,
  output: 32,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 96,
  cost: { input: 0.5, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 0.75 },
};

/** The text of the most recent tool result the model was shown. */
function lastToolResult(request: Request): string {
  const message = [...request.context.messages].reverse().find((entry) => entry.role === "toolResult");
  if (!message || message.role !== "toolResult") return "";
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

const child = (process.env.PI_DADDY_DEPTH ?? "0") !== "0";

/**
 * Like an HTTP provider, hand Pi the request payload before answering, so `before_provider_request` fires. Daddy
 * derives a session's own tool surface there; the shared scripted provider skips the step because no other
 * fixture needs it. Also offers `OTHER_MODEL`, and holds a child's requests until the root has switched model.
 */
function withPayload(config: ProviderConfig): ProviderConfig {
  const [fixture] = config.models!;
  return {
    ...config,
    models: [fixture, { ...fixture, id: OTHER_MODEL, name: "P01 local fixture, second model" }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const switched = process.env.DADDY_PARENT_RUN_SWITCHED;
        if (child && switched) while (!existsSync(switched)) await new Promise((resolve) => setTimeout(resolve, 20));
        // Daddy reads the tool surface from Pi's own inventory when it reports exposure (1.0.4 and later).
        await options?.onPayload?.({ tools: [] }, model);
        for await (const event of config.streamSimple!(model, context, options)) stream.push(event);
        stream.end();
      })();
      return stream;
    },
  };
}

export default function (pi: ExtensionAPI) {
  let request = 0;
  const taskSelected = process.env.DADDY_TEST_SELECTED_TASK === "1";
  const recoverWriter = process.env.DADDY_TEST_RECOVER_WRITER === "1";
  pi.registerProvider(
    PROVIDER,
    withPayload(
      providerConfig((next) => {
        const index = request++;
        if (child && process.env.PI_DADDY_DEFINITION === "architect") return textStep("Architect completed.");
        if (child)
          return index === 0
            ? toolStep("scout_research", CHILD_QUESTION, "child-call")
            : textStep(`CHILD RECEIVED:\n${lastToolResult(next)}`);
        if (index === 0) return toolStep("delegate_describe", { agent: "scout-public" }, "describe-call");
        if (index === 1) {
          const described = JSON.parse(lastToolResult(next));
          if (taskSelected)
            return toolStep(
              "delegate_all",
              {
                children: [
                  {
                    ...described.delegationArguments,
                    operation_id: "scout-check",
                    task: "Check the source.",
                  },
                  { agent: "architect", operation_id: "architect-check", task: "Check the design." },
                ],
              },
              "mixed-call",
            );
          const model = process.env.DADDY_PARENT_RUN_CHILD_MODEL;
          return toolStep(
            "delegate",
            {
              ...described.delegationArguments,
              task: "Find which Pi release added nested tool calls.",
              ...(model ? { model } : {}),
            },
            "delegate-call",
          );
        }
        if (recoverWriter && (index === 2 || index === 3)) {
          if (index === 2 && !lastToolResult(next).includes('"state":"not-started"'))
            return textStep("Missing proof that the original child did not start.");
          return toolStep(
            "delegate",
            { agent: "scout-public", task: "Check the source.", operation_id: "scout-corrected" },
            `corrected-${index}`,
          );
        }
        return textStep(`PARENT DONE:\n${lastToolResult(next)}`);
      }),
    ),
  );
  if (child) return;
  if (recoverWriter) {
    let release: Awaited<ReturnType<typeof claimTaskWriter>> | undefined;
    pi.on("session_start", async (_, ctx) => {
      release = await claimTaskWriter(
        process.env.PI_CODING_AGENT_DIR!,
        ctx.cwd,
        { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
        "earlier-writer",
      );
    });
    pi.on("tool_execution_end", (event) => {
      if (event.toolName === "delegate_all") release?.("settled");
    });
  }
  if (taskSelected)
    pi.events.on("pi.task-history.v1.scope", (value) => {
      const request = value as { accept(scope: unknown): void };
      request.accept({ projectId: "library", taskId: "two-desks", revision: 1, assertCurrent: async () => {} });
    });
  const switched = process.env.DADDY_PARENT_RUN_SWITCHED;
  if (switched)
    pi.on("tool_execution_update", async (event, ctx) => {
      if (event.toolName !== "delegate" || existsSync(switched)) return;
      const other = ctx.modelRegistry.find(PROVIDER, OTHER_MODEL);
      if (!other || !(await pi.setModel(other))) throw new Error("the fixture could not switch the root's model");
      writeFileSync(switched, "");
    });
  // Stands in for a permission extension (or a human's "no") in the root's own tool pipeline.
  if (process.env.DADDY_PARENT_RUN_BLOCK === "1")
    pi.on("tool_call", (event) =>
      event.toolName === "scout_research" ? { block: true, reason: "the operator declined scout_research" } : undefined,
    );
  pi.registerTool({
    name: "scout_research",
    label: "Scout research (fixture)",
    description: "Local stand-in for Scout: records its arguments and returns fixed text. No worker, no network.",
    parameters: Type.Object(
      {
        question: Type.String({ minLength: 1, maxLength: 4000 }),
        scope: Type.String({ minLength: 1, maxLength: 4000 }),
        sourceUrls: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 6 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, args, signal) {
      appendFileSync(process.env.DADDY_PARENT_RUN_MARKER!, JSON.stringify({ args, signal: Boolean(signal) }) + "\n");
      return {
        content: [{ type: "text", text: SCOUT_TEXT }],
        details: { briefPath: "/private/operator/briefs/never-forwarded.json" },
        ...(process.env.DADDY_PARENT_RUN_USAGE === "1" ? { usage: SCOUT_USAGE } : {}),
      };
    },
  });
}
