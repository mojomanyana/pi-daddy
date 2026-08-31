import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  appendLedgerEvent,
  appendRecord,
  buildChildLifecycleEvent,
  buildRecord,
  buildWorkspaceLeaseEvent,
  verifyLedger,
} from "../src/ledger.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const result = { effective: ["tool:read"], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] };

test("ledger v3 capability decisions carry correlation, trusted digests, identity and refusal separately", () => {
  const record = buildRecord({
    executionId: "exec:00000000-0000-4000-8000-000000000001", parentExecutionId: null,
    parentId: "d0", childId: "d0.1", depth: 1, requested: ["tool:read"], parentGrant: ["tool:read"],
    result, blocked: true, reason: "workspace busy", executor: "process", now: new Date("2026-08-19T20:00:00Z"),
    taskDigest: "a".repeat(64),
    correlation: { schema_version: "1.0", run_id: "run-1", task_digest: "b".repeat(64), head_sha: "c".repeat(40), tree_sha: "d".repeat(40) },
    refusal: { code: "WORKSPACE_WRITE_CONFLICT", message: "workspace busy" },
    approved: ["tool:read"], approvalSources: { "tool:read": "persisted" },
    approvalScopes: { "tool:read": "always" },
    approvalExpiresAt: { "tool:read": "2026-09-18T20:00:00.000Z" },
    approvalUses: { "tool:read": { max: 1, remaining: 0 } },
  });
  assert.equal(record.ledgerVersion, 3);
  assert.equal(record.event, "capability_decision");
  assert.equal(record.taskDigest, "a".repeat(64));
  assert.equal(record.correlation?.task_digest, "b".repeat(64));
  assert.equal(record.refusal?.code, "WORKSPACE_WRITE_CONFLICT");
  assert.equal(record.approvalExpiresAt?.["tool:read"], "2026-09-18T20:00:00.000Z");
  assert.deepEqual(record.approvalUses?.["tool:read"], { max: 1, remaining: 0 });
});

test("lease and lifecycle events append without being counted as capability records", async () => {
  const path = join(await tempDir("runtime-ledger-"), "ledger.jsonl");
  const identity = {
    executionId: "exec:00000000-0000-4000-8000-000000000001",
    parentExecutionId: null,
  };
  const base = { ...identity, childId: "d0.1", workspaceId: "w1", root: "/work/tree", access: "write" as const, now: new Date() };
  await appendLedgerEvent({ path }, buildWorkspaceLeaseEvent({ ...base, outcome: "acquired", recovered: false }));
  await appendRecord({ path }, buildRecord({
    ...identity, parentId: "d0", childId: "d0.1", depth: 1, requested: ["tool:read"], parentGrant: ["tool:read"],
    result, blocked: false, executor: "process", taskDigest: "a".repeat(64), now: new Date(),
  }));
  await appendLedgerEvent({ path }, buildChildLifecycleEvent({
    ...identity, childId: "d0.1", state: "completed", executor: "process", exitCode: 0, signal: null,
    timedOut: false, aborted: false, truncated: false, now: new Date(),
  }));
  await appendLedgerEvent({ path }, buildWorkspaceLeaseEvent({ ...base, outcome: "released", releaseReason: "completed" }));

  const report = await verifyLedger(path);
  assert.equal(report.ok, true);
  assert.equal(report.records, 1);
  assert.equal(report.events, 4);
  assert.deepEqual(report.workspaceLeases, {
    acquired: 1, uncontended: 0, refused: 0, released: 1, releasedUnrecorded: 0,
    lost: 0, retained: 0, timeout: 0, recovered: 0,
  });
  assert.deepEqual(report.lifecycle, { starting: 0, running: 0, completed: 1, failed: 0 });
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 4);
});

test("invalid versioned lines and unsupported explicit versions are corrupt rather than legacy", async () => {
  const path = join(await tempDir("runtime-ledger-invalid-v2-"), "ledger.jsonl");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, [
    { ledgerVersion: 2, event: "child_lifecycle", ts: new Date().toISOString(), state: "completed" },
    { ledgerVersion: 2, event: "capability_decision", ts: new Date().toISOString(), parentId: "d0", childId: "d0.1", executor: "process", denied: [] },
    { ledgerVersion: 2, event: "check_receipt", ts: new Date().toISOString(), childId: "c1", receiptId: "r", workspaceId: "w", checkId: "x" },
    { ledgerVersion: 2, denied: [] },
    { ledgerVersion: 4, event: "capability_decision", ts: new Date().toISOString(), parentId: "d0", childId: "d0.1", executor: "process", taskDigest: "a".repeat(64), requested: [], parentGrant: [], effective: [], denied: [], clipped: [], gatedBlocked: [], depth: 1, blocked: false },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const report = await verifyLedger(path);
  assert.equal(report.ok, false);
  assert.equal(report.corrupt.length, 5);
  assert.deepEqual(report.lifecycle, { starting: 0, running: 0, completed: 0, failed: 0 });
});

test("legacy grant records remain readable beside v2 events", async () => {
  const path = join(await tempDir("runtime-ledger-legacy-"), "ledger.jsonl");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `${JSON.stringify({ denied: [], requested: [], parentGrant: [], effective: [], clipped: [], gatedBlocked: [], blocked: false })}\n`);
  const report = await verifyLedger(path);
  assert.equal(report.ok, true);
  assert.equal(report.records, 1);
  assert.equal(report.events, 1);
});
