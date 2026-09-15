/** Local display controls; these never dispatch actions to an owner or change ledger state. */
export function createDashboardDisplayControls(details: boolean, ledger: boolean) {
  const state = { details, history: false };
  return {
    state,
    input(line: string): boolean {
      const key = line.trim().toLowerCase();
      if (key === "d") { state.details = !state.details; return true; }
      if (ledger && key === "h") { state.history = !state.history; return true; }
      return false;
    },
    prompt(): string {
      return ledger
        ? `d Details / h ${state.history ? "Collapse" : "Expand"} history, then Enter: `
        : "Action number / d Details, then Enter: ";
    },
  };
}
