/** Bounded metadata-only Pi observations work even when optional transcript/diagnostic capture is off. */
import { dashboardContentEnabled, observedPurpose } from "../src/products/activity-summary.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DashboardContribution } from "../src/kernel/dashboard-observation.ts";
import type { DashboardSourceOwner } from "./dashboard-sources.ts";
export function registerDashboardLive(pi: ExtensionAPI, current: () => DashboardSourceOwner | undefined) {
  let owner = current(),
    ordinal = 0;
  let turn: DashboardContribution | undefined;
  const activity: DashboardContribution[] = [];
  const calls = new Map<string, { token: number; purpose: string; tool: string }>();
  const reset = () => {
    if (current() !== owner) {
      owner = current();
      calls.clear();
      turn = undefined;
      activity.length = 0;
      ordinal = 0;
    }
  };
  const record = (kind: string, event: unknown, ctx: ExtensionContext) => {
    reset();
    if (!owner || ctx.sessionManager.getSessionId() !== owner.sessionId) return;
    const value = event as { toolName?: string; toolCallId?: string; args?: unknown; isError?: boolean };
    const tool = typeof value.toolName === "string" ? value.toolName.slice(0, 128) : undefined;
    const at = new Date().toISOString();
    if (kind === "agent_start") {
      calls.clear();
      turn = {
        id: `turn:${++ordinal}`,
        kind: "work",
        label: "Pi is working on your request",
        state: "running",
        details: [
          `Observed start: ${at}`,
          `Model: ${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`.slice(0, 240),
        ],
      };
    }
    if (kind === "agent_end" && turn) {
      calls.clear();
      turn = {
        ...turn,
        label: "Pi finished its turn",
        state: "settled",
        details: [
          ...(turn.details ?? []),
          `Observed end: ${at}`,
          "Turn ended; task acceptance and child settlement remain separate.",
        ],
      };
    }
    // Pair using Pi's call identity; expose only a local ordinal. Raw arguments and results stay in Pi.
    const callId =
      typeof value.toolCallId === "string" && value.toolCallId.length <= 200 ? value.toolCallId : undefined;
    let call = callId ? calls.get(callId) : undefined;
    if (tool && kind === "tool start") {
      call = {
        token: ++ordinal,
        purpose: observedPurpose(tool, value.args, dashboardContentEnabled(process.env)),
        tool,
      };
      if (callId) {
        calls.set(callId, call);
        if (calls.size > 32) calls.delete(calls.keys().next().value!);
      }
      if (turn?.state === "running") turn = { ...turn, label: call.purpose };
    } else if (kind === "tool end") {
      if (callId) {
        calls.delete(callId);
        if (call?.tool !== tool) call = undefined;
      } else {
        // Without an identity we cannot tell which same-tool action just ended.
        for (const [key, active] of calls) if (active.tool === tool || !tool) calls.delete(key);
      }
      if (turn?.state === "running") {
        const latest = Array.from(calls.values()).at(-1);
        turn = { ...turn, label: latest?.purpose ?? "Pi is working on your request" };
      }
    }
    const item: DashboardContribution = {
      id: `event:${++ordinal}`,
      kind: "status",
      label: tool ? `${tool}: ${kind}` : kind,
      state: value.isError ? "failed" : "observed",
      details: [
        `Observed: ${at}`,
        ...(callId && call ? [`Call: ${call.token}`] : []),
        ...(call ? [`Purpose: ${call.purpose}`] : []),
      ],
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
