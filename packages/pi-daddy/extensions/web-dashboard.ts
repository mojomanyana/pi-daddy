/**
 * Standalone /dashboard command + auto-attach locator + Pi TUI live footer (zero Herdr required).
 * Supports 5-tab Terminal Side Panel (`pi-daddy panel`) & Web UI, live steering, usage/cost,
 * Bookie/Scout observations, auto-split (tmux, WezTerm, macOS iTerm2, Windows Terminal), and Escalation.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  startWebDashboard,
  type WebDashboardConfigUpdate,
  type WebDashboardEvent,
  type WebDashboardHandle,
  type WebDashboardState,
  type WebDashboardTask,
} from "../src/products/web-dashboard.ts";
import {
  loadEcosystemConfig,
  readEcosystemConfig,
  removePanelLocator,
  resolveEcosystemModelTier,
  saveEcosystemConfig,
  writePanelLocator,
} from "../src/kernel/ecosystem-config.ts";
import { workModeLabel } from "../src/kernel/work-mode.ts";
import { setWorkMode, workModeSnapshot } from "./work-mode.ts";
import { setAutoApproval } from "./session-auto-mode.ts";
import type { GrantsSession } from "./session.ts";

const MAX_EVENTS = 60;
const MAX_TASKS = 30;
const OPTIONAL_TOOLS = ["delegate_tournament", "quick_review", "delegate_all", "delegate_chain"] as const;
const THINKING_ALLOWED = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function openTerminalSplit(url: string): boolean {
  const cmd = `pi-daddy panel ${JSON.stringify(url)}`;
  try {
    if (process.env.TMUX) {
      spawn("tmux", ["split-window", "-h", "-l", "48", cmd], { detached: true, stdio: "ignore" }).unref();
      return true;
    }
    if (process.env.WEZTERM_PANE) {
      spawn("wezterm", ["cli", "split-pane", "--right", "--percent", "38", "--", "pi-daddy", "panel", url], {
        detached: true,
        stdio: "ignore",
      }).unref();
      return true;
    }
    if (process.platform === "darwin" && process.env.TERM_PROGRAM === "iTerm.app") {
      const script = [
        'tell application "iTerm2"',
        "  tell current session of current window",
        `    split vertically with default profile command ${JSON.stringify(cmd)}`,
        "  end tell",
        "end tell",
      ].join("\n");
      spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
      return true;
    }
    if (process.platform === "win32" && process.env.WT_SESSION) {
      spawn("wt", ["-w", "0", "sp", "-V", "-s", "0.38", "pi-daddy", "panel", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      return true;
    }
  } catch {
    /* Fall back to printing command. */
  }
  return false;
}

function openInBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* Best-effort browser open; URL is always printed. */
  }
}

function summarizeObservations(session: GrantsSession): { memoryLines: string[]; researchLines: string[] } {
  const memoryLines: string[] = [];
  const researchLines: string[] = [];
  try {
    const obs = session.dashboardObservations?.();
    for (const src of obs?.sources ?? []) {
      const producer = String((src as { producer?: string }).producer ?? "").toLowerCase();
      const target = producer.includes("scout") ? researchLines : producer.includes("bookie") ? memoryLines : undefined;
      if (!target) continue;
      const items = (src as { items?: Array<{ label?: string; state?: string }> }).items ?? [];
      for (const item of items.slice(0, 6)) {
        target.push(`${item.label ?? producer} (${item.state ?? "observed"})`);
      }
    }
  } catch {
    /* Observations are optional. */
  }
  return { memoryLines, researchLines };
}

export function registerWebDashboard(pi: ExtensionAPI, session: GrantsSession): void {
  let handle: WebDashboardHandle | undefined;
  let locatorCwd: string | undefined;
  let busy = false;
  let autoEnabled = false;
  let lastCtx: ExtensionContext | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  let turns = 0;
  const recent: WebDashboardEvent[] = [];
  const tasks: WebDashboardTask[] = [];

  const syncAuto = async () => {
    try {
      autoEnabled = Boolean((await session.autoMode?.read())?.enabled);
    } catch {
      autoEnabled = false;
    }
  };

  const stateOf = (): WebDashboardState => {
    const modelObj = (lastCtx as unknown as { model?: { provider?: string; id?: string } })?.model;
    const model = modelObj?.provider && modelObj?.id ? `${modelObj.provider}/${modelObj.id}` : "unset";
    const thinking = typeof pi.getThinkingLevel === "function" ? String(pi.getThinkingLevel()) : "low";
    const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
    const denom = inputTokens + cacheReadTokens;
    const cacheHitPct = denom > 0 ? Math.round((cacheReadTokens / denom) * 100) : 0;
    const { memoryLines, researchLines } = summarizeObservations(session);
    return {
      sessionId: lastCtx?.sessionManager?.getSessionId?.() ?? session.episodeId,
      cwd: lastCtx?.cwd ?? session.cwd,
      platform: `${process.platform}/${process.arch}`,
      model,
      thinking,
      autoEnabled,
      activeTools,
      optionalTools: OPTIONAL_TOOLS,
      modelTiers: {
        fast: resolveEcosystemModelTier("fast") ?? "",
        work: resolveEcosystemModelTier("work") ?? "",
        strong: resolveEcosystemModelTier("strong") ?? "",
      },
      workMode: workModeSnapshot(session),
      busy,
      usage: { inputTokens, outputTokens, cacheReadTokens, cacheHitPct, costUsd, turns },
      tasks,
      memoryLines,
      researchLines,
      recentEvents: recent,
    };
  };

  const updateFooter = (ctx?: ExtensionContext) => {
    const target = ctx ?? lastCtx;
    if (!target?.hasUI || typeof target.ui?.setStatus !== "function") return;
    const wm = workModeSnapshot(session);
    const label = wm.selection.mode === "standard" ? "Standard" : workModeLabel(wm.selection);
    const costLabel = costUsd > 0 ? ` · $${costUsd.toFixed(3)}` : "";
    const dash = handle ? ` · panel:${handle.port}` : "";
    target.ui.setStatus("pi-daddy", `Daddy · ${label}${busy ? " · running" : ""}${costLabel}${dash}`);
  };

  const record = (kind: string, detail: string, ctx?: ExtensionContext) => {
    if (ctx) lastCtx = ctx;
    recent.push({ at: new Date().toISOString(), kind, detail: detail.slice(0, 240) });
    if (recent.length > MAX_EVENTS) recent.splice(0, recent.length - MAX_EVENTS);
    handle?.push(stateOf());
    updateFooter(ctx);
  };

  const recordTask = (kind: string, status: string, detail: string) => {
    tasks.push({ at: new Date().toISOString(), kind, status, detail: detail.slice(0, 200) });
    if (tasks.length > MAX_TASKS) tasks.splice(0, tasks.length - MAX_TASKS);
  };

  const applyConfig = (patch: WebDashboardConfigUpdate) => {
    if (patch.thinking !== undefined && !THINKING_ALLOWED.has(patch.thinking))
      throw new Error("Unsupported thinking level");
    if (patch.toggleTool && !(OPTIONAL_TOOLS as readonly string[]).includes(patch.toggleTool.name))
      throw new Error("Unknown toggleable tool");
    if (patch.modelTiers) {
      const cfg = readEcosystemConfig() ?? {};
      const models = { ...cfg.models };
      const overrides = new Map<string, string>();
      for (const tier of ["fast", "work", "strong"] as const) {
        const value = patch.modelTiers[tier];
        if (value === undefined) continue;
        const clean = value.trim().slice(0, 200);
        if (clean) models[tier] = clean;
        else delete models[tier];
        overrides.set(`PI_ECO_MODEL_${tier.toUpperCase()}`, clean);
      }
      saveEcosystemConfig({ ...cfg, models });
      for (const [key, value] of overrides) {
        if (value) process.env[key] = value;
        else delete process.env[key];
      }
      record("config", "updated model tiers");
    }
    const thinkingApi = pi as { setThinkingLevel?: (level: string) => void };
    if (patch.thinking !== undefined && typeof thinkingApi.setThinkingLevel === "function") {
      thinkingApi.setThinkingLevel(patch.thinking);
      record("config", `thinking=${patch.thinking}`);
    }
    if (patch.toggleTool && typeof pi.getActiveTools === "function" && typeof pi.setActiveTools === "function") {
      const { name, enabled } = patch.toggleTool;
      const next = new Set(pi.getActiveTools());
      if (enabled) next.add(name);
      else next.delete(name);
      pi.setActiveTools([...next]);
      record("config", `${enabled ? "enabled" : "disabled"} ${name}`);
    }
  };

  const ensureStarted = async (): Promise<WebDashboardHandle> => {
    if (handle) return handle;
    await syncAuto();
    handle = await startWebDashboard({
      getState: stateOf,
      onWorkModeChange: (selection, scope) => {
        setWorkMode(session, selection, scope);
        record("work-mode", workModeLabel(selection));
      },
      onSteer: (message, deliverAs) => {
        const send = (pi as { sendUserMessage?: (c: string, o?: { deliverAs?: "steer" | "followUp" }) => void })
          .sendUserMessage;
        if (typeof send !== "function") throw new Error("Pi sendUserMessage unavailable");
        send(message, { deliverAs });
        record(deliverAs, message);
      },
      onAutoModeChange: async (enabled) => {
        await setAutoApproval(session, enabled, "dashboard");
        autoEnabled = enabled;
        record("auto", enabled ? "ON" : "OFF");
      },
      onConfigChange: applyConfig,
      onEscalate: (reason) => {
        recordTask("escalate", "requested", reason ?? "manual escalation");
        pi.events?.emit("pi-daddy:escalate-request:v1", { reason: reason ?? "panel" });
        record("escalate", reason ?? "manual escalation");
      },
    });
    const cwd = lastCtx?.cwd ?? session.cwd;
    if (cwd) {
      locatorCwd = cwd;
      try {
        writePanelLocator({
          url: handle.url,
          port: handle.port,
          pid: process.pid,
          cwd,
          startedAt: new Date().toISOString(),
        });
      } catch {
        /* Locator is convenience only. */
      }
    }
    updateFooter();
    return handle;
  };

  pi.on("session_start", async (_ev, ctx) => {
    lastCtx = ctx;
    inputTokens = 0;
    outputTokens = 0;
    cacheReadTokens = 0;
    costUsd = 0;
    turns = 0;
    await syncAuto();
    updateFooter(ctx);
    const cfg = loadEcosystemConfig();
    const shouldAutoStart =
      process.env.PI_DADDY_DASHBOARD === "web" ||
      (ctx.hasUI && session.depth === 0 && cfg.dashboard?.autoStart === true);
    if (shouldAutoStart) {
      try {
        await ensureStarted();
      } catch {
        /* Never block startup. */
      }
    }
  });
  pi.on("agent_start", (_ev, ctx) => {
    busy = true;
    record("agent", "run started", ctx);
  });
  pi.on("message_end", (ev, ctx) => {
    const msg = (
      ev as {
        message?: {
          role?: string;
          usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } };
        };
      }
    )?.message;
    if (msg?.role === "assistant" && msg.usage) {
      turns++;
      inputTokens += msg.usage.input ?? 0;
      outputTokens += msg.usage.output ?? 0;
      cacheReadTokens += msg.usage.cacheRead ?? 0;
      costUsd += msg.usage.cost?.total ?? 0;
      handle?.push(stateOf());
      updateFooter(ctx);
    }
  });
  pi.on("tool_execution_start", (ev, ctx) => {
    const name = String((ev as { toolName?: string }).toolName ?? "tool");
    if (name.startsWith("delegate") || name === "quick_review") recordTask(name, "running", "dispatched");
    record("tool:start", name, ctx);
  });
  pi.on("tool_execution_end", (ev, ctx) => {
    const row = ev as { toolName?: string; isError?: boolean };
    const name = row.toolName ?? "tool";
    if (name.startsWith("delegate") || name === "quick_review") {
      recordTask(name, row.isError ? "error" : "done", row.isError ? "failed" : "completed");
    }
    record("tool:end", `${name}${row.isError ? " (error)" : ""}`, ctx);
  });
  pi.on("agent_settled", (_ev, ctx) => {
    busy = false;
    record("agent", "settled", ctx);
  });
  pi.on("session_shutdown", async () => {
    const current = handle;
    handle = undefined;
    if (locatorCwd) removePanelLocator(locatorCwd, process.pid);
    locatorCwd = undefined;
    if (current) await current.close().catch(() => {});
  });

  pi.registerCommand("dashboard", {
    description:
      "Start or open the standalone 5-tab side panel (terminal split or web UI; works without Herdr on macOS/Linux/Windows)",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const sub = args.trim().toLowerCase();
      if (sub === "stop") {
        if (!handle) {
          ctx.ui.notify("Standalone dashboard is not running.", "info");
          return;
        }
        const prev = handle;
        handle = undefined;
        if (locatorCwd) removePanelLocator(locatorCwd, process.pid);
        await prev.close();
        updateFooter(ctx);
        ctx.ui.notify("Standalone dashboard stopped.", "info");
        return;
      }
      if (sub === "status") {
        ctx.ui.notify(
          handle
            ? `Side panel running: pi-daddy panel  (${handle.url})`
            : "Side panel stopped. Run /dashboard to start.",
          "info",
        );
        return;
      }
      const started = await ensureStarted();
      if (sub === "open") openInBrowser(started.url);
      else if (sub === "split" || sub === "tui") {
        const opened = openTerminalSplit(started.url);
        if (opened) {
          ctx.ui.notify(`Opened terminal side panel (${started.url}).`, "info");
          return;
        }
      }
      ctx.ui.notify(
        `Pi Daddy Side Panel (no Herdr needed):\n` +
          `  Terminal split (auto-attach): pi-daddy panel\n` +
          `  Terminal explicit URL:        pi-daddy panel "${started.url}"\n` +
          `  Browser UI:                   ${started.url}`,
        "info",
      );
    },
  });
}
