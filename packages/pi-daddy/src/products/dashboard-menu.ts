import type { PanelAction } from "./daily-panel.ts";
/** Numbers never acquire another meaning during repaint, including after a new journal tip. */
export function createDashboardMenu() {
  const ids = new Map<string, string>();
  const choices = new Map<string, { key: string; tip: string; requestDigest: string; label: string }>();
  let current = new Set<string>();
  return {
    show(tip: string, actions: readonly PanelAction[]) {
      current = new Set();
      return actions.map(action => {
        if (!action.requestDigest) return { choice: action.key, label: action.label };
        const identity = JSON.stringify([tip, action.key, action.requestDigest, action.label]);
        let choice = ids.get(identity);
        if (!choice) {
          if (ids.size >= 32768) throw Error("Action menu capacity reached; reopen the panel. No choice was remapped.");
          choice = String(ids.size + 1); ids.set(identity, choice);
          choices.set(choice, { key: action.key, tip, requestDigest: action.requestDigest, label: action.label });
        }
        current.add(choice); return { choice, label: action.label };
      });
    },
    select(choice: string) {
      if (!current.has(choice)) throw Error("That action is no longer displayed; select a current number.");
      return choices.get(choice)!;
    },
    clear() { current.clear(); },
  };
}
