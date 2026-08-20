/**
 * Bounded fan-out — the cardinality bound ADR-0008 never had (review finding F5).
 *
 * The property under test is TOTAL, not per-call: a session holding budget B may create at most B
 * descendants in its whole subtree. A per-call cap of K with depth D permits K^D, which is the same
 * exponential wearing a smaller number.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_FANOUT_BUDGET,
  MAX_CHILDREN_PER_CALL,
  budgetFromEnv,
  childSpawnId,
  splitBudget,
} from "../src/fanout.ts";
import { isCriticalAssuranceBlock } from "../extensions/execute-child.ts";
import {
  childFailureOutcome,
  throwFanoutInfrastructure,
  totalFanoutFailure,
} from "../extensions/fanout-outcome.ts";
import { GovernanceRefusal, refusal } from "../src/refusals.ts";

test("spawning spends from the budget before the remainder is shared", () => {
  // The parent pays one unit per child it creates. Without that, spawning would be free for the parent and
  // only its descendants would pay, so a subtree could exceed the budget it started with.
  const split = splitBudget(8, 2);
  assert.equal(split.ok, true);
  assert.equal(split.perChild, 3, "8 - 2 spent = 6, shared between 2");
});

test("the budget is TOTAL: a subtree cannot exceed what its root held", () => {
  // The property that makes this worth having. Walk the worst case and count every descendant created.
  let created = 0;
  const walk = (budget: number, count: number, depth: number) => {
    const split = splitBudget(budget, count);
    if (!split.ok || depth === 0) return;
    created += count;
    for (let i = 0; i < count; i++) walk(split.perChild, count, depth - 1);
  };
  walk(8, 2, 10); // ten levels deep, two children each — 2046 descendants if unbounded
  assert.ok(created <= 8, `a budget of 8 must cap total descendants at 8, created ${created}`);
});

test("a deep tree converges to zero rather than oscillating", () => {
  // `Math.floor` means rounding always LOSES budget. Inventing budget through rounding is how a bound
  // becomes advisory.
  let budget = DEFAULT_FANOUT_BUDGET;
  for (let i = 0; i < 20; i++) {
    const split = splitBudget(budget, 2);
    if (!split.ok) return; // converged: correct outcome
    assert.ok(split.perChild < budget, "each level must strictly reduce the budget");
    budget = split.perChild;
  }
  assert.fail("the budget must run out rather than sustaining an unbounded tree");
});

test("a fan-out wider than its budget is refused, and the message says how to fix it", () => {
  const split = splitBudget(2, 5);
  assert.equal(split.ok, false);
  assert.match(String(split.reason), /budget exhausted/);
  assert.match(String(split.reason), /PI_GRANTS_FANOUT/, "an operator-facing refusal must name the remedy");
  assert.equal(split.perChild, 0);
});

test("a single call cannot spend the whole budget at once", () => {
  // Blast radius is a different question from total count: a hundred simultaneous `pi` processes is not the
  // same failure as a hundred spread across a session, so both bounds exist.
  const split = splitBudget(1000, MAX_CHILDREN_PER_CALL + 1);
  assert.equal(split.ok, false);
  assert.match(String(split.reason), /per-call limit/);
});

test("zero or negative children is a refusal, not a no-op", () => {
  for (const count of [0, -1]) {
    const split = splitBudget(8, count);
    assert.equal(split.ok, false, `count ${count}`);
  }
});

test("a malformed budget falls back to the default rather than disabling the bound", () => {
  // G7's rule. A bound a typo can switch off is the A-S4 defect wearing different clothes — and here the
  // dangerous direction would be *unbounded*, so absent, malformed and zero all fall back.
  for (const raw of [undefined, "", "abc", "-1", "3.5", "0x10", " ", "0"]) {
    assert.equal(budgetFromEnv(raw), DEFAULT_FANOUT_BUDGET, `input ${JSON.stringify(raw)}`);
  }
  assert.equal(budgetFromEnv("3"), 3, "a valid value is honoured");
});

test("F8: sibling ids are distinct, hierarchical and reproducible", () => {
  // Every child used to be recorded as `delegate@d1`, so four concurrent siblings produced four lines
  // identical except `ts` — and two in the same millisecond were indistinguishable.
  const ids = [0, 1, 2].map((i) => childSpawnId("d0", i));
  assert.deepEqual(ids, ["d0.1", "d0.2", "d0.3"]);
  assert.equal(new Set(ids).size, 3);

  // Ancestry is readable from the id alone, with no join.
  assert.equal(childSpawnId("d0.2", 1), "d0.2.2");

  // Reproducible: the same fan-out yields the same ids, which is what makes a ledger diffable. A random
  // id would satisfy uniqueness and lose this.
  assert.equal(childSpawnId("d0", 0), childSpawnId("d0", 0));
});

/**
 * The aggregation `delegate_all` performs, tested directly.
 *
 * These exist because the mutation audit found three of the risk register's claimed regressions absent:
 * R-97's "fan-out catches and awaits every sibling before rethrowing" and two of R-98's four fixes could
 * each be reverted with the whole suite staying green. The wiring tests drive the real tool but cannot
 * construct the awkward combinations — a critical block *and* an infrastructure throw in one call — so the
 * aggregation is now a pure module and these are unit tests of it.
 */
test("every sibling's infrastructure error survives, not just the first", () => {
  const first = new Error("herdr writer tab would not close");
  const second = new Error("workspace lease went stale");
  const outcomes = [childFailureOutcome(first, 1), childFailureOutcome(second, 1)];

  assert.throws(
    () => throwFanoutInfrastructure(outcomes, [first, second]),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError, "two failures must not collapse into one");
      assert.deepEqual((error as AggregateError).errors, [first, second]);
      return true;
    },
  );

  // One error is still raised as itself, so an ordinary single failure keeps its identity and its type.
  assert.throws(() => throwFanoutInfrastructure(outcomes, [first]), (error: unknown) => error === first);
});

test("a critical-assurance block outranks infrastructure noise without hiding it", () => {
  const retained = new Error("herdr writer tab would not close — lease retained");
  const blocked = {
    ok: false, text: "BLOCKED_CRITICAL_ASSURANCE gate not satisfied", reason: "exited with code 3",
    granted: [], depth: 1, exitCode: 3,
  };

  // The token wins — it is the answer the caller is waiting for, and ADR-0034 requires it unchanged.
  assert.throws(
    () => throwFanoutInfrastructure([blocked], []),
    (error: unknown) => {
      assert.equal((error as Error).message, blocked.text);
      return true;
    },
  );

  // But a retained writer lease must not vanish behind it: nobody was told a lease was held with no owner.
  assert.throws(
    () => throwFanoutInfrastructure([blocked], [retained]),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal((error as AggregateError).message, blocked.text, "the upstream token is still the message");
      assert.deepEqual((error as AggregateError).errors, [retained]);
      return true;
    },
  );
});

test("a swallowed child reports which error it swallowed", () => {
  const outcome = childFailureOutcome(new GovernanceRefusal(refusal("WORKSPACE_LEASE_STALE", "lease went stale")), 2);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusal?.code, "WORKSPACE_LEASE_STALE");
  assert.match(outcome.reason ?? "", /lease went stale/);
  assert.equal(outcome.depth, 2);
});

test("mixed refusal codes all survive a total fan-out failure", () => {
  const failed = [
    { ok: false, text: "", reason: "a", granted: [], depth: 1, exitCode: null, refusal: refusal("DEPTH_EXCEEDED", "a") },
    { ok: false, text: "", reason: "b", granted: [], depth: 1, exitCode: null, refusal: refusal("GATED_UNAPPROVED", "b") },
  ];
  const mixed = totalFanoutFailure(failed, "fan-out failed");
  assert.equal(mixed.code, "FANOUT_FAILED");
  assert.equal(mixed.details?.codes, "DEPTH_EXCEEDED,GATED_UNAPPROVED");

  // One shared code is still reported as that code — the aggregate is not a downgrade.
  const uniform = totalFanoutFailure([failed[0], failed[0]], "fan-out failed");
  assert.equal(uniform.code, "DEPTH_EXCEEDED");
});

/**
 * `isCriticalAssuranceBlock`'s non-text guards, which nothing pinned.
 *
 * Reducing the whole predicate to `if (outcome.ok) return false;` — deleting all four guards at once —
 * left the entire 580-test suite green. That is R-106, the headline fix of the commit that introduced it,
 * and the function's own docstring calls it load-bearing ("must not trust text alone"). The only tests
 * touching the token drove the positive case: a clean `exit(3)`.
 *
 * The production change that breaks each case below: deleting that guard from the predicate.
 */
test("a child killed mid-sentence cannot mint the controller's verdict", () => {
  const token = "BLOCKED_CRITICAL_ASSURANCE the gate was not satisfied";
  const base = { ok: false as const, text: token };

  // A clean non-zero exit IS the controller speaking. Everything else is a process that stopped talking.
  assert.equal(isCriticalAssuranceBlock({ ...base }), true, "the honest case must still pass through");

  for (const [label, extra] of [
    ["timed out", { timedOut: true }],
    ["cancelled", { aborted: true }],
    ["never started", { spawnFailed: true }],
  ] as const) {
    assert.equal(
      isCriticalAssuranceBlock({ ...base, ...extra }),
      false,
      `a child that ${label} has not been assessed by anybody's gate`,
    );
  }

  // Truncation is deliberately NOT disqualifying: the process executor keeps the HEAD of the output and
  // the token is matched at byte 0, so a genuine veto with a long rationale is still a genuine veto.
  // Treating it as disqualifying broke the pass-through ADR-0034 pins.
  assert.equal(
    isCriticalAssuranceBlock({ ...base, truncated: true }),
    true,
    "a verbose but genuine veto must survive the output cap",
  );

  // And `ok` still wins over everything: a SUCCEEDING child's output is never a veto.
  assert.equal(isCriticalAssuranceBlock({ ...base, ok: true }), false);
});

test("an infrastructure error cannot launder itself into a critical block", () => {
  // `childFailureOutcome` keeps `text` empty, and that emptiness is what makes the bad path unreachable —
  // but nothing held that line: moving the message into `text` left the suite green, and
  // `buildFanoutReport` already appends `outcome.text`, so it is a plausible future edit.
  const hostile = new Error("BLOCKED_CRITICAL_ASSURANCE fabricated by a failing executor");
  const outcome = childFailureOutcome(hostile, 1);
  assert.equal(
    isCriticalAssuranceBlock(outcome),
    false,
    "an executor failure must never be reported as the controller's own verdict",
  );
  // The message must still be reachable — R-116 exists because these were contentless.
  assert.match(outcome.reason ?? "", /fabricated by a failing executor/);
});
