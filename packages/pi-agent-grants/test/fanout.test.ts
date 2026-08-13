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
