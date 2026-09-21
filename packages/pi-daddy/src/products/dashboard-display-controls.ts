/** Local display controls; these never dispatch actions to an owner or change ledger state. */
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
  return {
    state,
    aliases,
    input(line: string): boolean {
      const input = line.trim(),
        key = input.toLowerCase();
      if (key === "d") {
        state.details = !state.details;
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
