/**
 * Standalone /dashboard command + auto-attach locator + Pi TUI live footer.
 * Supports 5-tab Terminal Side Panel (`pi-daddy panel`) & Web UI, live steering, usage/cost,
 * Bookie/Scout observations, auto-split (tmux, WezTerm, Kitty, Ghostty, macOS iTerm2, Windows Terminal),
 * strong-model escalation, and 2-stage classifier-driven session harvesting.
 */
import { ecosystemToolLabel, summarizeObservations } from "./dashboard-activity.ts";
import { ecosystemPreferences } from "./ecosystem-preferences.ts";
import { thresholdFor } from "../src/products/decision-classifier.ts";
import { createClassifierSettings } from "./classifier-settings.ts";
import { registerClassifierShadow } from "./classifier-shadow.ts";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  startWebDashboard,
  type WebDashboardConfigUpdate,
  type WebDashboardEvent,
  type WebDashboardHandle,
  type WebDashboardHarvestInfo,
  type WebDashboardState,
  type WebDashboardTask,
} from "../src/products/web-dashboard.ts";
import { formatPanelCommand, openTerminalSplit } from "../src/products/terminal-split.ts";
import {
  classifyHarvestCandidate,
  createTurnHarvestTracker,
  hasHarvestSignal,
  saveHarvestedEval,
  type HarvestClassifierRegistry,
  type TurnHarvestSignals,
} from "../src/products/session-harvest.ts";
import {
  loadEcosystemConfig,
  readEcosystemConfig,
  removePanelLocator,
  resolveEcosystemModelCandidates,
  selectRegistryModel,
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

function openInBrowser(url: string): void {
  try {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32" || process.env.WSL_DISTRO_NAME
          ? "explorer.exe"
          : "xdg-open";
    const child = spawn(command, [url], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => {});
    child.unref();
  } catch {
    /* Best-effort browser open; URL is always printed. */
  }
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
  let harvestInfo: WebDashboardHarvestInfo | undefined;
  let pendingHarvestSuggestion:
    | {
        readonly scenarioId: string;
        readonly reason: string;
        readonly confidence: number;
        readonly signals: TurnHarvestSignals;
        readonly sessionFile?: string;
        readonly cwd: string;
      }
    | undefined;
  const classifierSettings = createClassifierSettings(
    () => lastCtx,
    () => session.depth === 0,
  );
  let harvestGeneration = 0;
  let retryHarvest: (() => void) | undefined;
  let eligibleTurn = 0;
  const harvestTracker = createTurnHarvestTracker();
  const recent: WebDashboardEvent[] = [];
  const ecosystemActivity: WebDashboardEvent[] = [];
  const runningTools = new Map<string, string>();
  function activity(detail: string) {
    ecosystemActivity.push({ at: new Date().toISOString(), kind: "ecosystem", detail });
    if (ecosystemActivity.length > MAX_EVENTS) ecosystemActivity.shift();
  }
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
    const tierLabel = (tier: "fast" | "work" | "strong") => {
      const choices = resolveEcosystemModelCandidates(tier);
      const resolved = selectRegistryModel(lastCtx?.modelRegistry, choices, modelObj);
      return resolved.label === model || resolved.label === "session-default" ? "session" : resolved.label;
    };
    const harvest = loadEcosystemConfig().harvest;
    const selected = harvest?.classifier || "";
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
        fast: tierLabel("fast"),
        work: tierLabel("work"),
        strong: tierLabel("strong"),
      },
      workMode: workModeSnapshot(session),
      busy,
      usage: { inputTokens, outputTokens, cacheReadTokens, cacheHitPct, costUsd, turns },
      tasks,
      memoryLines,
      researchLines,
      recentEvents: recent,
      ecosystemActivity,
      classifierNeedsModel: Boolean(retryHarvest),
      classifier: {
        model: selected,
        mode: harvest?.mode ?? "auto",
        threshold: selected ? thresholdFor(harvest, selected) : (harvest?.minConfidence ?? 0.75),
        shadow: Boolean(selected && classifierSettings.shadowModel() === selected),
      },
      ...(harvestInfo ? { harvest: harvestInfo } : {}),
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
    const latest = ecosystemActivity.at(-1)?.detail;
    target.ui.setStatus(
      "pi-daddy-activity",
      latest && (runningTools.size ? `${latest} · ${runningTools.size} active` : latest),
    );
  };

  const record = (kind: string, detail: string, ctx?: ExtensionContext) => {
    if (kind === "harvest") activity("Harvest · " + detail);
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

  const reportActivity = (detail: string, ctx: ExtensionContext) => {
    activity(detail);
    if (handle) handle.push(stateOf());
    updateFooter(ctx);
  };
  registerClassifierShadow(pi, session, classifierSettings.shadowModel, reportActivity);

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
        if (
          clean &&
          clean !== "session" &&
          !lastCtx?.modelRegistry?.getAvailable?.().some((m) => m.provider + "/" + m.id === clean)
        )
          throw Error("This model is unavailable. Use /login or choose a connected model in Settings.");
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
      onPreferences: (input) => {
        if (!lastCtx || session.depth !== 0) throw Error("Open Settings in the root Pi session.");
        let ready = false;
        pi.events.emit("scout:model-settings:v1", {
          report: () => {
            ready = true;
          },
        });
        let bookieSyncReady = false;
        pi.events.emit("bookie:review-sync-settings:v1", {
          action: "status",
          report: () => {
            bookieSyncReady = true;
          },
        });
        const result = ecosystemPreferences(lastCtx, input, ready, bookieSyncReady);
        if (input.action === "save" && input.key === "autoSyncReviews")
          pi.events.emit("bookie:review-sync-settings:v1", { action: "changed" });
        if (input.action === "save") record("config", "Updated " + input.key);
        return result;
      },
      onClassifierSettings: async (data) => {
        const result = await classifierSettings.action(data);
        if (data.action === "save") {
          harvestGeneration++;
          const retry = retryHarvest;
          retryHarvest = undefined;
          if (data.mode !== "off") retry?.();
          handle?.push(stateOf());
        }
        return result;
      },
      onWorkModeChange: (selection, scope) => {
        setWorkMode(session, selection, scope);
        record("work-mode", workModeLabel(selection));
      },
      onSteer: (message, deliverAs) => {
        const send = (pi as { sendUserMessage?: (c: string, o?: { deliverAs?: "steer" | "followUp" }) => void })
          .sendUserMessage;
        if (typeof send !== "function") throw new Error("Pi sendUserMessage unavailable");
        if (deliverAs === "steer") harvestTracker.markUserSteer();
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
        harvestTracker.markEscalated();
        recordTask("escalate", "requested", reason ?? "manual escalation");
        pi.events?.emit("pi-daddy:escalate-request:v1", { reason: reason ?? "panel" });
        record("escalate", reason ?? "manual escalation");
      },
      onHarvest: (reason) => {
        const pending = pendingHarvestSuggestion;
        const cwd = pending?.cwd ?? lastCtx?.cwd ?? session.cwd;
        const sessionFile =
          pending?.sessionFile ??
          (
            lastCtx as { sessionManager?: { getSessionFile?: () => string | undefined } } | undefined
          )?.sessionManager?.getSessionFile?.();
        const saved = saveHarvestedEval({
          cwd,
          scenarioId: pending?.scenarioId || "manual-session-harvest",
          signals: pending?.signals ?? harvestTracker.snapshot(),
          reason: pending?.reason ?? reason,
          sessionFile,
        });
        if (!saved.saved || !saved.path) {
          throw new Error(saved.error ?? "Failed to save harvested eval");
        }
        if (!pending) {
          retryHarvest = undefined;
          harvestGeneration++;
        }
        pendingHarvestSuggestion = undefined;
        harvestInfo = {
          scenarioId: saved.scenarioId,
          reason: pending?.reason ?? reason ?? "operator-harvested",
          confidence: pending?.confidence ?? 1,
          savedPath: saved.path,
        };
        recordTask("harvest", "saved", `${saved.scenarioId} (${saved.via})`);
        record("harvest", saved.path);
        return saved;
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
    retryHarvest = undefined;
    harvestGeneration++;
    ecosystemActivity.length = 0;
    runningTools.clear();
    recent.length = 0;
    tasks.length = 0;
    inputTokens = 0;
    outputTokens = 0;
    cacheReadTokens = 0;
    costUsd = 0;
    turns = 0;
    harvestInfo = undefined;
    pendingHarvestSuggestion = undefined;
    await syncAuto();
    updateFooter(ctx);
    const cfg = loadEcosystemConfig();
    if (ctx.hasUI && session.depth === 0 && ctx.modelRegistry?.getAvailable && ctx.ui?.select) {
      const models = ctx.modelRegistry.getAvailable().map((m) => m.provider + "/" + m.id);
      const configured = (["fast", "work", "strong"] as const).map((tier) => ({
        tier,
        first: resolveEcosystemModelCandidates(tier)[0],
      }));
      const missing = configured.filter(({ first }) => first && first !== "session" && !models.includes(first));
      if (missing.length && models.length) {
        const follow = "Follow the active Pi model";
        const choice = await ctx.ui.select(
          "Unavailable tiers: " +
            missing.map((m) => m.tier + " (" + m.first + ")").join(", ") +
            ". Choose a replacement for these tiers.",
          [follow, ...models],
        );
        if (choice && lastCtx === ctx) {
          const tiers = missing.filter((m) => resolveEcosystemModelCandidates(m.tier)[0] === m.first);
          applyConfig({
            modelTiers: Object.fromEntries(tiers.map((m) => [m.tier, choice === follow ? "session" : choice])),
          });
        }
      } else if (missing.length)
        ctx.ui.notify(
          "Connect a model with /login and choose it with /model. Tier settings are in /dashboard settings.",
          "warning",
        );
    }
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
  pi.on("session_tree", () => {
    harvestGeneration++;
    retryHarvest = undefined;
    pendingHarvestSuggestion = undefined;
    harvestInfo = undefined;
    handle?.push(stateOf());
  });
  pi.on("model_select", (_event, ctx) => {
    lastCtx = ctx;
    handle?.push(stateOf());
  });
  pi.events?.on?.("principal:thrash-detected:v1", (payload: unknown) => {
    const p = payload as { command?: string; signature?: string } | undefined;
    harvestTracker.markThrash(`${p?.command ?? "check"}: ${p?.signature ?? "thrash"}`);
  });
  pi.events?.on?.("pi-daddy:escalate-request:v1", () => harvestTracker.markEscalated());
  pi.events?.on?.("pi-daddy:review-blocker:v1", (payload: unknown) => {
    harvestTracker.markReviewBlocker((payload as { feedback?: string } | undefined)?.feedback);
  });
  pi.on("before_agent_start", (ev) => harvestTracker.reset(String((ev as { prompt?: string }).prompt ?? "")));
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
    const row = ev as { toolName?: string; args?: Record<string, unknown> };
    const name = String(row.toolName ?? "tool");
    const agent = row.args?.agent;
    const label =
      name === "delegate" &&
      typeof agent === "string" &&
      session.definitions?.get(agent)?.binding?.package === "principal-pi-skills"
        ? "Principal · " + agent
        : ecosystemToolLabel(name, agent);
    if (label) {
      runningTools.set(ev.toolCallId, label);
      activity(label + " · started");
    }
    harvestTracker.observeToolStart(name, row.args);
    if ((name.startsWith("delegate") && name !== "delegate_describe") || name === "quick_review")
      recordTask(name, "running", label ?? name);
    record("tool:start", name, ctx);
  });
  pi.on("tool_execution_end", (ev, ctx) => {
    const row = ev as { toolName?: string; isError?: boolean };
    const name = row.toolName ?? "tool";
    const label = runningTools.get(ev.toolCallId) ?? ecosystemToolLabel(name);
    runningTools.delete(ev.toolCallId);
    if (label) {
      const details = ev.result?.details as
        { partialAvailable?: boolean; researchStatus?: string; status?: string } | undefined;
      let outcome = row.isError ? "failed" : "returned";
      if (name === "scout_research" && details?.partialAvailable) outcome = "partial brief saved";
      else if (name === "scout_research" && !row.isError && details?.researchStatus === "complete")
        outcome = "brief completed";
      else if (!row.isError && name === "bookie_remember") {
        if (details?.status === "pending final reply") outcome = "awaiting final reply";
        if (details?.status === "saved" || details?.status === "already saved") outcome = details.status;
      }
      activity(label + " · " + outcome);
    }
    harvestTracker.observeToolEnd(row.isError);
    if ((name.startsWith("delegate") && name !== "delegate_describe") || name === "quick_review") {
      recordTask(name, row.isError ? "error" : "done", label ?? name);
    }
    record("tool:end", `${name}${row.isError ? " (error)" : ""}`, ctx);
  });
  pi.on("agent_settled", (_ev, ctx) => {
    busy = false;
    record("agent", "settled", ctx);
    if (session.depth !== 0) return;
    let cfg;
    try {
      cfg = readEcosystemConfig();
    } catch {
      // Fail closed on invalid or unreadable ecosystem.json: never classify or save automatically.
      return;
    }
    const mode = cfg?.harvest?.mode ?? "auto";
    if (mode === "off") return;
    const signals = harvestTracker.snapshot();
    if (!hasHarvestSignal(signals)) return;
    const turn = ++eligibleTurn;
    retryHarvest = undefined;
    const run = () => {
      const generation = harvestGeneration;
      const cfg = readEcosystemConfig();
      const mode = cfg?.harvest?.mode ?? "auto";
      if (mode === "off") return;
      const registry = (ctx as unknown as { modelRegistry?: HarvestClassifierRegistry }).modelRegistry;
      const fallbackModel = (ctx as unknown as { model?: unknown }).model;
      const sessionFile = (
        ctx as unknown as { sessionManager?: { getSessionFile?: () => string | undefined } }
      ).sessionManager?.getSessionFile?.();
      reportActivity("Harvest · checking whether to keep this turn", ctx);
      void classifyHarvestCandidate({
        signals,
        registry,
        fallbackModel,
        ...(cfg?.harvest?.classifier
          ? { classifier: { model: cfg.harvest.classifier, registry: ctx.modelRegistry } }
          : {}),
        minConfidence: cfg?.harvest?.classifier
          ? thresholdFor(cfg.harvest, cfg.harvest.classifier)
          : (cfg?.harvest?.minConfidence ?? 0.75),
      })
        .then((decision) => {
          if (generation !== harvestGeneration || turn !== eligibleTurn) return;
          if (
            [
              "classifier-unavailable",
              "classifier-thinking-off-unavailable",
              "classifier-error",
              "classifier-incomplete",
            ].includes(decision.reason)
          )
            throw Error(decision.reason);
          if (!decision.harvest) {
            reportActivity("Harvest · no new regression suggested", ctx);
            return;
          }
          if (mode === "auto") {
            const saved = saveHarvestedEval({
              cwd: ctx.cwd,
              scenarioId: decision.scenarioId,
              signals,
              reason: decision.reason,
              sessionFile,
            });
            if (!saved.saved || !saved.path) return;
            pendingHarvestSuggestion = undefined;
            harvestInfo = {
              scenarioId: saved.scenarioId,
              reason: decision.reason,
              confidence: decision.confidence,
              savedPath: saved.path,
            };
            recordTask("harvest", "auto-saved", `${saved.scenarioId} (${Math.round(decision.confidence * 100)}%)`);
            record("harvest", `auto-saved ${saved.path}`, ctx);
          } else {
            pendingHarvestSuggestion = {
              scenarioId: decision.scenarioId,
              reason: decision.reason,
              confidence: decision.confidence,
              signals,
              sessionFile,
              cwd: ctx.cwd,
            };
            harvestInfo = { scenarioId: decision.scenarioId, reason: decision.reason, confidence: decision.confidence };
            record("harvest", `candidate ${decision.scenarioId} — press [h] to save`, ctx);
          }
        })
        .catch(() => {
          if (generation !== harvestGeneration || turn !== eligibleTurn) return;
          retryHarvest = run;
          const hint = "Choose a working classifier in /dashboard settings and save to retry this turn.";
          record("harvest", "Classifier unavailable: " + (cfg?.harvest?.classifier ?? "fast chat model"), ctx);
          if (ctx.hasUI) ctx.ui.notify?.(hint, "warning");
        });
    };
    run();
  });
  pi.on("session_shutdown", async () => {
    harvestGeneration++;
    retryHarvest = undefined;
    classifierSettings.reset();
    lastCtx = undefined;
    const current = handle;
    handle = undefined;
    if (locatorCwd) removePanelLocator(locatorCwd, process.pid);
    locatorCwd = undefined;
    if (current) await current.close().catch(() => {});
  });

  pi.registerCommand("dashboard", {
    description: "Open the side panel, or use /dashboard settings to configure classifiers",
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
          handle ? `Side panel running: ${handle.url}` : "Side panel stopped. Run /dashboard to start.",
          "info",
        );
        return;
      }
      const started = await ensureStarted();
      let splitError: string | undefined;
      if (sub === "settings") {
        const url = started.url + "#ecosystem-settings";
        openInBrowser(url);
        ctx.ui.notify("Ecosystem settings: " + url, "info");
        return;
      }
      if (sub === "open") openInBrowser(started.url);
      else if (sub === "split" || sub === "tui") {
        const split = await openTerminalSplit(started.url);
        if (split.ok) {
          ctx.ui.notify(`Opened terminal side panel (${started.url}).`, "info");
          return;
        }
        splitError = split.error;
      }
      const shell = process.platform === "win32" ? "PowerShell" : "shell";
      ctx.ui.notify(
        `${splitError ? `Terminal auto-split unavailable (${splitError}).\n` : ""}` +
          `Pi Daddy Side Panel:\n` +
          `  Browser: ${started.url}\n` +
          `  Another ${shell}: ${formatPanelCommand(started.url)}`,
        "info",
      );
    },
  });
}
