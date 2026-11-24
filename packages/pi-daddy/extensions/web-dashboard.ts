/**
 * Standalone /dashboard command + Pi TUI live footer status (zero Herdr required).
 * Supports live steering, work-mode, Auto permissions, thinking level, model tiers, and tool toggles
 * across macOS, Linux, and Windows in any terminal.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  startWebDashboard,
  type WebDashboardConfigUpdate,
  type WebDashboardEvent,
  type WebDashboardHandle,
  type WebDashboardState,
} from "../src/products/web-dashboard.ts";
import { workModeLabel } from "../src/kernel/work-mode.ts";
import { setWorkMode, workModeSnapshot } from "./work-mode.ts";
import { setAutoApproval } from "./session-auto-mode.ts";
import type { GrantsSession } from "./session.ts";

const MAX_EVENTS = 60;
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
    /* Best-effort browser open; URL is always printed to the user. */
  }
}

export function registerWebDashboard(pi: ExtensionAPI, session: GrantsSession): void {
  let handle: WebDashboardHandle | undefined;
  let busy = false;
  let autoEnabled = false;
  let lastCtx: ExtensionContext | undefined;
  const recent: WebDashboardEvent[] = [];

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
        fast: process.env.PI_ECO_MODEL_FAST ?? "",
        work: process.env.PI_ECO_MODEL_WORK ?? "",
        strong: process.env.PI_ECO_MODEL_STRONG ?? "",
      },
      workMode: workModeSnapshot(session),
      busy,
      recentEvents: recent,
    };
  };

  const updateFooter = (ctx?: ExtensionContext) => {
    const target = ctx ?? lastCtx;
    if (!target?.hasUI || typeof target.ui?.setStatus !== "function") return;
    const wm = workModeSnapshot(session);
    const label = wm.selection.mode === "standard" ? "Standard" : workModeLabel(wm.selection);
    const dash = handle ? ` · panel:${handle.port}` : "";
    target.ui.setStatus("pi-daddy", `Daddy · ${label}${busy ? " · running" : ""}${dash}`);
  };

  const record = (kind: string, detail: string, ctx?: ExtensionContext) => {
    if (ctx) lastCtx = ctx;
    recent.push({ at: new Date().toISOString(), kind, detail: detail.slice(0, 240) });
    if (recent.length > MAX_EVENTS) recent.splice(0, recent.length - MAX_EVENTS);
    handle?.push(stateOf());
    updateFooter(ctx);
  };

  const applyConfig = (patch: WebDashboardConfigUpdate) => {
    if (patch.thinking !== undefined) {
      if (!THINKING_ALLOWED.has(patch.thinking)) throw new Error("Unsupported thinking level");
      if (typeof (pi as { setThinkingLevel?: (l: string) => void }).setThinkingLevel === "function") {
        (pi as { setThinkingLevel: (l: string) => void }).setThinkingLevel(patch.thinking);
        record("config", `thinking=${patch.thinking}`);
      }
    }
    if (patch.modelTiers) {
      const setEnv = (key: string, val: string | undefined) => {
        if (val === undefined) return;
        const clean = val.trim();
        if (!clean) delete process.env[key];
        else process.env[key] = clean.slice(0, 200);
      };
      setEnv("PI_ECO_MODEL_FAST", patch.modelTiers.fast);
      setEnv("PI_ECO_MODEL_WORK", patch.modelTiers.work);
      setEnv("PI_ECO_MODEL_STRONG", patch.modelTiers.strong);
      record("config", "updated model tiers");
    }
    if (patch.toggleTool && typeof pi.getActiveTools === "function" && typeof pi.setActiveTools === "function") {
      const { name, enabled } = patch.toggleTool;
      if (!(OPTIONAL_TOOLS as readonly string[]).includes(name)) throw new Error("Unknown toggleable tool");
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
    });
    updateFooter();
    return handle;
  };

  pi.on("session_start", async (_ev, ctx) => {
    lastCtx = ctx;
    await syncAuto();
    updateFooter(ctx);
    if (process.env.PI_DADDY_DASHBOARD === "web") {
      try {
        const started = await ensureStarted();
        if (ctx.hasUI) ctx.ui.notify(`Pi Daddy side panel: ${started.url}`, "info");
      } catch {
        /* Never block startup. */
      }
    }
  });
  pi.on("agent_start", (_ev, ctx) => {
    busy = true;
    record("agent", "run started", ctx);
  });
  pi.on("tool_execution_start", (ev, ctx) => {
    record("tool:start", String((ev as { toolName?: string }).toolName ?? "tool"), ctx);
  });
  pi.on("tool_execution_end", (ev, ctx) => {
    const row = ev as { toolName?: string; isError?: boolean };
    record("tool:end", `${row.toolName ?? "tool"}${row.isError ? " (error)" : ""}`, ctx);
  });
  pi.on("agent_settled", (_ev, ctx) => {
    busy = false;
    record("agent", "settled", ctx);
  });
  pi.on("session_shutdown", async () => {
    const current = handle;
    handle = undefined;
    if (current) await current.close().catch(() => {});
  });

  pi.registerCommand("dashboard", {
    description:
      "Start or open the standalone side-panel steering & config dashboard (no Herdr needed; macOS/Linux/Windows)",
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
        await prev.close();
        updateFooter(ctx);
        ctx.ui.notify("Standalone dashboard stopped.", "info");
        return;
      }
      if (sub === "status") {
        ctx.ui.notify(
          handle ? `Side panel running at ${handle.url}` : "Side panel stopped. Run /dashboard to start.",
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
          `  Terminal split: pi-daddy panel "${started.url}"\n` +
          `  Browser UI:     ${started.url}`,
        "info",
      );
    },
  });
}
