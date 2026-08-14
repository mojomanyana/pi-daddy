/**
 * Bounded synchronous fan-out — ADR-0015's option A′, and the cardinality bound ADR-0008 never had.
 *
 * **The gap this closes.** ADR-0008 bounds what each child may *hold* and says nothing about how many
 * children exist. `resolve()` is a set operation; nowhere in `src/` was there a count. Blocking `delegate`
 * bounded cardinality to one *by accident of being blocking*, so the invariant was never tested. Fan-out
 * removes that accident: with `maxDepth: 2` and five children per call, five delegators each spawning five
 * is thirty concurrent model sessions — **every ledger line individually correct and narrow, the aggregate
 * a machine DoS and an uncapped bill.** The critic's verdict on this was that silence is itself a finding.
 *
 * **Why a budget rather than a per-call limit.** A per-call cap of K with depth D still permits K^D
 * descendants, which is the same exponential wearing a smaller number. A *budget* is subtractive and
 * therefore total: a session holding budget B may create at most B descendants in its whole subtree,
 * because it spends from B to spawn and hands each child a share of what is left. That composes across
 * process boundaries with **no shared state** — the same property that makes depth work — so it needs no
 * registry, no lock and no counter file.
 *
 * It is deliberately NOT a concurrency limit. How many run at once is a resource question for the executor;
 * how many may exist at all is a governance question, and this is the governance answer.
 */

import { parseBound } from "./propagation.ts";

/** Total descendants a session may create across its entire subtree, when nothing is configured. */
export const DEFAULT_FANOUT_BUDGET = 8;

/**
 * Hard ceiling on children in a single call, independent of budget.
 *
 * A budget alone would let one call spend all of it at once, and a hundred simultaneous `pi` processes is
 * a different failure from a hundred spread over a session. This is the blast-radius bound; the budget is
 * the total bound. Both are needed because they answer different questions.
 */
export const MAX_CHILDREN_PER_CALL = 8;

/** Read the budget from the environment, failing to the default on absent *or* malformed input. */
export function budgetFromEnv(raw: string | undefined): number {
  const parsed = parseBound(raw);
  // Malformed and zero both fall back rather than disabling fan-out silently — G7's rule. A budget that a
  // typo can switch off is the A-S4 defect wearing different clothes. To genuinely forbid delegation an
  // operator sets `maxDepth: 0`, which says what it means.
  return parsed === undefined || parsed === null || parsed === 0 ? DEFAULT_FANOUT_BUDGET : parsed;
}

export interface BudgetSplit {
  ok: boolean;
  reason?: string;
  /** Budget each child receives. */
  perChild: number;
}

/**
 * Spend `count` from a budget and divide the remainder among the children.
 *
 * The parent pays one unit per child it creates *before* sharing what is left, so a subtree can never
 * exceed the budget it started with: spawning is itself an expenditure, not a free act that only its
 * descendants pay for. `Math.floor` on the division means rounding always loses budget rather than
 * inventing it — the safe direction, and the reason a deep tree converges to zero instead of oscillating.
 */
export function splitBudget(budget: number, count: number): BudgetSplit {
  if (count <= 0) return { ok: false, reason: "a fan-out needs at least one child", perChild: 0 };
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
        `(raise PI_GRANTS_FANOUT at the root, or delegate fewer at a time)`,
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
