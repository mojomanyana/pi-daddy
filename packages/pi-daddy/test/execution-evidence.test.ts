import assert from "node:assert/strict";
import { test } from "node:test";
import { executionEvidenceContent } from "../extensions/execution-evidence.ts";
import type { DelegationOutcome } from "../extensions/execute-child.ts";
import type { CapturedWorkerIdentity } from "../src/kernel/captured-worker-contract.ts";
import { evidenceFromProvider, providerToolOutput } from "./execution-evidence-fixture.ts";
const identity: CapturedWorkerIdentity = {
  revision: 1,
  executionId: "exec:fixture",
  nonce: "nonce-fixture",
  root: "/owned/fixture",
  rootDevice: "1",
  rootInode: "2",
  bootId: "boot-fixture",
  pidNamespace: "ns-fixture",
  helperPid: 123,
  helperStartTicks: "456",
  helperSha256: "a".repeat(64),
  workerPid: 789,
  ownershipPath: "/owned/fixture/ownership.json",
  receiptPath: "/owned/fixture/receipt.json",
};
const outcome = (): DelegationOutcome => ({
  ok: true,
  text: "exact authored final\n  ",
  granted: [],
  depth: 1,
  exitCode: 0,
  work: "succeeded",
  final: {
    state: "complete",
    text: "exact authored final\n  ",
    sessionId: "session-fixture",
    messageId: "message-fixture",
    leafId: "leaf-fixture",
    sha256: "b".repeat(64),
  },
  cleanup: {
    state: "settled",
    identity,
    receipt: { state: "settled", identity, workerCode: 0, workerSignal: 0, reason: "worker-exit", reapedAll: true },
  },
  observation: { state: "complete", reasons: [] },
  retention: { status: "disabled", manifestPath: null },
});

test("provider conversion drops UI details; allowlisted content preserves the complete process receipt", () => {
  const source = outcome();
  source.diagnostics = "PRIVATE_DIAGNOSTICS";
  source.retention = { status: "retained", manifestPath: "/PRIVATE_SESSION_ARCHIVE" };
  Object.assign(source.final!, { privateReasoning: "PRIVATE_REASONING" });
  Object.assign(source.cleanup!, { privateExtra: "PRIVATE_CLEANUP_EXTRA" });
  const before = structuredClone(source);
  const authored = { type: "text" as const, text: source.text };
  const old = providerToolOutput({ content: [authored], details: source });
  assert.equal(old, source.text);
  assert.ok(!old.includes("session-fixture"));
  const result = { content: [authored, executionEvidenceContent("delegate", [source], 1)], details: source };
  const wire = providerToolOutput(result),
    evidence = evidenceFromProvider(result);
  assert.ok(wire.startsWith(source.text + "\n"));
  assert.equal(evidence.version, 1);
  assert.equal(evidence.tool, "delegate");
  assert.deepEqual(evidence.outcomes[0].cleanup, {
    state: "settled",
    identity,
    receipt: { state: "settled", identity, workerCode: 0, workerSignal: 0, reason: "worker-exit", reapedAll: true },
  });
  assert.deepEqual(evidence.outcomes[0].final, {
    state: "complete",
    sessionId: "session-fixture",
    messageId: "message-fixture",
    leafId: "leaf-fixture",
    sha256: "b".repeat(64),
  });
  assert.deepEqual(evidence.outcomes[0].observation, source.observation);
  assert.deepEqual(evidence.outcomes[0].retention, { status: "retained" });
  assert.doesNotMatch(wire, /PRIVATE_/);
  assert.deepEqual(source, before, "rendering must not mutate the structured outcome");
});

test("failed, missing and unknown dimensions never become success in model-visible evidence", () => {
  const unknown: DelegationOutcome = {
    ...outcome(),
    ok: false,
    work: "unknown",
    control: "failed",
    reason: "cleanup unavailable",
    exitCode: null,
    timedOut: true,
    aborted: true,
    truncated: true,
    spawnFailed: false,
    final: { state: "unavailable", reason: "terminal unavailable", diagnosticText: "PRIVATE_PARTIAL_FINAL" },
    cleanup: { state: "unknown", identity, reason: "receipt unavailable" },
    observation: { state: "incomplete", reasons: ["observation lost"] },
  };
  const absent: DelegationOutcome = {
    ok: false,
    text: "",
    granted: [],
    depth: 1,
    exitCode: null,
    reason: "pre-launch refusal",
  };
  const result = { content: [executionEvidenceContent("delegate_all", [unknown, absent], 2)], isError: true };
  const evidence = evidenceFromProvider(result);
  assert.deepEqual(evidence.outcomes[0].cleanup, unknown.cleanup);
  assert.deepEqual(evidence.outcomes[0].observation, unknown.observation);
  assert.equal(evidence.outcomes[0].ok, false);
  assert.equal(evidence.outcomes[0].work, "unknown");
  assert.equal(evidence.outcomes[0].control, "failed");
  assert.equal(evidence.outcomes[0].timedOut, true);
  assert.equal(evidence.outcomes[0].truncated, true);
  assert.equal(evidence.outcomes[0].aborted, true);
  for (const key of ["work", "control", "final", "cleanup", "observation", "retention", "timedOut"])
    assert.equal(evidence.outcomes[1][key], null, key);
  assert.doesNotMatch(providerToolOutput(result), /PRIVATE_PARTIAL_FINAL/);
});

test("a stopped chain reports only actual outcomes and keeps not-started cleanup explicit", () => {
  const stopped = {
    ...outcome(),
    ok: false,
    cleanup: { state: "not-started" as const, reason: "worker not launched" },
  };
  const evidence = evidenceFromProvider({ content: [executionEvidenceContent("delegate_chain", [stopped], 3)] });
  assert.equal(evidence.requested, 3);
  assert.equal(evidence.outcomes.length, 1);
  assert.equal(evidence.outcomes[0].ordinal, 1);
  assert.deepEqual(evidence.outcomes[0].cleanup, stopped.cleanup);
});
