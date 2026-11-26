import { bookieStatus } from "./bookie-status.mjs";
import { captureStatus } from "./capture-status.mjs";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";

export function ecosystemStatus(pi) {
  const commands = new Set(pi.getCommands().map((c) => c.name));
  const tools = new Set(pi.getAllTools().map((t) => t.name));
  const versions = new Map();
  pi.events.emit("pi-daddy:ecosystem-versions:v1", {
    version: 1,
    report(item) { if (typeof item?.version === "string") versions.set(item.id, item.version); },
  });
  return {
    "Pi Daddy": commands.has("dashboard") && tools.has("delegate"),
    Bookie: commands.has("bookie-task"),
    Scout: tools.has("scout_research"),
    Principal: versions.has("principal-pi-skills"),
    "Skill Harness": commands.has("skill-harness"),
  };
}

export default function (pi) {
  const inspect = (ctx) => {
    const entries = Object.entries(ecosystemStatus(pi));
    const msg = entries.map(([name, present]) => {
      if (name === "Principal" && !present) return "Principal version unconfirmed";
      return name + (present ? " loaded" : " missing");
    }).join(" · ");
    ctx.ui.notify(msg + "\nWorkspace: " + ctx.cwd, entries.every(([,v]) => v) ? "info" : "warning");
  };
  const checkCapture = async (_args, ctx) => {
    ctx.ui.notify(await captureStatus(pi, ctx, getAgentDir()), "info");
  };
  pi.registerCommand("pilot-capture-check", {
    description: "Check whether Daddy can read a saved result for Bookie in this session",
    handler: checkCapture,
  });
  pi.registerCommand("ecosystem-status", {
    description: "Show loaded components, or use bookie or capture for diagnostics",
    handler: async (args, ctx) => {
      if (args.trim() === "capture") {
        await checkCapture(args, ctx);
      } else if (args.trim() === "bookie") {
        ctx.ui.notify((await bookieStatus(pi, ctx, { getAgentDir, getPackageDir })).join("\n"), "info");
      } else if (!args.trim()) inspect(ctx);
      else ctx.ui.notify("Use /ecosystem-status, /ecosystem-status bookie, or /pilot-capture-check.", "warning");
    },
  });
}
