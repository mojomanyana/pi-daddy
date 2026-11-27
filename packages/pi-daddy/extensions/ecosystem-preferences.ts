import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  readEcosystemConfig,
  resolveEcosystemModelCandidates,
  saveEcosystemConfig,
} from "../src/kernel/ecosystem-config.ts";

export const researchLevels = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function connectedEcosystemPreferences(
  events: ExtensionAPI["events"],
  ctx: ExtensionContext,
  input: Record<string, unknown>,
  memory?: { active(): boolean; setEnabled(enabled: boolean): void },
) {
  let scoutReady = false,
    bookieSyncReady = false;
  events.emit("scout:model-settings:v1", {
    report() {
      scoutReady = true;
    },
  });
  events.emit("bookie:review-sync-settings:v1", {
    action: "status",
    report() {
      bookieSyncReady = true;
    },
  });
  const result = ecosystemPreferences(ctx, input, scoutReady, bookieSyncReady);
  if (result.values && memory) result.values.workspaceMemory = memory.active();
  if (input.action === "save" && input.key === "workspaceMemory") memory?.setEnabled(input.value === true);
  if (input.action === "save" && input.key === "autoSyncReviews")
    events.emit("bookie:review-sync-settings:v1", { action: "changed" });
  return result;
}

export function ecosystemPreferences(
  ctx: ExtensionContext,
  input: Record<string, unknown>,
  scoutReady: boolean,
  bookieSyncReady = false,
) {
  const cfg = readEcosystemConfig() ?? {};
  const models = [...new Set(ctx.modelRegistry.getAvailable().map((m) => m.provider + "/" + m.id))].sort();
  const values = {
    scoutModel: cfg.scout?.model ?? (process.env.PI_SCOUT_MODEL?.trim() || "session"),
    scoutThinking: cfg.scout?.thinking ?? (process.env.PI_SCOUT_THINKING?.trim() || "auto"),
    directUrls: cfg.scout?.directUrls ?? process.env.PI_SCOUT_DIRECT_URLS === "1",
    autoRecall: cfg.bookie?.autoRecall !== false,
    autoDistill: cfg.bookie?.autoDistill !== false,
    autoSyncReviews: cfg.bookie?.autoSyncReviews !== false,
    workspaceMemory: cfg.bookie?.workspaceMemory !== false,
    autoOnStartup: cfg.autoOnStartup !== false,
    autoStart: cfg.dashboard?.autoStart === true,
    autoEscalate: cfg.escalation?.auto !== false,
  };
  if (input.action === "list")
    return {
      models,
      levels: researchLevels,
      values,
      scoutReady,
      bookieSyncReady,
      current: ctx.model ? ctx.model.provider + "/" + ctx.model.id : "Select a model with /model",
    };
  if (input.action !== "save") throw Error("Unknown ecosystem settings action.");
  const { key, value } = input;
  if (key === "autoSyncReviews" && !bookieSyncReady)
    throw Error("Load the Bookie review sync update to change automatic capture.");
  if (key === "scoutModel" || key === "scoutThinking") {
    if (!scoutReady) throw Error("Load the Scout settings update before changing research models.");
    const choices = key === "scoutModel" ? ["session", ...models] : researchLevels;
    if (typeof value !== "string" || !choices.includes(value))
      throw Error("Choose an available value. Use /login to connect a provider.");
    cfg.scout = { ...cfg.scout, [key === "scoutModel" ? "model" : "thinking"]: value };
  } else {
    if (typeof value !== "boolean") throw Error("Expected an on/off setting.");
    if (key === "directUrls") cfg.scout = { ...cfg.scout, directUrls: value };
    else if (key === "workspaceMemory" || key === "autoRecall" || key === "autoDistill" || key === "autoSyncReviews")
      cfg.bookie = { ...cfg.bookie, [key]: value };
    else if (key === "autoOnStartup") cfg.autoOnStartup = value;
    else if (key === "autoStart") cfg.dashboard = { ...cfg.dashboard, autoStart: value };
    else if (key === "autoEscalate") cfg.escalation = { ...cfg.escalation, auto: value };
    else throw Error("Unknown ecosystem setting.");
  }
  saveEcosystemConfig(cfg);
  return { saved: key, value };
}

export async function repairUnavailableTiers(
  ctx: ExtensionContext,
  isCurrent: () => boolean,
  applyTiers: (modelTiers: Record<string, string>) => void,
): Promise<void> {
  if (!ctx.hasUI || !ctx.modelRegistry?.getAvailable || !ctx.ui?.select) return;
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
    if (choice && isCurrent()) {
      const tiers = missing.filter((m) => resolveEcosystemModelCandidates(m.tier)[0] === m.first);
      applyTiers(Object.fromEntries(tiers.map((m) => [m.tier, choice === follow ? "session" : choice])));
    }
  } else if (missing.length) {
    ctx.ui.notify(
      "Connect a model with /login and choose it with /model. Tier settings are in /dashboard settings.",
      "warning",
    );
  }
}
