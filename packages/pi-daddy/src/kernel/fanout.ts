/** Active descendant allocation arithmetic. Enforcement requires the shared owner allocator in capacity.ts. */
import { parseBound } from "./propagation.ts";
import { GovernanceRefusal, refusal } from "./refusals.ts";

/** Active descendant allowance, excluding the owner session, when nothing is configured. */
export const DEFAULT_FANOUT_BUDGET = 8;

/**
 * Hard ceiling on children in a single call, independent of budget.
 *
 * A budget alone would let one call spend all of it at once, and a hundred simultaneous `pi` processes is
 * a different failure from a hundred spread over a session. The owner allocator also conserves active
 * capacity across overlapping calls.
 */
export const MAX_CHILDREN_PER_CALL = 8;

/**
 * Steps a single `delegate_chain` may contain — ADR-0033.
 *
 * **Derived from `MAX_CHILDREN_PER_CALL` so the two cannot drift.** A chain is not concurrent, so the blast-radius
 * argument for that constant does not apply directly; what does apply is that one tool call should not be able to
 * create an unbounded number of descendants, and eight is already a long pipeline. Sharing the number also means an
 * operator learns one bound rather than two.
 */
export const MAX_CHAIN_STEPS = MAX_CHILDREN_PER_CALL;

/** Absent uses the existing default; explicit zero stays exhausted and malformed input refuses. */
export function budgetFromEnv(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_FANOUT_BUDGET;
  const parsed = parseBound(raw);
  if (parsed === null || parsed === undefined)
    throw new GovernanceRefusal(
      refusal("FANOUT_EXCEEDED", "PI_DADDY_FANOUT must be a non-negative safe decimal integer"),
    );
  return parsed;
}
export interface BudgetSplit {
  ok: boolean;
  reason?: string;
  /** Budget each child receives. */
  perChild: number;
}

/**
 * Propose disjoint child allowances from currently available capacity; this does not reserve anything.
 *
 * The parent pays one unit per child it creates *before* sharing what is left, so a subtree can never
 * exceed the budget it started with: spawning is itself an expenditure, not a free act that only its
 * descendants pay for. `Math.floor` on the division means rounding always loses budget rather than
 * inventing it — the safe direction, and the reason a deep tree converges to zero instead of oscillating.
 */
export function splitBudget(budget: number, count: number): BudgetSplit {
  if (!Number.isSafeInteger(budget) || budget < 0)
    return { ok: false, reason: "capacity must be a non-negative safe integer", perChild: 0 };
  if (!Number.isSafeInteger(count) || count <= 0)
    return { ok: false, reason: "a fan-out needs at least one child", perChild: 0 };
  if (count > MAX_CHILDREN_PER_CALL) {
    return {
      ok: false,
      reason: `${count} children exceeds the per-call limit of ${MAX_CHILDREN_PER_CALL}`,
      perChild: 0,
    };
  }
  if (budget < count) {
    return {
      ok: false,
      reason:
        `fan-out budget exhausted: ${count} children requested, ${budget} remaining in this subtree ` +
        `(raise PI_DADDY_FANOUT at the root, or delegate fewer at a time)`,
      perChild: 0,
    };
  }
  return { ok: true, perChild: Math.floor((budget - count) / count) };
}

/**
 * A ledger id that distinguishes siblings.
 *
 * **Review finding F8.** Every child was recorded as `delegate@d1`, so four concurrent children produced
 * four lines identical except `ts` — and two landing in the same millisecond were indistinguishable.
 * ADR-0008 names `parent_id`/`child_id` as the correlation keys, but they were depth *labels* wearing id
 * names, which made the ledger unjoinable to the returned result, to the OS process, or to the child's own
 * lines one level down.
 *
 * The id is hierarchical and derived, not random: a child of `d0` is `d0.1`, its own second child `d0.1.2`.
 * That means a line's ancestry is readable from the id alone with no join at all, and it is reproducible —
 * two runs of the same fan-out produce the same ids, which is what makes a ledger diffable.
 */
export function childSpawnId(parentId: string, index: number): string {
  return `${parentId}.${index + 1}`;
}
