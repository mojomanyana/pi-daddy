import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITY_NAMESPACE_PREFIXES } from "../src/kernel/capabilities.ts";
import { isLedgerCapabilityIdentifier } from "../src/kernel/ledger-identifiers.ts";
import { validateLedgerV3Event } from "../src/governance/ledger-v3-validation.ts";

/**
 * The ledger must accept every capability namespace the kernel can produce.
 *
 * **This is the test that was missing, and its absence cost a whole namespace.** ADR-0078 added `context:` to
 * the kernel's prefixes and the ledger kept its own copy of the list, so `context:summary` was not a valid
 * ledger capability identifier. Every capability-decision event validates six capability arrays with that
 * predicate, and a ledger write that throws DENIES the delegation — so a session whose grant held any
 * `context:` id could not delegate at all. What the operator saw named neither the namespace nor the list:
 *
 *   delegation refused: grants: ledger write failed, denying — TypeError: invalid ledger v3 event:
 *   capability decision requested must contain capability identifiers
 *
 * **The production change that breaks this:** adding a namespace to `CAPABILITY_NAMESPACE_PREFIXES` without
 * the ledger following, or restating the list in `ledger-identifiers.ts` instead of importing it.
 */
test("every capability namespace the kernel defines is a valid ledger identifier", () => {
  for (const prefix of CAPABILITY_NAMESPACE_PREFIXES) {
    const id = `${prefix}example`;
    assert.equal(
      isLedgerCapabilityIdentifier(id),
      true,
      `${id} is a capability the kernel can put in a grant, so the ledger must be able to record it`,
    );
  }
});

test("a capability decision carrying a context: id validates", () => {
  // The end-to-end shape of the outage: the id reaches `requested` and `parentGrant`, and the whole event is
  // rejected. Breaks by: reverting the prefix list.
  const event = {
    ledgerVersion: 3,
    event: "capability_decision",
    ts: "2026-09-23T00:00:00.000Z",
    executionId: "exec:00000000-0000-4000-8000-000000000001",
    parentExecutionId: null,
    parentId: "root",
    childId: "d0.1",
    depth: 0,
    requested: ["tool:read", "context:summary"],
    parentGrant: ["tool:read", "tool:delegate", "context:summary"],
    effective: ["tool:read", "context:summary"],
    denied: [],
    clipped: [],
    gatedBlocked: [],
    blocked: false,
    executor: "process",
    taskDigest: "a".repeat(64),
  };
  assert.equal(
    validateLedgerV3Event(event),
    null,
    "a decision naming a context handoff mode must be recordable, or the delegation is denied",
  );
});
