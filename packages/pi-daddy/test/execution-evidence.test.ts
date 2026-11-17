import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  executionEvidence,
  executionEvidenceContent,
  executionEvidenceSummary,
} from "../extensions/execution-evidence.ts";
import type { DelegationOutcome } from "../extensions/execute-child.ts";
import { publicEvidenceCall } from "../extensions/public-evidence.ts";
import { createPublicEvidenceOwner } from "../src/products/public-evidence.ts";
import type { CapturedWorkerIdentity } from "../src/kernel/captured-worker-contract.ts";
import { EVIDENCE_INTRODUCTION, evidenceFromProvider, providerToolOutput } from "./execution-evidence-fixture.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
const identity: CapturedWorkerIdentity = {
  revision: 1,
  executionId: "exec:fixture",
  nonce: "nonce-fixture",
  root: "/owned/fixture",
  rootDevice: "device-fixture",
  rootInode: "inode-fixture",
  bootId: "boot-fixture",
  pidNamespace: "ns-fixture",
  helperPid: 424242,
  helperStartTicks: "ticks-fixture",
  helperSha256: "a".repeat(64),
  workerPid: 737373,
  ownershipPath: "/owned/fixture/ownership.json",
  receiptPath: "/owned/fixture/receipt.json",
};
const receipt = {
  state: "settled" as const,
  identity,
  workerCode: 0 as number | null,
  workerSignal: 0,
  reason: "worker-exit" as const,
  reapedAll: true as const,
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
  cleanup: { state: "settled", identity, receipt },
  observation: { state: "complete", reasons: [] },
  retention: { status: "disabled", manifestPath: null },
});
const bound = { executionId: "exec:fixture" };
const settled = { state: "settled", identity: bound };
const complete = { state: "complete" };
/** What the coordinating model reads without capture: the last block, through Pi's real provider conversion. */
const summarized = (
  outcomes: DelegationOutcome[],
  tool: Parameters<typeof executionEvidenceContent>[0] = "delegate_all",
) => evidenceFromProvider({ content: [executionEvidenceContent(tool, outcomes, outcomes.length)] }).outcomes;

// Replaces "provider conversion drops UI details; allowlisted content preserves the complete process receipt".
// By the owner's decision of 2026-11-17 the model receives a summary and the complete receipt stays in details.
// Breaks if a receipt field, a path or a session identity returns to model-visible content, if the summary stops
// naming the execution its cleanup is bound to, or if rendering changes the outcome that details carry.
test("provider conversion drops UI details; the model receives the version 2 summary, details keep the receipt", () => {
  const source = outcome();
  source.cwd = "/work/fixture";
  source.workspaceId = "workspace-fixture";
  source.diagnostics = "PRIVATE_DIAGNOSTICS";
  source.retention = { status: "retained", manifestPath: "/PRIVATE_SESSION_ARCHIVE" };
  Object.assign(source.final!, { privateReasoning: "PRIVATE_REASONING" });
  Object.assign(source.cleanup!, { privateExtra: "PRIVATE_CLEANUP_EXTRA" });
  const before = structuredClone(source);
  const authored = { type: "text" as const, text: source.text };
  assert.equal(providerToolOutput({ content: [authored], details: source }), source.text);
  const result = {
    content: [authored, executionEvidenceContent("delegate", [source], 1)],
    details: source,
  };
  const wire = providerToolOutput(result);
  assert.equal(
    wire,
    source.text +
      "\n" +
      EVIDENCE_INTRODUCTION[2] +
      '{"version":2,"tool":"delegate","requested":1,"outcomes":[{"ordinal":1,"ok":true,"work":"succeeded",' +
      '"final":{"state":"complete"},"cleanup":{"state":"settled","identity":{"executionId":"exec:fixture"}}}]}' +
      "\n```",
  );
  const { executionId: _shown, revision: _revision, ...hostFacts } = identity;
  const withheld = [
    ...Object.values(hostFacts).map(String),
    ...["session-fixture", "message-fixture", "leaf-fixture", "b".repeat(64)],
    ...["/work/fixture", "workspace-fixture", "PRIVATE_", "reapedAll", "worker-exit", "/"],
  ];
  assert.equal(withheld.length, 22);
  for (const text of withheld) assert.ok(!wire.slice(source.text.length).includes(text), `${text} reached the model`);
  assert.deepEqual(source, before, "rendering must not mutate the structured outcome kept in details");
  assert.deepEqual(result.details.cleanup, {
    state: "settled",
    identity,
    receipt,
    privateExtra: "PRIVATE_CLEANUP_EXTRA",
  });
});

// Breaks if public capture stops recording the complete version 1 projection, if that projection loses or gains a
// field, or if the captured response stops being exactly the summary of it that the model received.
test("public capture records the complete version 1 projection beside the summary the model received", async () => {
  const source = outcome();
  source.cwd = "/work/fixture";
  source.diagnostics = "PRIVATE_DIAGNOSTICS";
  source.retention = { status: "retained", manifestPath: "/PRIVATE_SESSION_ARCHIVE" };
  Object.assign(source.final!, { privateReasoning: "PRIVATE_REASONING" });
  Object.assign(source.cleanup!, { privateExtra: "PRIVATE_CLEANUP_EXTRA" });
  // Capture checks the attributed final bytes against the native hash, so this one is real.
  const sha256 = createHash("sha256").update(source.text).digest("hex");
  Object.assign(source.final!, { sha256 });
  const full = executionEvidence("delegate", [source], 1);
  assert.deepEqual(full, {
    version: 1,
    tool: "delegate",
    requested: 1,
    outcomes: [
      {
        ordinal: 1,
        cwd: "/work/fixture",
        workspaceId: null,
        operation: null,
        ok: true,
        work: "succeeded",
        control: null,
        reason: null,
        exitCode: 0,
        timedOut: null,
        aborted: null,
        truncated: null,
        spawnFailed: null,
        final: {
          state: "complete",
          sessionId: "session-fixture",
          messageId: "message-fixture",
          leafId: "leaf-fixture",
          sha256,
        },
        cleanup: { state: "settled", identity, receipt },
        observation: { state: "complete", reasons: [] },
        retention: { status: "retained" },
      },
    ],
  });
  const root = await tempDir("evidence-capture-");
  const capture = publicEvidenceCall(
    createPublicEvidenceOwner(root),
    "call-evidence",
    "delegate",
    [{}],
    ["exec:fixture"],
  );
  const content = [{ type: "text" as const, text: source.text }, executionEvidenceContent("delegate", [source], 1)];
  const result = capture.finish({ isError: false, content, details: source }, [source]);
  const status = JSON.parse(result.content.at(-1)!.text.slice("Public evidence capture: ".length));
  assert.equal(status.status, "captured");
  const manifest = JSON.parse(await readFile(status.ref.path, "utf8"));
  assert.deepEqual(manifest.runtimeEvidence, full);
  const response = JSON.parse(await readFile(manifest.response.path, "utf8"));
  assert.deepEqual(response.content, content);
  assert.deepEqual(evidenceFromProvider(response), executionEvidenceSummary(manifest.runtimeEvidence));
  assert.doesNotMatch(JSON.stringify(response), /nonce-fixture|session-fixture|PRIVATE_/);
});

// Breaks if the reader forgets the introduction that was produced before the summary existed.
test("content recorded with the version 1 block still parses, and both versions answer at the same paths", () => {
  const source = outcome();
  const authored = { type: "text" as const, text: source.text };
  const recorded = {
    type: "text" as const,
    text: EVIDENCE_INTRODUCTION[1] + JSON.stringify(executionEvidence("delegate", [source], 1)) + "\n```",
  };
  const old = evidenceFromProvider({ content: [authored, recorded] });
  assert.equal(old.version, 1);
  assert.deepEqual(old.outcomes[0].cleanup, { state: "settled", identity, receipt });
  assert.equal(old.outcomes[0].final.sessionId, "session-fixture");
  const current = evidenceFromProvider({
    content: [authored, executionEvidenceContent("delegate", [source], 1)],
  });
  assert.equal(current.version, 2);
  for (const evidence of [old, current]) {
    assert.deepEqual([evidence.tool, evidence.requested, evidence.outcomes.length], ["delegate", 1, 1]);
    const [only] = evidence.outcomes;
    assert.deepEqual([only.ordinal, only.ok, only.work], [1, true, "succeeded"]);
    assert.deepEqual([only.final.state, only.cleanup.state], ["complete", "settled"]);
    assert.equal(only.cleanup.identity.executionId, "exec:fixture");
  }
  // A resumed conversation can hold both; the reader takes the last block, whichever version it is.
  const summary = executionEvidenceContent("delegate", [], 1);
  assert.equal(evidenceFromProvider({ content: [recorded, summary] }).version, 2);
  assert.equal(evidenceFromProvider({ content: [summary, recorded] }).version, 1);
  assert.throws(() => evidenceFromProvider({ content: [authored] }), /must contain runtime evidence/);
});

const why = {
  uncertain: "the sub-agent has unverified subtree cleanup: helper closed without matching durable settlement receipt",
  timeout: "the sub-agent ran past its 30 minute(s) ceiling and was killed (PI_DADDY_CHILD_TIMEOUT sets it in seconds)",
  cancelled: "the sub-agent was cancelled",
  spawn: "the sub-agent could not be started: ownership directory unavailable before helper launch: Error: EACCES",
  noFinal: "the sub-agent has no attributable complete final: terminal unavailable",
};
const noFinal = { state: "unavailable" as const, reason: "terminal unavailable" };
const stopped = { ok: false, exitCode: null, timedOut: false, aborted: false, truncated: false, spawnFailed: false };
const cancelledReceipt = { ...receipt, workerCode: null, workerSignal: 15, reason: "cancelled" as const };
const operation = {
  operationId: "principal:" + "c".repeat(64),
  executionId: "exec:fixture",
  state: "settled" as const,
  cwd: "/work/fixture",
  workspaceId: null,
  startedAt: "2026-11-17T00:00:00.000Z",
  updatedAt: "2026-11-17T00:00:01.000Z",
};
const cited = { operationId: operation.operationId };
const reference = { ok: false, text: "No new child started.", granted: [], depth: 1, exitCode: null };
/** Each state a coordinator must tell apart, shaped as `execute-child.ts` returns it, with its exact summary. */
const states: Array<{ name: string; outcome: DelegationOutcome; summary: Record<string, unknown> }> = [
  {
    name: "completed and settled",
    outcome: outcome(),
    summary: { ok: true, work: "succeeded", final: complete, cleanup: settled },
  },
  {
    name: "completed but cleanup uncertain",
    outcome: {
      ...outcome(),
      ...stopped,
      exitCode: 0,
      control: "failed",
      reason: why.uncertain,
      cleanup: { state: "unknown", identity, reason: "helper closed without matching durable settlement receipt" },
    },
    summary: {
      ok: false,
      work: "succeeded",
      control: "failed",
      reason: why.uncertain,
      final: complete,
      cleanup: {
        state: "unknown",
        identity: bound,
        reason: "helper closed without matching durable settlement receipt",
      },
    },
  },
  {
    name: "timed out",
    outcome: {
      ...outcome(),
      ...stopped,
      work: "failed",
      reason: why.timeout,
      timedOut: true,
      final: noFinal,
      cleanup: { state: "settled", identity, receipt: cancelledReceipt },
    },
    summary: { ok: false, work: "failed", reason: why.timeout, timedOut: true, final: noFinal, cleanup: settled },
  },
  {
    name: "aborted",
    outcome: {
      ...outcome(),
      ...stopped,
      work: "failed",
      reason: why.cancelled,
      aborted: true,
      final: noFinal,
      cleanup: { state: "settled", identity, receipt: cancelledReceipt },
    },
    summary: { ok: false, work: "failed", reason: why.cancelled, aborted: true, final: noFinal, cleanup: settled },
  },
  {
    name: "spawn failed",
    outcome: {
      ...outcome(),
      ...stopped,
      work: "failed",
      reason: why.spawn,
      spawnFailed: true,
      final: { state: "unavailable", reason: "ownership directory unavailable" },
      cleanup: { state: "not-started", reason: "ownership directory unavailable" },
    },
    summary: {
      ok: false,
      work: "failed",
      reason: why.spawn,
      spawnFailed: true,
      final: { state: "unavailable", reason: "ownership directory unavailable" },
      cleanup: { state: "not-started", reason: "ownership directory unavailable" },
    },
  },
  {
    name: "truncated final",
    outcome: { ...outcome(), truncated: true },
    summary: { ok: true, work: "succeeded", truncated: true, final: complete, cleanup: settled },
  },
  {
    name: "no attributable final",
    outcome: { ...outcome(), ...stopped, exitCode: 0, work: "unknown", reason: why.noFinal, final: noFinal },
    summary: { ok: false, work: "unknown", reason: why.noFinal, final: noFinal, cleanup: settled },
  },
  {
    name: "non-zero exit",
    outcome: { ...outcome(), ...stopped, exitCode: 3, work: "failed", reason: "the sub-agent exited with code 3" },
    summary: {
      ok: false,
      work: "failed",
      reason: "the sub-agent exited with code 3",
      exitCode: 3,
      final: complete,
      cleanup: settled,
    },
  },
  {
    name: "worker killed by a signal",
    outcome: {
      ...outcome(),
      ...stopped,
      work: "failed",
      reason: "the sub-agent exited with code null",
      final: noFinal,
      cleanup: { state: "settled", identity, receipt: { ...receipt, workerCode: null, workerSignal: 9 } },
    },
    summary: {
      ok: false,
      work: "failed",
      reason: "the sub-agent exited with code null",
      final: noFinal,
      cleanup: settled,
    },
  },
  {
    name: "completed and settled, but its workspace release failed",
    outcome: { ...outcome(), control: "failed", reason: "workspace release is lost" },
    summary: {
      ok: true,
      work: "succeeded",
      control: "failed",
      reason: "workspace release is lost",
      final: complete,
      cleanup: settled,
    },
  },
  {
    name: "worker not launched",
    outcome: { ...outcome(), ok: false, cleanup: { state: "not-started", reason: "worker not launched" } },
    summary: {
      ok: false,
      work: "succeeded",
      final: complete,
      cleanup: { state: "not-started", reason: "worker not launched" },
    },
  },
  {
    name: "refused before launch",
    outcome: { ok: false, text: "", granted: [], depth: 1, exitCode: null, reason: "pre-launch refusal" },
    summary: { ok: false, work: null, reason: "pre-launch refusal", final: null, cleanup: null, observation: null },
  },
  {
    name: "optional observation incomplete",
    outcome: {
      ...outcome(),
      reason: "child lifecycle record failed: Error: disk full",
      observation: { state: "incomplete", reasons: ["child lifecycle record failed: Error: disk full"] },
    },
    summary: {
      ok: true,
      work: "succeeded",
      reason: "child lifecycle record failed: Error: disk full",
      final: complete,
      cleanup: settled,
      observation: { state: "incomplete" },
    },
  },
  {
    name: "diagnostic retention lost",
    outcome: { ...outcome(), retention: { status: "lost", manifestPath: null } },
    summary: { ok: true, work: "succeeded", final: complete, cleanup: settled, retention: { status: "lost" } },
  },
  {
    name: "own operation, settled",
    outcome: { ...outcome(), operation: { ...operation, reused: false } },
    summary: {
      operation: { ...cited, state: "settled" },
      ok: true,
      work: "succeeded",
      final: complete,
      cleanup: { state: "settled" },
    },
  },
  {
    name: "own operation, status update failed after settlement",
    outcome: {
      ...outcome(),
      control: "failed",
      reason: "operation status update failed: Error: Operation owner mismatch",
      operation: { ...operation, state: "uncertain", reused: false },
    },
    summary: {
      operation: { ...cited, state: "uncertain" },
      ok: true,
      work: "succeeded",
      control: "failed",
      reason: "operation status update failed: Error: Operation owner mismatch",
      final: complete,
      cleanup: { state: "settled" },
    },
  },
  {
    name: "own operation, never started",
    outcome: {
      ...reference,
      reason: "the workspace is leased to another writer",
      operation: { ...operation, state: "not-started", reused: false },
    },
    summary: {
      operation: { ...cited, state: "not-started" },
      ok: false,
      work: null,
      reason: "the workspace is leased to another writer",
      final: null,
      cleanup: null,
      observation: null,
    },
  },
  {
    name: "reference to a running operation",
    outcome: {
      ...reference,
      work: "unknown",
      reason: "existing-operation",
      operation: { ...operation, state: "running", reused: true },
    },
    summary: {
      operation: { ...cited, state: "running", reused: true },
      ok: false,
      work: "unknown",
      reason: "existing-operation",
      final: null,
      cleanup: null,
      observation: null,
    },
  },
  {
    name: "reference to an operation that ended uncertain after failed work",
    outcome: {
      ...reference,
      work: "unknown",
      reason: "operation-already-ended",
      operation: {
        ...operation,
        state: "uncertain",
        reused: true,
        runtime: {
          work: "failed",
          control: "failed",
          final: { state: "complete", sessionId: "session-fixture", sha256: "b".repeat(64) },
          cleanup: { state: "unknown", receiptPath: "/owned/fixture/receipt.json", executionId: "exec:fixture" },
        },
      },
    },
    summary: {
      operation: {
        ...cited,
        state: "uncertain",
        reused: true,
        runtime: { work: "failed", control: "failed", final: complete, cleanup: { state: "unknown" } },
      },
      ok: false,
      work: "unknown",
      reason: "operation-already-ended",
      final: null,
      cleanup: null,
      observation: null,
    },
  },
];

// The six states the coordinator's instructions rely on come first; the rest are the neighbours they could be
// mistaken for. Breaks if a summary drops the field that separates one state from another, or leaks a host fact.
test("every failure and uncertainty keeps its own summary without relying on prose", () => {
  assert.deepEqual(
    states.slice(0, 6).map((state) => state.name),
    [
      "completed and settled",
      "completed but cleanup uncertain",
      "timed out",
      "aborted",
      "spawn failed",
      "truncated final",
    ],
  );
  const summaries = summarized(states.map((state) => state.outcome));
  for (const [index, state] of states.entries())
    assert.deepEqual(summaries[index], { ordinal: index + 1, ...state.summary }, state.name);
  // Compare what a reader decides on: everything except the position and the outcome's free-text reason.
  const decisive = summaries.map(({ ordinal: _ordinal, reason: _reason, ...rest }: Record<string, unknown>) =>
    JSON.stringify(rest),
  );
  assert.equal(new Set(decisive).size, states.length, "two different states read the same without their prose");
  const wire = JSON.stringify(summaries);
  for (const text of ["/owned", "/work", "session-fixture", "nonce-fixture", "boot-fixture", "424242", "737373"])
    assert.ok(!wire.includes(text), `${text} reached the model`);
});

// Breaks if the summary invents a value, renames a key or reads a field the complete allowlist does not hold.
test("every summary value is copied from the complete projection at the same path", () => {
  const full = executionEvidence(
    "delegate_all",
    states.map((state) => state.outcome),
    states.length,
  );
  const summary = executionEvidenceSummary(full);
  assert.deepEqual([summary.version, summary.tool, summary.requested], [2, full.tool, full.requested]);
  let leaves = 0;
  const walk = (value: unknown, source: unknown, path: string) => {
    if (value !== null && typeof value === "object") {
      assert.ok(source !== null && typeof source === "object", `${path} has no complete counterpart`);
      for (const [key, child] of Object.entries(value))
        walk(child, (source as Record<string, unknown>)[key], `${path}.${key}`);
      return;
    }
    leaves += 1;
    assert.equal(value, source, path);
  };
  walk(summary.outcomes, full.outcomes, "outcomes");
  assert.equal(leaves, 158);
});

// Breaks if a long diagnostic is repeated whole, cut inside a character, or cut without saying so.
test("reasons are bounded to 160 characters and say when they were cut", () => {
  const exact = "r".repeat(160);
  const long = "a".repeat(158) + "🌱" + "b".repeat(100);
  const cut = "a".repeat(158) + "🌱…";
  assert.equal(Array.from(cut).length, 160);
  const [kept, clipped, notStarted] = summarized([
    { ...outcome(), reason: exact, final: { state: "unavailable", reason: exact } },
    {
      ...outcome(),
      reason: long,
      final: { state: "unavailable", reason: long, diagnosticText: "PRIVATE_PARTIAL_FINAL" },
      cleanup: { state: "unknown", reason: long },
    },
    { ...outcome(), cleanup: { state: "not-started", reason: long } },
  ]);
  assert.deepEqual([kept.reason, kept.final.reason], [exact, exact]);
  assert.deepEqual([clipped.reason, clipped.final.reason, clipped.cleanup.reason], [cut, cut, cut]);
  assert.equal(notStarted.cleanup.reason, cut);
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
  const result = {
    content: [executionEvidenceContent("delegate_all", [unknown, absent], 2)],
    isError: true,
  };
  const evidence = evidenceFromProvider(result);
  assert.deepEqual(evidence.outcomes[0], {
    ordinal: 1,
    ok: false,
    work: "unknown",
    control: "failed",
    reason: "cleanup unavailable",
    timedOut: true,
    aborted: true,
    truncated: true,
    final: { state: "unavailable", reason: "terminal unavailable" },
    cleanup: { state: "unknown", identity: bound, reason: "receipt unavailable" },
    observation: { state: "incomplete" },
  });
  // The dimensions a coordinator judges by stay explicit nulls; nothing absent reads as a good state.
  assert.deepEqual(evidence.outcomes[1], {
    ordinal: 2,
    ok: false,
    work: null,
    reason: "pre-launch refusal",
    final: null,
    cleanup: null,
    observation: null,
  });
  assert.doesNotMatch(providerToolOutput(result), /PRIVATE_PARTIAL_FINAL/);
});

test("a stopped chain reports only actual outcomes and keeps not-started cleanup explicit", () => {
  const stopped = {
    ...outcome(),
    ok: false,
    cleanup: { state: "not-started" as const, reason: "worker not launched" },
  };
  const evidence = evidenceFromProvider({
    content: [executionEvidenceContent("delegate_chain", [stopped], 3)],
  });
  assert.equal(evidence.requested, 3);
  assert.equal(evidence.outcomes.length, 1);
  assert.equal(evidence.outcomes[0].ordinal, 1);
  assert.deepEqual(evidence.outcomes[0].cleanup, stopped.cleanup);
});

// The decision rests on Pi keeping tool result details in the session file while provider conversion drops them.
// Breaks if Pi stopped persisting details, or if the summary block were the only copy of the receipt there.
test("Pi persists the complete receipt in the tool result details that provider conversion withholds", async () => {
  const root = await tempDir("evidence-session-");
  await chmod(root, 0o700);
  const manager = SessionManager.create(root, root);
  manager.appendMessage({ role: "user", content: "fixture", timestamp: 1788888888000 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-evidence", name: "delegate", arguments: {} }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    stopReason: "toolUse",
    timestamp: 1788888888001,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const source = outcome();
  const content = [{ type: "text" as const, text: source.text }, executionEvidenceContent("delegate", [source], 1)];
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-evidence",
    toolName: "delegate",
    content,
    details: source as never,
    isError: false,
    timestamp: 1788888888002,
  });
  const lines = (await readFile(manager.getSessionFile()!, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const persisted = lines.find((line) => line.message?.role === "toolResult").message;
  assert.deepEqual(persisted.details.cleanup, { state: "settled", identity, receipt });
  assert.deepEqual(persisted.details, JSON.parse(JSON.stringify(source)));
  assert.deepEqual(persisted.content, content);
  const wire = providerToolOutput({ content: persisted.content, details: persisted.details });
  assert.ok(!wire.includes("nonce-fixture") && !wire.includes("session-fixture"));
  assert.equal(evidenceFromProvider({ content: persisted.content }).version, 2);
});
