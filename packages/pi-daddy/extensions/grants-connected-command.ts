export interface GrantsConnectedCommandContext {
  openDashboard: () => Promise<string | { kind: "fallback"; frame: string; visibleBesideCaller: false }>;
  ui: { notify(message: string, level: "info" | "error"): void };
}
/** Dashboard entry lives outside the capability-report renderer. */
export async function handleConnectedCommand(
  sub: string | undefined,
  _target: string | undefined,
  ctx: GrantsConnectedCommandContext,
): Promise<boolean> {
  if (sub === "dashboard") {
    try {
      const opened = await ctx.openDashboard();
      ctx.ui.notify(typeof opened === "string" ? opened : opened.frame, "info");
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
