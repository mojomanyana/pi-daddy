/** Loaded by the actual Pi CLI, never calls a remote provider. */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providerConfig, PROVIDER, textStep, toolStep } from "./scripted-provider.ts";

export default function (pi: ExtensionAPI) {
  const scenario = process.env.P01_SCENARIO;
  let request = 0;
  let settlement = 0;
  pi.registerProvider(
    PROVIDER,
    providerConfig(() => {
      const index = request++;
      if (scenario === "error" || (scenario === "stop-then-error" && index > 0)) {
        return {
          content: [{ type: "text", text: "partial failed text" }],
          stopReason: "error",
          errorMessage: "fixture terminal failure",
        };
      }
      if (scenario === "retry" && index === 0) return { stopReason: "error", errorMessage: "503 fixture overloaded" };
      if (scenario === "nested" && index === 0) return toolStep("fixture_outer", {});
      return textStep();
    }),
  );
  pi.registerTool({
    name: "fixture_inner",
    label: "fixture inner",
    description: "local error fixture",
    exposure: "codemode",
    parameters: Type.Object({}),
    async execute() {
      throw new Error("nested fixture failure");
    },
  });
  pi.registerTool({
    name: "fixture_outer",
    label: "fixture outer",
    description: "local nested forwarding fixture",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const outcome = await ctx.executeTool("fixture_inner", {});
      return { ...outcome.result, isError: outcome.isError };
    },
  });
  pi.on("session_start", () => {
    pi.setActiveTools(["fixture_outer"]);
  });
  pi.on("agent_before_settle", () => {
    if (scenario === "stop-then-error" && settlement++ === 0)
      return {
        entries: [{ type: "custom_message", customType: "p01-followup", content: "Continue fixture", display: false }],
        continue: true,
      };
  });
}
