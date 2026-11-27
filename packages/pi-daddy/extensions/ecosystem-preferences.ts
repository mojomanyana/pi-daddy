import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isWorkspaceMemoryMode, readEcosystemConfig, saveEcosystemConfig } from "../src/kernel/ecosystem-config.ts";

export const researchLevels = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function connectedEcosystemPreferences(
  events: ExtensionAPI["events"],
  ctx: ExtensionContext,
  input: Record<string, unknown>,
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
  return ecosystemPreferences(ctx, input, scoutReady, bookieSyncReady);
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
    workspaceMemory: cfg.bookie?.workspaceMemory ?? "on",
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
  } else if (key === "workspaceMemory") {
    if (!isWorkspaceMemoryMode(value)) throw Error("Choose On, Follow Daddy Auto, or Off for workspace memory.");
    cfg.bookie = { ...cfg.bookie, workspaceMemory: value };
  } else {
    if (typeof value !== "boolean") throw Error("Expected an on/off setting.");
    if (key === "directUrls") cfg.scout = { ...cfg.scout, directUrls: value };
    else if (key === "autoRecall" || key === "autoDistill" || key === "autoSyncReviews")
      cfg.bookie = { ...cfg.bookie, [key]: value };
    else if (key === "autoStart") cfg.dashboard = { ...cfg.dashboard, autoStart: value };
    else if (key === "autoEscalate") cfg.escalation = { ...cfg.escalation, auto: value };
    else throw Error("Unknown ecosystem setting.");
  }
  saveEcosystemConfig(cfg);
  return { saved: key, value };
}
