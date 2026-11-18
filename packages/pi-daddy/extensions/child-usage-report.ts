/**
 * Child usage of a delegation call that throws after its children ran (review of 2026-11-17).
 *
 * A returned `delegate`, `delegate_all` or `delegate_chain` result carries its children's usage itself. A call that
 * throws does not: Pi turns it into a bare error result, so a critical-assurance veto, an executor failure in
 * `delegate` or a chain step, or a fan-out whose every child failed used to drop the usage of every child that had
 * already run, including a vetoed child's siblings and a chain's earlier steps. Pi still runs `tool_result` handlers
 * on that result and keeps a handler's `usage` and `details` while the error text and `isError` stay as they were
 * (`ExtensionRunner.emitToolResult` and `AgentSession._afterToolCall`, Pi 1.0.4 and 1.5.2; run in
 * `test-integration/pi-sdk/child-usage-total.it.ts`).
 *
 * So each delegation call keeps its settled children's observations under its tool call id, and one handler takes
 * them when that call's result passes: a result that carries `details.childUsage` or `usage` already reported and is
 * left alone, so nothing is counted twice; a bare error result gets the children's `usage` and a `childUsage`
 * record. A refusal that started no child gets nothing, so its result is unchanged. The state is per Pi session
 * (keyed by Daddy's session object), replaced when a call with the same id starts, taken by the handler, and cleared
 * at `agent_end`, by which every result of the run has passed the handler.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DELEGATION_RESULT_TOOLS,
  delegationUsage,
  observedUsageOf,
  type ObservedChildUsage,
} from "../src/executors/child-usage.ts";

type Settled = { observedUsage?: ObservedChildUsage; operation?: { reused?: boolean } };
const calls = new WeakMap<object, Map<string, Settled[]>>();

/** Starts one delegation call's record of settled children, replacing any left under the same id. */
export function childUsageReport(session: object, toolCallId: string) {
  const open = calls.get(session) ?? new Map<string, Settled[]>();
  calls.set(session, open);
  const settled: Settled[] = [];
  open.set(toolCallId, settled);
  return {
    /** Children whose outcomes the call holds. */
    add(...outcomes: Settled[]): void {
      settled.push(...outcomes);
    },
    /** One child's run: its outcome, or the observation its error carries when the child ran before the error. */
    async settle<T extends Settled>(run: Promise<T>): Promise<T> {
      try {
        const outcome = await run;
        settled.push(outcome);
        return outcome;
      } catch (error) {
        const observedUsage = observedUsageOf(error);
        if (observedUsage) settled.push({ observedUsage });
        throw error;
      }
    },
  };
}

/** Registered once per extension instance; the only reader of the state above. */
export function registerChildUsageReport(pi: ExtensionAPI, session: object): void {
  pi.on("tool_result", (event) => {
    const open = calls.get(session);
    const settled = open?.get(event.toolCallId);
    if (!settled) return undefined;
    open!.delete(event.toolCallId);
    // Never another tool's result, whatever its id: only the delegation call that kept these children.
    if (!DELEGATION_RESULT_TOOLS.has(event.toolName)) return undefined;
    const details =
      event.details !== null && typeof event.details === "object" && !Array.isArray(event.details)
        ? (event.details as Record<string, unknown>)
        : {};
    if (event.usage !== undefined || details.childUsage !== undefined) return undefined;
    const { usage, childUsage } = delegationUsage(settled);
    if (childUsage.measured + childUsage.unmeasured === 0) return undefined;
    return { ...(usage ? { usage } : {}), details: { ...details, childUsage } };
  });
  pi.on("agent_end", () => {
    calls.get(session)?.clear();
  });
}
