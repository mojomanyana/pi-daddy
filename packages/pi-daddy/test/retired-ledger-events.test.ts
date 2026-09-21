import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyLedger } from "../src/governance/ledger-report.ts";
import { parseDashboardLedger } from "../src/products/dashboard-projection.ts";
import { RETIRED_LEDGER_EVENT_KINDS, validateLedgerV3Event } from "../src/governance/ledger-v3-validation.ts";
import { recordKindForEvent } from "../src/governance/ledger.ts";
import { recordLines } from "./record-fixtures.ts";
import { buildLedgerV3ContractFixtures } from "../scripts/generate-ledger-record-contract.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after } from "node:test";

after(cleanupTempDirs);

// 0.31.0 deleted the check runner and workflow facts. A ledger is append-only, so lines 0.30.0 wrote with those kinds
// are still valid history and must never read as corruption after an upgrade. Review finding on the big cleanup:
// both readers reported the package's own 0.30.0 fixture ledger as corrupt. Production change that breaks this test:
// removing a kind from RETIRED_LEDGER_EVENT_KINDS, or a reader treating a retired kind as unknown.
const executionId = "exec:00000000-0000-4000-8000-000000000001";
const ts = "2026-08-28T12:00:00.000Z";
const receipt = {
  ledgerVersion: 3,
  event: "check_receipt",
  ts,
  executionId,
  parentExecutionId: null,
  childId: "check:x",
  receiptId: "2".repeat(64),
  workspaceId: "w",
  checkId: "x",
  treeSha: "tree",
};
const fact = {
  ledgerVersion: 3,
  event: "workflow_fact",
  ts,
  factId: "fact:00000000-0000-4000-8000-000000000003",
  source: "principal-pi-skills",
  provenance: "planned",
  kind: "workflow_phase",
  subject: "review",
  state: "pending",
  correlation: { run_id: "run-1" },
};
const decision = buildLedgerV3ContractFixtures()["capability-decision.json"];

test("ledger lines of a retired event kind are valid history for both readers, never corruption", async () => {
  for (const event of [receipt, fact]) {
    assert.ok(RETIRED_LEDGER_EVENT_KINDS.has(event.event));
    assert.equal(validateLedgerV3Event(event), null, `${event.event} must validate as written`);
  }
  const text = recordLines(decision, receipt, fact);
  const projection = parseDashboardLedger(text, { now: new Date(Date.parse(decision.ts) + 5 * 60_000) });
  assert.deepEqual(projection.corrupt, []);
  assert.equal(projection.orphanEvents, 2, "retired kinds are counted, not projected as tree nodes");
  assert.equal(projection.nodes.length, 1);

  const dir = await tempDir("retired-ledger-");
  const path = join(dir, "grants.jsonl");
  await writeFile(path, text, "utf8");
  const report = await verifyLedger(path);
  assert.deepEqual(report.corrupt, []);
  assert.equal(report.retired, 2);
  assert.equal(report.events, 3);
});

test("a pre-format ledger import keeps the envelope kind a retired event had", () => {
  assert.equal(recordKindForEvent(receipt), "check");
  assert.equal(recordKindForEvent(fact), "fact");
  assert.equal(recordKindForEvent({}), "capability");
});
