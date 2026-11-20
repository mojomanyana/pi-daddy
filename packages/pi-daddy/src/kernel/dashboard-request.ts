/** Socket deadlines shared by the terminal and the authenticated session owner. */
export function isDashboardChoiceRequest(action: unknown): boolean {
  return action === "inspect-choice" || action === "answer-choice" || action === "reclassify-choice";
}

export function dashboardRequestTimeout(action?: unknown): number {
  return isDashboardChoiceRequest(action) || action === "task-dispatch" ? 30_000 : 2_000;
}
