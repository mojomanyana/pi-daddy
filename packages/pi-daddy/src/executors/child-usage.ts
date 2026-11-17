/**
 * Governed children's model usage, as the delegating Pi session accounts it (owner decision 2026-11-17).
 *
 * Pi adds a tool result's `usage` to the session that ran the tool: the persisted tool result message, session
 * statistics, the footer and cost (Pi 0.81.0 and later; read in 1.0.4 and 1.5.2). `delegate`, `delegate_all` and
 * `delegate_chain` report there what their children were observed to spend, so a session that delegates its work
 * does not look cheap. A host without that accounting does not keep the field, and nothing else changes.
 *
 * **Each model call is counted once, at any depth.** A child's own session counts what its delegation results
 * reported, so `activity-session.ts` keeps the two apart: the child's own calls are `usage`, which the ledger
 * records, and what its delegation results reported is `delegated`. Its report to its parent is both, so the root
 * session's total holds every call in the tree once, and summing the ledger over an episode still holds each once.
 *
 * **Coverage is counted, never filled in.** `measured` and `unmeasured` count governed executions in the subtree
 * whose own usage was or was not observed. An unobserved child adds nothing to the total, so a total with
 * `unmeasured > 0` is a lower bound. In a child's session, a delegation result without a record (a call that threw,
 * which Pi turns into a bare error result) counts as one unmeasured child, because nothing says whether a child
 * ran; a record whose usage the host did not keep counts all its children as unmeasured.
 *
 * Every value read back comes from a child's session file: untrusted numbers, accepted only when finite and
 * non-negative. They describe usage and nothing else; no grant, refusal or limit reads them.
 */
import type { ChildUsageTotals } from "../governance/ledger-events.ts";

/** The tools whose results report children's usage. `delegate_describe` starts nothing. */
export const DELEGATION_RESULT_TOOLS: ReadonlySet<string> = new Set(["delegate", "delegate_all", "delegate_chain"]);

export interface UsageCoverage {
  /** Governed executions in the subtree whose own model usage was observed. */
  measured: number;
  /** Governed executions in the subtree whose usage was not observed and is in no total. */
  unmeasured: number;
}
/** A settled child's own calls plus what its own delegation results reported, as far as observed. */
export interface ObservedChildUsage extends UsageCoverage {
  usage?: ChildUsageTotals;
}
/** What a delegation result says in `details.childUsage`, and what its parent reads back. */
export interface ChildUsageRecord extends UsageCoverage {
  /** Whether the result set Pi's tool-result `usage`: exactly when some child's usage was observed. */
  reported: boolean;
  coverage: "complete" | "partial" | "unavailable";
}

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Pi's `Usage` fields this package reads, validated; anything else in the value is dropped. */
export function usageTotals(value: unknown): ChildUsageTotals | undefined {
  const usage = object(value),
    cost = object(usage?.cost);
  if (
    !usage ||
    !cost ||
    !TOKEN_FIELDS.every((field) => amount(usage[field])) ||
    !COST_FIELDS.every((field) => amount(cost[field]))
  )
    return undefined;
  if (usage.reasoning !== undefined && !amount(usage.reasoning)) return undefined;
  return addUsage(undefined, usage as unknown as ChildUsageTotals);
}

/** Field-wise sum; `reasoning` stays absent unless a side reported it. Callers check the sum is still finite. */
export function addUsage(left: ChildUsageTotals | undefined, right: ChildUsageTotals): ChildUsageTotals {
  const sum = (a: number | undefined, b: number) => (a ?? 0) + b;
  const reasoning =
    left?.reasoning === undefined && right.reasoning === undefined
      ? undefined
      : sum(left?.reasoning, right.reasoning ?? 0);
  return {
    input: sum(left?.input, right.input),
    output: sum(left?.output, right.output),
    cacheRead: sum(left?.cacheRead, right.cacheRead),
    cacheWrite: sum(left?.cacheWrite, right.cacheWrite),
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens: sum(left?.totalTokens, right.totalTokens),
    cost: {
      input: sum(left?.cost.input, right.cost.input),
      output: sum(left?.cost.output, right.cost.output),
      cacheRead: sum(left?.cost.cacheRead, right.cost.cacheRead),
      cacheWrite: sum(left?.cost.cacheWrite, right.cost.cacheWrite),
      total: sum(left?.cost.total, right.cost.total),
    },
  };
}
const finite = (usage: ChildUsageTotals | undefined) => !usage || usageTotals(usage) !== undefined;
/** A sum that stops being finite measures nothing: every child in it becomes unmeasured. */
function observed(usage: ChildUsageTotals | undefined, measured: number, unmeasured: number): ObservedChildUsage {
  if (!finite(usage)) return { measured: 0, unmeasured: measured + unmeasured };
  return { ...(usage ? { usage } : {}), measured, unmeasured };
}

/** A record read back from a child's session; `coverage` is recomputed, never trusted. */
export function childUsageRecord(value: unknown): Omit<ChildUsageRecord, "coverage"> | undefined {
  const record = object(value);
  if (!record || typeof record.reported !== "boolean" || !count(record.measured) || !count(record.unmeasured))
    return undefined;
  return { reported: record.reported, measured: record.measured, unmeasured: record.unmeasured };
}

/**
 * Adds one of a child's own delegation results, as its session recorded it. Undefined when the values cannot be
 * accounted at all, which makes the child's whole observation invalid rather than partly counted.
 */
export function addDelegationResult(
  previous: ObservedChildUsage | undefined,
  value: { usage?: unknown; details?: unknown },
): ObservedChildUsage | undefined {
  const usage = value.usage === undefined ? undefined : usageTotals(value.usage);
  if (value.usage !== undefined && !usage) return undefined;
  const record = childUsageRecord(object(value.details)?.childUsage);
  let { measured, unmeasured } = previous ?? { measured: 0, unmeasured: 0 };
  if (!record) unmeasured += 1;
  else if (record.reported && !usage) unmeasured += record.measured + record.unmeasured;
  else {
    measured += record.measured;
    unmeasured += record.unmeasured;
  }
  const total = usage ? addUsage(previous?.usage, usage) : previous?.usage;
  if (!count(measured) || !count(unmeasured) || !finite(total)) return undefined;
  return { ...(total ? { usage: total } : {}), measured, unmeasured };
}

/** One settled child: its own calls when observed, plus what its delegation results reported. */
export function observedChildUsage(observation: {
  usage?: ChildUsageTotals;
  delegated?: ObservedChildUsage;
}): ObservedChildUsage {
  const { usage: own, delegated } = observation;
  const usage = own && delegated?.usage ? addUsage(own, delegated.usage) : (own ?? delegated?.usage);
  return observed(usage, (own ? 1 : 0) + (delegated?.measured ?? 0), (own ? 0 : 1) + (delegated?.unmeasured ?? 0));
}

/**
 * The two tool-result fields: Pi's `usage` when any child's usage was observed, and `details.childUsage`.
 * A reused operation started nothing in this call; the call that ran it already reported its usage.
 */
export function delegationUsage(
  outcomes: readonly { observedUsage?: ObservedChildUsage; operation?: { reused?: boolean } }[],
): { usage?: ChildUsageTotals; childUsage: ChildUsageRecord } {
  let usage: ChildUsageTotals | undefined,
    measured = 0,
    unmeasured = 0;
  for (const { observedUsage, operation } of outcomes) {
    if (operation?.reused || !observedUsage) continue;
    measured += observedUsage.measured;
    unmeasured += observedUsage.unmeasured;
    if (observedUsage.usage) usage = addUsage(usage, observedUsage.usage);
  }
  const total = observed(usage, measured, unmeasured);
  const coverage = total.unmeasured === 0 ? "complete" : total.measured > 0 ? "partial" : "unavailable";
  return {
    ...(total.usage ? { usage: total.usage } : {}),
    childUsage: {
      reported: total.usage !== undefined,
      measured: total.measured,
      unmeasured: total.unmeasured,
      coverage,
    },
  };
}

const thrown = new WeakMap<object, ObservedChildUsage>();
/** A child that ran and then threw keeps its observation on the error, so a fan-out that reports it can count it. */
export function withObservedUsage<T>(error: T, usage: ObservedChildUsage): T {
  if (error !== null && typeof error === "object") thrown.set(error, usage);
  return error;
}
export function observedUsageOf(error: unknown): ObservedChildUsage | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const own = thrown.get(error);
  if (own || !(error instanceof AggregateError)) return own;
  for (const inner of error.errors) {
    const found = observedUsageOf(inner);
    if (found) return found;
  }
  return undefined;
}

/**
 * The host-side check, read from this Pi session's own record: how many of its delegation results reported child
 * usage, and how many of those the host kept on the persisted tool result, which is what its totals sum.
 */
export function childUsageInSession(
  entries: readonly unknown[],
): { results: number; recorded: number; cost: number } | undefined {
  let results = 0,
    recorded = 0,
    cost = 0;
  for (const entry of entries) {
    const message = object(object(entry)?.type === "message" ? object(entry)!.message : undefined);
    if (message?.role !== "toolResult" || !DELEGATION_RESULT_TOOLS.has(String(message.toolName))) continue;
    if (!childUsageRecord(object(message.details)?.childUsage)?.reported) continue;
    results += 1;
    const usage = usageTotals(message.usage);
    if (!usage) continue;
    recorded += 1;
    cost += usage.cost.total;
  }
  return results > 0 && Number.isFinite(cost) ? { results, recorded, cost } : undefined;
}
