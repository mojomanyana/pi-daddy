/** Human command access without a dashboard. This command is not exposed as a model tool. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GrantsSession } from "./session.ts";
import { setWorkMode, workModeSnapshot } from "./work-mode.ts";
import {
  WORK_MODE_EMPHASES,
  WORK_MODE_LABELS,
  workModeLabel,
  type WorkModeSelection,
} from "../src/kernel/work-mode.ts";

export function registerWorkModeCommand(pi: ExtensionAPI, session: GrantsSession): void {
  pi.registerCommand("work-mode", {
    description: "Choose Standard (current behavior) or optional Ambitious guidance for this session or next request",
    handler: async (args, ctx) => {
      try {
        const initial = workModeSnapshot(session);
        if (args.trim() === "status") {
          ctx.ui.notify(
            [
              `Session: ${workModeLabel(initial.selection)}`,
              `Active: ${initial.active ? workModeLabel(initial.active) : "idle"}`,
              `Next: ${workModeLabel(initial.nextRequest ?? initial.selection)}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        const owner = session.reloadLifecycle.workMode;
        let selection: WorkModeSelection;
        let scope: "session" | "next-request";
        if (args.trim()) {
          const [mode, target = "session", ...emphases] = args.trim().split(/\s+/);
          if ((mode !== "standard" && mode !== "ambitious") || !["session", "next"].includes(target))
            throw new Error(
              "Use /work-mode, or /work-mode standard|ambitious session|next [speed altitude depth range]",
            );
          selection = { mode, emphases: emphases as WorkModeSelection["emphases"] };
          scope = target === "next" ? "next-request" : "session";
        } else {
          if (!ctx.hasUI)
            throw new Error("Use /work-mode standard|ambitious session|next [speed altitude depth range]");
          const mode = await ctx.ui.select("Work mode · approach only", ["Standard · current behavior", "Ambitious"]);
          if (!mode) return;
          const target = await ctx.ui.select("Apply to", [
            "This session · /new resets to Standard",
            "Next request only · includes its children",
          ]);
          if (!target) return;
          scope = target.startsWith("This session") ? "session" : "next-request";
          selection = { mode: mode.startsWith("Standard") ? "standard" : "ambitious", emphases: [] };
          if (selection.mode === "ambitious") {
            while (true) {
              const options = WORK_MODE_EMPHASES.map(
                (key) => `${selection.emphases.includes(key) ? "[x]" : "[ ]"} ${WORK_MODE_LABELS[key]}`,
              );
              const chosen = await ctx.ui.select("Optional emphases · none selected means balanced", [
                ...options,
                "Apply selection",
              ]);
              if (!chosen) return;
              if (chosen === "Apply selection") break;
              const key = WORK_MODE_EMPHASES[options.indexOf(chosen)];
              if (key)
                selection.emphases = selection.emphases.includes(key)
                  ? selection.emphases.filter((item) => item !== key)
                  : [...selection.emphases, key];
            }
          }
        }
        if (session.reloadLifecycle.workMode !== owner) throw new Error("Session changed; choose the mode again");
        setWorkMode(session, selection, scope);
        ctx.ui.notify(
          `${workModeLabel(selection)} · ${scope === "session" ? "this session; /new resets to Standard" : "next request only"}. Running work keeps its captured mode.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Work-mode selection was not applied", "error");
      }
    },
  });
}
