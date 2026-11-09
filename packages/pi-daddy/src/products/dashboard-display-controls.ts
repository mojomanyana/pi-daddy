import { DASHBOARD_DESTINATIONS } from "./dashboard-panels.ts";
import { DASHBOARD_SETTING_KEYS } from "./dashboard-settings.ts";
/** Local display controls; these never dispatch actions to an owner or change ledger state. */
import { dashboardScreenState } from "./dashboard-screen.ts";
import { ActivityTimelineAliases } from "./activity-timeline.ts";

export function createDashboardDisplayControls(details: boolean, ledger: boolean) {
  const state: {
    details: boolean;
    history: boolean;
    filter?: "everything" | "agents" | "skills" | "needs-you";
    activityDetail?: { taskKey: string; field: "prompt" | "final" };
  } = { details, history: false, ...(ledger ? { filter: "everything" as const } : {}) };
  // Held by the panel process, so a refresh or a newly observed root cannot renumber an already displayed alias.
  const aliases = new ActivityTimelineAliases();
  const screen = dashboardScreenState();
  if (details) screen.view = "details";
  let returnFromReading: Pick<typeof screen, "view" | "offset" | "manualScroll" | "selectedKey"> | undefined;
  return {
    state,
    screen,
    key(key: string): "auto" | "quit" | "command" | "setting" | undefined {
      if (key === "?" || key === "r") {
        const reading = key === "?" ? "help" : "recap";
        if (screen.view === reading) key = "escape";
        else {
          returnFromReading ??= {
            view: screen.view,
            offset: screen.offset,
            manualScroll: screen.manualScroll,
            selectedKey: screen.selectedKey,
          };
          screen.view = reading;
          screen.offset = 0;
          screen.manualScroll = false;
          return;
        }
      }
      if (screen.view === "help" || screen.view === "recap") {
        if (key === "escape" && returnFromReading) {
          Object.assign(screen, returnFromReading);
          returnFromReading = undefined;
          return;
        }
        if (key === "return" || key === "d" || key === "tab" || key === "p" || key === "f") return;
        if (/^[1-6mvs]$/.test(key)) returnFromReading = undefined;
      }
      if (/^[1-6]$/.test(key)) {
        screen.selections ??= {};
        if (screen.selectedKey) screen.selections[screen.destination ?? "now"] = screen.selectedKey;
        if ((screen.destination ?? "now") !== DASHBOARD_DESTINATIONS[Number(key) - 1] && state.filter)
          state.filter = "everything";
        screen.destination = DASHBOARD_DESTINATIONS[Number(key) - 1];
        screen.selectedKey = screen.selections[screen.destination!];
        screen.view = screen.destination === "settings" ? "settings" : "main";
        screen.offset = 0;
        screen.manualScroll = false;
        state.activityDetail = undefined;
        return;
      }
      if (key === "pageup" || key === "pagedown") {
        screen.manualScroll = true;
        screen.offset = Math.max(0, screen.offset + (key === "pageup" ? -8 : 8));
        return;
      }
      if (key === "x") {
        if (screen.view === "details") {
          screen.sourceDetails = !screen.sourceDetails;
          screen.offset = 0;
        } else if (screen.view === "main") screen.expanded = !screen.expanded;
        return;
      }
      if (key === "a") return "auto";
      if (key === "q" || key === "ctrl-c") return "quit";
      if (key === ":") return "command";
      if (screen.view === "settings" && (key === "return" || key === "d")) return "setting";
      if (key === "escape") {
        screen.view = screen.view === "version-details" ? "versions" : "main";
        if (screen.view === "main" && screen.destination === "settings") screen.destination = "now";
        state.activityDetail = undefined;
        screen.offset = 0;
      } else if (key === "m" || key === "v" || key === "s") {
        screen.view = key === "v" ? "versions" : key === "s" ? "settings" : "models";
        if (key === "s") screen.destination = "settings";
        state.activityDetail = undefined;
        screen.offset = 0;
      } else if (key === "return" || key === "d") {
        if (screen.view !== "versions" && (screen.view !== "main" || !screen.selectedKey)) return;
        screen.view = screen.view === "versions" ? "version-details" : "details";
        screen.sourceDetails = false;
        screen.offset = 0;
      } else if (["up", "down", "j", "k"].includes(key)) {
        screen.manualScroll = false;
        const delta = key === "up" || key === "k" ? -1 : 1;
        if (screen.view === "settings") {
          const keys = screen.settingKeys ?? DASHBOARD_SETTING_KEYS;
          const index = keys.indexOf(screen.settingKey ?? "auto");
          screen.settingKey = keys[Math.max(0, Math.min(keys.length - 1, index + delta))];
        } else if (screen.view === "versions") {
          const rows = screen.versionRows ?? [],
            index = rows.findIndex((row) => row.id === screen.versionId);
          screen.versionId = rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.id;
        } else if (screen.view !== "main") screen.offset = Math.max(0, screen.offset + delta);
        else {
          const index = Math.max(
            0,
            screen.items.findIndex((item) => item.key === screen.selectedKey),
          );
          screen.selectedKey = screen.items[Math.max(0, Math.min(screen.items.length - 1, index + delta))]?.key;
          state.activityDetail = undefined;
        }
      } else if (key === "tab") {
        screen.selections ??= {};
        if (screen.selectedKey)
          screen.selections[`${screen.destination ?? "now"}:${state.filter ?? "everything"}`] = screen.selectedKey;
        const filters = ["everything", "agents", "skills", "needs-you"] as const;
        state.filter = filters[(filters.indexOf(state.filter ?? "everything") + 1) % filters.length];
        screen.selectedKey = screen.selections[`${screen.destination ?? "now"}:${state.filter}`];
        screen.view = "main";
        state.activityDetail = undefined;
      } else if (key === "p" || key === "f") {
        const selected = screen.items.find((item) => item.key === screen.selectedKey);
        if (selected?.taskKey) {
          state.activityDetail = { taskKey: selected.taskKey, field: key === "p" ? "prompt" : "final" };
          screen.view = "details";
          screen.offset = 0;
        }
      } else if (key === "h") state.history = !state.history;
      return undefined;
    },
    aliases,
    input(line: string): boolean {
      const input = line.trim(),
        key = input.toLowerCase();
      if (key === "d") {
        state.details = !state.details;
        screen.view = state.details ? "details" : "main";
        return true;
      }
      if (ledger && key === "h") {
        state.history = !state.history;
        return true;
      }
      if (ledger && ["everything", "agents", "skills", "needs-you"].includes(key)) {
        state.filter = key as NonNullable<typeof state.filter>;
        return true;
      }
      const detail = /^(p|f)\s+([^\s]{1,1400})$/i.exec(input);
      if (ledger && detail) {
        screen.view = "details";
        screen.offset = 0;
        state.activityDetail = { field: detail[1]!.toLowerCase() === "p" ? "prompt" : "final", taskKey: detail[2]! };
        return true;
      }
      return false;
    },
    prompt(): string {
      return ledger
        ? `d Details / h ${state.history ? "Collapse" : "Expand"} history / Everything|Agents|Skills|Needs-you / p|f <r#/t# or root:task>, then Enter: `
        : "Action number / d Details, then Enter: ";
    },
  };
}
