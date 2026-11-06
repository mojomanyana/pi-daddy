/** Bounded metadata-only Pi observations work even when optional transcript/diagnostic capture is off. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DashboardContribution } from "../src/kernel/dashboard-observation.ts";
import type { DashboardSourceOwner } from "./dashboard-sources.ts";
export function registerDashboardLive(pi: ExtensionAPI, current: () => DashboardSourceOwner | undefined) {
  let owner = current(),
    ordinal = 0;
  let turn: DashboardContribution | undefined;
  const activity: DashboardContribution[] = [];
  const reset = () => {
    if (current() !== owner) {
      owner = current();
      turn = undefined;
      activity.length = 0;
      ordinal = 0;
    }
  };
  const record = (kind: string, event: unknown, ctx: ExtensionContext) => {
    reset();
    if (!owner || ctx.sessionManager.getSessionId() !== owner.sessionId) return;
    const value = event as { toolName?: string; isError?: boolean };
    const tool = typeof value.toolName === "string" ? value.toolName.slice(0, 128) : undefined;
    const at = new Date().toISOString();
    if (kind === "agent_start")
      turn = {
        id: `turn:${++ordinal}`,
        kind: "work",
        label: "Parent Pi turn",
        state: "running",
        details: [
          `Observed start: ${at}`,
          `Model: ${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`.slice(0, 240),
        ],
      };
    if (kind === "agent_end" && turn)
      turn = {
        ...turn,
        state: "settled",
        details: [
          ...(turn.details ?? []),
          `Observed end: ${at}`,
          "Turn ended; task acceptance and child settlement remain separate.",
        ],
      };
    const item: DashboardContribution = {
      id: `event:${++ordinal}`,
      kind: "status",
      label: tool ? `${tool}: ${kind}` : kind,
      state: value.isError ? "failed" : "observed",
      details: [`Observed: ${at}`, "Pi hook metadata; no tool arguments, outputs or private reasoning."],
    };
    activity.push(item);
    if (activity.length > 32) activity.shift();
  };
  pi.on?.("agent_start", (event, ctx) => record("agent_start", event, ctx));
  pi.on?.("agent_end", (event, ctx) => record("agent_end", event, ctx));
  pi.on?.("tool_execution_start", (event, ctx) => record("tool start", event, ctx));
  pi.on?.("tool_execution_end", (event, ctx) => record("tool end", event, ctx));
  return () => {
    reset();
    return { ...(turn ? { turn: structuredClone(turn) } : {}), activity: structuredClone(activity) };
  };
}
