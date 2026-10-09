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
  return {
    state,
    screen,
    key(key: string): "auto" | "quit" | "command" | "setting" | undefined {
      if (key === "a") return "auto";
      if (key === "q" || key === "ctrl-c") return "quit";
      if (key === ":") return "command";
      if (screen.view === "settings" && (key === "return" || key === "d")) return "setting";
      if (key === "escape") {
        screen.view = screen.view === "version-details" ? "versions" : "main";
        state.activityDetail = undefined;
        screen.offset = 0;
      } else if (key === "?" || key === "m" || key === "v" || key === "s") {
        screen.view = key === "?" ? "help" : key === "v" ? "versions" : key === "s" ? "settings" : "models";
        state.activityDetail = undefined;
        screen.offset = 0;
      } else if (key === "return" || key === "d") {
        screen.view = screen.view === "versions" ? "version-details" : "details";
        screen.offset = 0;
      } else if (["up", "down", "j", "k"].includes(key)) {
        const delta = key === "up" || key === "k" ? -1 : 1;
        if (screen.view === "settings") {
          const index = DASHBOARD_SETTING_KEYS.indexOf(screen.settingKey ?? "auto");
          screen.settingKey =
            DASHBOARD_SETTING_KEYS[Math.max(0, Math.min(DASHBOARD_SETTING_KEYS.length - 1, index + delta))];
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
        const filters = ["everything", "agents", "skills", "needs-you"] as const;
        state.filter = filters[(filters.indexOf(state.filter ?? "everything") + 1) % filters.length];
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
