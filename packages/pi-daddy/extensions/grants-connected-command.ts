export interface GrantsConnectedCommandContext {
  openDashboard: () => Promise<string>;
  ui: { notify(message: string, level: "info" | "error"): void };
}
/** Dashboard entry lives outside the capability-report renderer. */
export async function handleConnectedCommand(
  sub: string | undefined,
  ctx: GrantsConnectedCommandContext,
): Promise<boolean> {
  if (sub === "dashboard") {
    try {
      ctx.ui.notify(await ctx.openDashboard(), "info");
    } catch (error) {
      ctx.ui.notify(
        `grants: dashboard unavailable — ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
    return true;
  }
  return false;
}
