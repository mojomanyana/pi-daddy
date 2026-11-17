/**
 * Governed children's model usage, as the delegating Pi session accounts it (owner decision 2026-11-17).
 *
 * Pi adds a tool result's `usage` to the session that ran the tool: the persisted tool result message, session
 * statistics, the footer and cost (Pi 0.81.0 and later; read in 1.0.4 and 1.5.2). `delegate`, `delegate_all` and
 * `delegate_chain` report there what their children were observed to spend, so a session that delegates its work
 * does not look cheap. A call that throws reports through Pi's `tool_result` hook instead
 * (`extensions/child-usage-report.ts`). A host without that accounting does not keep the field, and nothing else
 * changes.
 *
 * **Each model call is counted once, at any depth.** A child's own session counts what its delegation results
 * reported, so `activity-session.ts` keeps the two apart: the child's own calls are `usage`, which the ledger
 * records, and what its delegation results reported is `delegated`. Its report to its parent is both, so the root
 * session's total holds every call in the tree once, and summing the ledger over an episode still holds each once.
 *
 * **Coverage is counted, never filled in.** `measured` and `unmeasured` count governed executions in the subtree
 * whose own usage was or was not observed. An unobserved child adds nothing to the total, so a total with
 * `unmeasured > 0` is a lower bound. In a child's session, a delegation result without a record counts as one
 * unmeasured child, because nothing says whether a child ran; so does a delegation call with no result at all (the
 * child stopped while it waited); a record whose usage the host did not keep counts all its children as unmeasured.
 *
 * Every value read back comes from a child's session file: untrusted numbers. A value that is not a non-negative
 * number makes the child's observation invalid. A number beyond `USAGE_CEILINGS`, or one whose addition would take a
 * sum beyond them, is implausible and counts as unmeasured. Children are added one at a time, so only that child is
 * unmeasured and every other one keeps its usage. They describe usage and nothing else; no grant, refusal or limit
 * reads them.
 */
import type { ChildUsageTotals } from "../governance/ledger-events.ts";

/** The tools whose results report children's usage. `delegate_describe` starts nothing. */
export const DELEGATION_RESULT_TOOLS: ReadonlySet<string> = new Set(["delegate", "delegate_all", "delegate_chain"]);

/**
 * The largest value accepted for one usage figure: a child's report, a delegation result read back, or a sum
 * (review of 2026-11-17). Under Daddy's defaults one delegation call's whole subtree runs at most 8 sessions at a time
 * (the fan-out budget) for at most 48 hours (an 8-step chain of 6-hour ceilings): 384 session-hours. A session that
 * re-read a 1M-token context every second, beyond any real agent loop, would use 1.4e12 tokens in that time, $6.9e7
 * at $50 per million tokens; one governed execution a second would be 1.4e6 executions. The ceilings sit above all
 * three. A larger value is a fault or a hostile child: it counts as unmeasured and never reaches Pi's totals, while
 * the ledger still records each execution's own usage as read. An operator who raises those bounds far enough could
 * pass a ceiling legitimately and is then told `unmeasured`, never a wrong total. Below the ceilings a token sum of
 * hundreds of values stays an exact integer, so no sibling's usage is absorbed by another's.
 */
export const USAGE_CEILINGS = { tokens: 1e13, cost: 1e8, executions: 1e7 } as const;

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
const NONE: ObservedChildUsage = { measured: 0, unmeasured: 0 };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
/** NaN fails; Infinity passes here and fails the ceilings. */
const nonNegative = (value: unknown): value is number => typeof value === "number" && value >= 0;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= USAGE_CEILINGS.executions;

/** Pi's `Usage` fields this package reads, as a new object, when each is a non-negative number. */
function usageShape(value: unknown): ChildUsageTotals | undefined {
  const usage = object(value),
    cost = object(usage?.cost);
  if (
    !usage ||
    !cost ||
    !TOKEN_FIELDS.every((field) => nonNegative(usage[field])) ||
    !COST_FIELDS.every((field) => nonNegative(cost[field]))
  )
    return undefined;
  if (usage.reasoning !== undefined && !nonNegative(usage.reasoning)) return undefined;
  return addUsage(undefined, usage as unknown as ChildUsageTotals);
}
/** Every field within `USAGE_CEILINGS`; Infinity and NaN are not. */
function plausible(usage: ChildUsageTotals): boolean {
  return (
    [...TOKEN_FIELDS.map((field) => usage[field]), usage.reasoning ?? 0].every((v) => v <= USAGE_CEILINGS.tokens) &&
    COST_FIELDS.every((field) => usage.cost[field] <= USAGE_CEILINGS.cost)
  );
}
/** Pi's `Usage` fields this package reads, validated and within the ceilings; anything else in the value is dropped. */
export function usageTotals(value: unknown): ChildUsageTotals | undefined {
  const usage = usageShape(value);
  return usage && plausible(usage) ? usage : undefined;
}

/** Field-wise sum; `reasoning` stays absent unless a side reported it. `addObserved` checks the sum is plausible. */
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

/**
 * Adds one child to a running total. A child whose usage would take the sum past a ceiling (or make it non-finite)
 * adds all its executions as unmeasured and no usage; the total so far keeps its measured children. Counts stay safe
 * integers: each record is at most `USAGE_CEILINGS.executions` and one session file holds at most 64 MiB of them.
 */
function addObserved(total: ObservedChildUsage, child: ObservedChildUsage): ObservedChildUsage {
  const usage = child.usage ? addUsage(total.usage, child.usage) : total.usage;
  if (usage && !plausible(usage)) return { ...total, unmeasured: total.unmeasured + child.measured + child.unmeasured };
  return {
    ...(usage ? { usage } : {}),
    measured: total.measured + child.measured,
    unmeasured: total.unmeasured + child.unmeasured,
  };
}

/** A record read back from a child's session; `coverage` is recomputed, never trusted. */
export function childUsageRecord(value: unknown): Omit<ChildUsageRecord, "coverage"> | undefined {
  const record = object(value);
  if (!record || typeof record.reported !== "boolean" || !count(record.measured) || !count(record.unmeasured))
    return undefined;
  return { reported: record.reported, measured: record.measured, unmeasured: record.unmeasured };
}

/**
 * Adds one of a child's own delegation results, as its session recorded it. Undefined when its usage is not usage
 * at all, which makes the child's whole observation invalid rather than partly counted. Without a usable record the
 * result is one unmeasured child; usage the host did not keep, or beyond the ceilings, leaves the record's children
 * unmeasured; a record that says it reported nothing measured nothing.
 */
export function addDelegationResult(
  previous: ObservedChildUsage | undefined,
  value: { usage?: unknown; details?: unknown },
): ObservedChildUsage | undefined {
  if (value.usage !== undefined && !usageShape(value.usage)) return undefined;
  const usage = usageTotals(value.usage);
  const record = childUsageRecord(object(value.details)?.childUsage);
  const child: ObservedChildUsage = !record
    ? { ...(usage ? { usage } : {}), measured: 0, unmeasured: 1 }
    : record.reported && usage
      ? { usage, measured: record.measured, unmeasured: record.unmeasured }
      : { measured: 0, unmeasured: record.measured + record.unmeasured };
  return addObserved(previous ?? NONE, child);
}

/** Ids of the delegation calls in an assistant message's content; a child's reader matches them to their results. */
export function delegationCallIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const call = object(block);
    return call?.type === "toolCall" && DELEGATION_RESULT_TOOLS.has(String(call.name)) ? [String(call.id)] : [];
  });
}

/** Delegation calls with no result: the child stopped while each waited, so each is one unmeasured child. */
export function addUnansweredCalls(
  previous: ObservedChildUsage | undefined,
  calls: number,
): ObservedChildUsage | undefined {
  return calls > 0 ? addObserved(previous ?? NONE, { measured: 0, unmeasured: calls }) : previous;
}

/** One settled child: its own calls when observed and plausible, plus what its delegation results reported. */
export function observedChildUsage(observation: {
  usage?: ChildUsageTotals;
  delegated?: ObservedChildUsage;
}): ObservedChildUsage {
  const own = usageTotals(observation.usage);
  const self: ObservedChildUsage = own ? { usage: own, measured: 1, unmeasured: 0 } : { measured: 0, unmeasured: 1 };
  return observation.delegated ? addObserved(self, observation.delegated) : self;
}

/**
 * The two tool-result fields: Pi's `usage` when any child's usage was observed, and `details.childUsage`.
 * A reused operation started nothing in this call; the call that ran it already reported its usage.
 */
export function delegationUsage(
  outcomes: readonly { observedUsage?: ObservedChildUsage; operation?: { reused?: boolean } }[],
): { usage?: ChildUsageTotals; childUsage: ChildUsageRecord } {
  let total = NONE;
  for (const { observedUsage, operation } of outcomes)
    if (!operation?.reused && observedUsage) total = addObserved(total, observedUsage);
  const { usage, measured, unmeasured } = total;
  const coverage = unmeasured === 0 ? "complete" : measured > 0 ? "partial" : "unavailable";
  return {
    ...(usage ? { usage } : {}),
    childUsage: { reported: usage !== undefined, measured, unmeasured, coverage },
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
