import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { after, test } from "node:test";
import {
  appendLedgerEvent,
  appendRecord,
  buildChildLifecycleEvent,
  buildRecord,
  verifyLedger,
} from "../src/ledger.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const executionId = "exec:00000000-0000-4000-8000-000000000001";
const parentExecutionId = "exec:00000000-0000-4000-8000-000000000000";
const resolved = { effective: ["tool:read"], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] };
const base = {
  parentId: "d0",
  childId: "d0.1",
  depth: 1,
  requested: ["tool:read"],
  parentGrant: ["tool:read"],
  result: resolved,
  blocked: false,
  executor: "process" as const,
  taskDigest: "a".repeat(64),
  now: new Date("2026-08-28T12:00:00.000Z"),
};

test("a v3 capability decision requires unique and explicit parent execution identity", () => {
  assert.throws(() => buildRecord(base), /executionId/);
  assert.throws(() => buildRecord({ ...base, executionId }), /parentExecutionId/);
  const record = buildRecord({ ...base, executionId, parentExecutionId });
  assert.equal(record.ledgerVersion, 3);
  assert.equal(record.executionId, executionId);
  assert.equal(record.parentExecutionId, parentExecutionId);
  assert.equal(record.childId, "d0.1");
});

test("public v3 builders refuse free text in fields classified as display identifiers", () => {
  assert.throws(() => buildRecord({
    ...base, executionId, parentExecutionId: null, agentType: "SECRET TASK TEXT",
  }), /invalid ledger v3 event/i);
  assert.throws(() => buildChildLifecycleEvent({
    executionId, parentExecutionId, childId: "d0.1", state: "running", executor: "herdr",
    deadlineAt: "2026-08-28T12:10:00.000Z", herdrPaneId: "SECRET OUTPUT TEXT",
    herdrAgentName: "review-d0-1", now: base.now,
  }), /invalid ledger v3 event/i);
});

test("a root delegation records parentExecutionId null explicitly", () => {
  const record = buildRecord({ ...base, executionId, parentExecutionId: null });
  assert.ok(Object.hasOwn(record, "parentExecutionId"));
  assert.equal(record.parentExecutionId, null);
});

test("a non-terminal lifecycle must carry one contract-valid RFC 3339 deadline", () => {
  assert.throws(() => buildChildLifecycleEvent({
    executionId, parentExecutionId, childId: "d0.1", state: "starting", executor: "process", now: base.now,
  }), /deadlineAt/);
  assert.throws(() => buildChildLifecycleEvent({
    executionId, parentExecutionId, childId: "d0.1", state: "starting", executor: "process",
    deadlineAt: "1", now: base.now,
  }), /RFC 3339/);
});

test("Herdr runtime identity is paired and cannot be attached to a process executor", () => {
  const identity = {
    executionId, parentExecutionId, childId: "d0.1", state: "running" as const,
    deadlineAt: "2026-08-28T12:10:00.000Z", now: base.now,
  };
  assert.throws(() => buildChildLifecycleEvent({
    ...identity, executor: "process", herdrPaneId: "w1:p2", herdrAgentName: "review-d0-1",
  }), /Herdr runtime identity/);
  assert.throws(() => buildChildLifecycleEvent({
    ...identity, executor: "herdr", herdrPaneId: "w1:p2",
  }), /paired/);
});

test("lifecycle events join by execution id and may carry a Herdr focus identity", () => {
  const event = buildChildLifecycleEvent({
    executionId,
    parentExecutionId,
    childId: "d0.1",
    state: "running",
    executor: "herdr",
    deadlineAt: "2026-08-28T12:10:00.000Z",
    herdrPaneId: "w1:p2",
    herdrAgentName: "review-d0-1",
    now: new Date("2026-08-28T12:00:01.000Z"),
  });
  assert.equal(event.ledgerVersion, 3);
  assert.equal(event.executionId, executionId);
  assert.equal(event.herdrPaneId, "w1:p2");
});

test("the reader accepts v3 beside historical v2 while rejecting malformed v3 identity", async () => {
  const path = join(await tempDir("ledger-v3-"), "ledger.jsonl");
  await appendRecord({ path }, buildRecord({ ...base, executionId, parentExecutionId: null }));
  await appendLedgerEvent({ path }, buildChildLifecycleEvent({
    executionId,
    parentExecutionId: null,
    childId: "d0.1",
    state: "completed",
    executor: "process",
    exitCode: 0,
    signal: null,
    now: new Date("2026-08-28T12:00:02.000Z"),
  }));
  const report = await verifyLedger(path);
  assert.equal(report.ok, true);
  assert.equal(report.records, 1);
  assert.deepEqual(report.lifecycle, { starting: 0, running: 0, completed: 1, failed: 0 });
});

test("the integrity reader never retains raw corrupt ledger content", async () => {
  const path = join(await tempDir("ledger-v3-private-corruption-"), "ledger.jsonl");
  const secret = "SECRET_TASK=rotate-production-token";
  await writeFile(path, `${secret} {not-json\n`, "utf8");

  const report = await verifyLedger(path);
  assert.equal(report.ok, false);
  assert.deepEqual(report.corrupt, [{ line: 1, reason: "invalid ledger line" }]);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
});

test("the integrity reader rejects lookalike v3 and malformed nested fields", async () => {
  const path = join(await tempDir("ledger-v3-invalid-"), "ledger.jsonl");
  await writeFile(path, [
    JSON.stringify({
      ledgerVersion: "3",
      event: "child_lifecycle",
      ts: "not-rfc3339",
      childId: "d0.1",
      state: "starting",
      executor: "process",
    }),
    JSON.stringify({
      ...buildRecord({ ...base, executionId, parentExecutionId: null }),
      correlation: { run_id: "run-1", phase: 42 },
    }),
  ].join("\n") + "\n", "utf8");

  const report = await verifyLedger(path);
  assert.equal(report.ok, false);
  assert.deepEqual(report.corrupt.map((entry) => entry.line), [1, 2]);
  assert.equal(report.records, 0);
  assert.deepEqual(report.lifecycle, { starting: 0, running: 0, completed: 0, failed: 0 });
});
