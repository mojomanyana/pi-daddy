/** A held actual Pi tool proves native TUI rendering and ownership without any remote provider request. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providerConfig, PROVIDER, textStep, toolStep } from "./scripted-provider.ts";

export const UI_TASK = "Inspect terminal fixture alpha\nPreserve Unicode: caf\u00e9 \u{1f642}";
export const UI_CONTEXT = "Owned fixture context beta\nExact multiline context: \u03bb";
export const UI_PROGRESS = "FIXTURE TOOL WORKING";
export const UI_RESULT = "FIXTURE TOOL RESULT";
export const UI_DETAIL = "EXPANDED TOOL DETAIL";
export const UI_THINKING = "PRIVATE_FIXTURE_THOUGHT";
export default function (pi: ExtensionAPI) {
  const root = process.env.P01_UI_ROOT!;
  let requests = 0;
  pi.registerProvider(
    PROVIDER,
    providerConfig(({ context }) => {
      appendFileSync(join(root, "requests.jsonl"), JSON.stringify({ index: requests, context }) + "\n");
      if (requests++ !== 0) return textStep();
      const tool = toolStep("fixture_visible", {});
      return { ...tool, content: [{ type: "thinking", thinking: UI_THINKING }, ...tool.content!] };
    }),
  );
  pi.registerTool({
    name: "fixture_visible",
    label: "Visible fixture tool",
    description: "Owned local held tool; no network",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, update) {
      const detached = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
      detached.unref();
      const identity = (pid: number) => ({
        pid,
        start: readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[19],
      });
      writeFileSync(
        join(root, "tool-ready.json"),
        JSON.stringify({ workers: [identity(process.pid), identity(detached.pid!)] }),
      );
      update?.({
        content: [{ type: "text", text: UI_PROGRESS + "\n" + "fixture detail\n".repeat(18) + UI_DETAIL }],
        details: {},
      });
      while (!existsSync(join(root, "release"))) {
        if (signal?.aborted) throw Error("held fixture aborted");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { content: [{ type: "text", text: UI_RESULT }], details: {} };
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    writeFileSync(
      join(root, "tui.json"),
      JSON.stringify({
        mode: ctx.mode,
        stdin: process.stdin.isTTY,
        stdout: process.stdout.isTTY,
        stderr: process.stderr.isTTY,
        cwd: process.cwd(),
        pid: process.pid,
      }),
    );
    writeFileSync(join(root, "initializing"), "");
    while (!existsSync(join(root, "startup-release"))) await new Promise((resolve) => setTimeout(resolve, 20));
    pi.setActiveTools(["fixture_visible"]);
  });
}
