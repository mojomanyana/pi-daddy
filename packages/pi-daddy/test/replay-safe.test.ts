/**
 * Replay-safe children (owner decision 2026-11-17, "Read-only work, once"): the pure kernel decision and the
 * composition step that runs the one retry. Wiring through the real tools is `replay-retry-wiring.test.ts`.
 *
 * Production changes that break this file: widening `REPLAY_SAFE_TOOLS` or the context exception, treating an
 * undeclared or pattern ceiling as safe, dropping or reordering any guard in `replayRetryDecision`, classifying a
 * cancellation, an answered child or a non-transient spawn fault as retryable, retrying without a fresh execution
 * identity or capacity reservation, or losing the first attempt when the retry cannot start; marking a stable
 * operation's failure replayable when any other guard refuses, or not marking it when none does; starting a retry
 * after the parent was cancelled during capacity reconciliation.
 */
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { ceilingForDefinition, type SkillDefinition } from "../src/kernel/definitions.ts";
import {
  REPLAY_SAFE_TOOLS,
  replayableFailure,
  replayRetryDecision,
  replayRetrySwitch,
  replaySafe,
  replaySafeCeiling,
  type ReplayAttempt,
  type ReplayRetryFacts,
} from "../src/kernel/replay-safe.ts";
import { createCapacityAllocator } from "../src/kernel/capacity.ts";
import { ENV_CHILD_IDLE_TIMEOUT, ENV_REPLAY_RETRY } from "../src/kernel/env-names.ts";
import { GovernanceRefusal, refusal } from "../src/kernel/refusals.ts";
import { replayIfSafe, type ReplayRun } from "../extensions/replay-retry.ts";
import { executePlannedChild } from "../extensions/execute-child.ts";
import { grantsCommand } from "../extensions/grants-command.ts";
import { planWithApprovals } from "../extensions/run-delegation.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { classifyToolNames, makeCatalog } from "../src/kernel/catalog.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { executionEvidence, executionEvidenceSummary } from "../extensions/execution-evidence.ts";
import { buildRecord } from "../src/governance/ledger.ts";
import { validateLedgerV3Event } from "../src/governance/ledger-v3-validation.ts";
import type { DelegationOutcome } from "../extensions/execute-child.ts";
import { childFailureOutcome } from "../extensions/fanout-outcome.ts";
import { delegationUsage, observedUsageOf, withObservedUsage } from "../src/executors/child-usage.ts";
import type { GrantsSession } from "../extensions/session.ts";
import type { ExecutionOccurrenceIds } from "../extensions/execution-occurrence.ts";

after(cleanupTempDirs);

const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  for (const [name, value] of saved) value === undefined ? delete process.env[name] : (process.env[name] = value);
  saved.clear();
});

test("the read-only native set is exactly read, grep, find and ls", () => {
  assert.deepEqual([...REPLAY_SAFE_TOOLS], ["tool:find", "tool:grep", "tool:ls", "tool:read"]);
  assert.equal(Object.isFrozen(REPLAY_SAFE_TOOLS), true);
});

test("replay-safe truth table: read-only native tools and context modes only", () => {
  const safe: string[][] = [
    [],
    ["tool:read"],
    ["tool:grep"],
    ["tool:find"],
    ["tool:ls"],
    ["tool:find", "tool:grep", "tool:ls", "tool:read"],
    ["tool:read", "context:none"],
    ["tool:read", "context:files"],
    ["tool:read", "context:pruned"],
    ["tool:read", "context:summary"],
    ["tool:read", "context:fork"],
  ];
  for (const capabilities of safe) assert.equal(replaySafe(capabilities), true, JSON.stringify(capabilities));
  const unsafe = [
    "tool:bash",
    "tool:write",
    "tool:edit",
    "tool:edit-diff",
    "tool:parallel",
    "tool:delegate",
    "tool:delegate_all",
    "tool:scout_research",
    "tool:powershell",
    "tool:*",
    "tool:READ",
    "ext:scout/scout_research",
    "skill:anything",
    "agent:investigate",
    "agent:*",
    "workspace:prod",
    "context:everything",
    "read",
  ];
  for (const capability of unsafe)
    assert.equal(replaySafe(["tool:read", capability]), false, `${capability} must make the set unsafe`);
});

test("an undeclared, pattern or wildcard ceiling is never replay-safe", () => {
  const define = (allowedTools?: string): SkillDefinition => ({
    name: "d",
    description: "d",
    body: "d",
    source: "/p/.pi/skills/d/SKILL.md",
    ...(allowedTools === undefined ? {} : { allowedTools }),
  });
  assert.equal(replaySafeCeiling(ceilingForDefinition(define())), false, "undeclared");
  assert.equal(replaySafeCeiling(ceilingForDefinition(define("read, Bash(git:*)"))), false, "pattern");
  assert.equal(replaySafeCeiling(ceilingForDefinition(define("read, *"))), false, "wildcard");
  assert.equal(replaySafeCeiling(ceilingForDefinition(define("tool:*"))), false, "tool wildcard");
  assert.equal(replaySafeCeiling(ceilingForDefinition(define("read, grep, find, ls, context:files"))), true);
  assert.equal(replaySafeCeiling(ceilingForDefinition(define("read, grep, find, ls, bash, context:files"))), false);
  assert.equal(replaySafeCeiling(ceilingForDefinition(define(""))), true, "declared and empty: answers only");
  assert.equal(replaySafeCeiling({ capabilities: [], patterns: [], undeclared: true }), false);
});

test("the kill switch is on unset or 1, off at 0, and off and reported for anything else", () => {
  assert.deepEqual(replayRetrySwitch(undefined), { enabled: true, malformed: false });
  assert.deepEqual(replayRetrySwitch("1"), { enabled: true, malformed: false });
  assert.deepEqual(replayRetrySwitch("0"), { enabled: false, malformed: false });
  for (const raw of ["", "true", "yes", " 1", "01", "2"])
    assert.deepEqual(replayRetrySwitch(raw), { enabled: false, malformed: true }, JSON.stringify(raw));
});

const crashed: ReplayAttempt = {
  ok: false,
  work: "failed",
  exitCode: 1,
  final: { state: "unavailable" },
  cleanup: { state: "settled" },
  observation: { state: "complete" },
};

test("transient failures are classified from settlement facts only", () => {
  assert.equal(replayableFailure(crashed), "process exited without a final");
  assert.equal(replayableFailure({ ...crashed, exitCode: null }), "process exited without a final", "signal death");
  assert.equal(replayableFailure({ ...crashed, timedOut: true }), "timed out");
  assert.equal(
    replayableFailure({ ...crashed, exitCode: null, spawnFailed: true, spawnError: "Error: EMFILE: too many" }),
    "spawn failed transiently",
  );
  for (const code of ["EAGAIN", "ENFILE", "ENOMEM"])
    assert.equal(
      replayableFailure({ ...crashed, spawnFailed: true, spawnError: `spawn ${code}` }),
      "spawn failed transiently",
    );
  assert.equal(
    replayableFailure({ ...crashed, exitCode: 0, final: { state: "unavailable", providerError: true } }),
    "provider request failed",
  );
  // Not transient: an answered child, a cancelled one, a configuration fault, and a final missing for another reason.
  assert.equal(replayableFailure({ ...crashed, ok: true, exitCode: 0 }), undefined);
  assert.equal(replayableFailure({ ...crashed, aborted: true }), undefined);
  assert.equal(replayableFailure({ ...crashed, aborted: true, timedOut: true }), undefined);
  assert.equal(replayableFailure({ ...crashed, final: { state: "complete" } }), undefined);
  assert.equal(replayableFailure({ ...crashed, timedOut: true, final: { state: "complete" } }), undefined);
  assert.equal(replayableFailure({ ...crashed, spawnFailed: true, spawnError: "helper hash mismatch" }), undefined);
  assert.equal(replayableFailure({ ...crashed, spawnFailed: true }), undefined);
  assert.equal(replayableFailure({ ...crashed, exitCode: 0 }), undefined);
  assert.equal(replayableFailure({ ...crashed, exitCode: 0, final: undefined }), undefined);
});

const eligible: ReplayRetryFacts = {
  enabled: true,
  capabilities: ["tool:read", "tool:grep", "context:files"],
  attempt: crashed,
  operation: false,
  executor: "process",
  parentAborted: false,
  criticalAssuranceBlock: false,
  approvalSpent: false,
  remainingMs: 60_000,
  idleMs: 1_000,
};

test("every guard holds: retry once, naming the first failure", () => {
  assert.deepEqual(replayRetryDecision(eligible), { retry: true, cause: "process exited without a final" });
  assert.deepEqual(replayRetryDecision({ ...eligible, attempt: { ...crashed, cleanup: { state: "not-started" } } }), {
    retry: true,
    cause: "process exited without a final",
  });
  assert.deepEqual(replayRetryDecision({ ...eligible, remainingMs: 1_000 }), {
    retry: true,
    cause: "process exited without a final",
  });
});

// One case per guard, each flipping exactly one fact of an otherwise eligible attempt.
const guards: Array<[string, string, Partial<ReplayRetryFacts>]> = [
  ["disabled", "the kill switch is off", { enabled: false }],
  ["not-replay-safe", "the plan holds a shell", { capabilities: ["tool:read", "tool:bash"] }],
  ["executor", "the child ran in a Herdr pane", { executor: "herdr" }],
  ["cancelled", "the parent tool call was aborted", { parentAborted: true }],
  ["cancelled", "the child was cancelled", { attempt: { ...crashed, aborted: true } }],
  ["refused", "the planner refused before launch", { attempt: { ok: false, exitCode: null } }],
  ["assurance-block", "an upstream controller vetoed", { criticalAssuranceBlock: true }],
  ["not-transient", "the child answered", { attempt: { ...crashed, final: { state: "complete" } } }],
  ["cleanup-unsettled", "cleanup is unknown", { attempt: { ...crashed, cleanup: { state: "unknown" } } }],
  ["cleanup-unsettled", "cleanup is unreported", { attempt: { ...crashed, cleanup: undefined } }],
  ["cleanup-unsettled", "a control step failed", { attempt: { ...crashed, control: "failed" } }],
  ["cleanup-unsettled", "observation is incomplete", { attempt: { ...crashed, observation: { state: "incomplete" } } }],
  ["cleanup-unsettled", "observation is unreported", { attempt: { ...crashed, observation: undefined } }],
  ["approval-spent", "a gate answered for the first attempt", { approvalSpent: true }],
  ["deadline", "less than one idle bound remains", { remainingMs: 999 }],
  ["deadline", "the deadline is unknown", { remainingMs: Number.NaN }],
];
for (const [because, label, flip] of guards)
  test(`no retry (${because}) when ${label}`, () => {
    assert.deepEqual(replayRetryDecision({ ...eligible, ...flip }), { retry: false, because });
  });

// 2026-11-17, "Principal retries once": under a stable operation Daddy never retries; an attempt every other guard
// accepts is marked replayable for the operation's owner, and one any other guard refuses is not marked.
test("under a stable operation an otherwise eligible failure is marked replayable and not retried", () => {
  assert.deepEqual(replayRetryDecision({ ...eligible, operation: true }), {
    retry: false,
    because: "stable-operation",
    replayable: "process exited without a final",
  });
  assert.deepEqual(
    replayRetryDecision({ ...eligible, operation: true, attempt: { ...crashed, exitCode: null, timedOut: true } }),
    { retry: false, because: "stable-operation", replayable: "timed out" },
  );
});
for (const [because, label, flip] of guards)
  test(`no replayable mark under a stable operation (${because}) when ${label}`, () => {
    assert.deepEqual(replayRetryDecision({ ...eligible, operation: true, ...flip }), { retry: false, because });
  });

// --- composition: `replayIfSafe` with a fake owner and a fake rerun --------------------------------------------

const FIRST_ID = "exec:00000000-0000-4000-8000-000000000001";
function failedFirst(overrides: Partial<DelegationOutcome> = {}): DelegationOutcome {
  return {
    ok: false,
    work: "failed",
    text: "",
    reason: "the sub-agent exited with code 1",
    granted: ["tool:read"],
    depth: 1,
    exitCode: 1,
    final: { state: "unavailable", reason: "no eligible current terminal assistant message" },
    cleanup: { state: "not-started", reason: "fixture" },
    observation: { state: "complete", reasons: [] },
    refusal: refusal("CHILD_EXIT_NONZERO", "the sub-agent exited with code 1"),
    ...overrides,
  };
}
function owner(capacity = 4, executor: "process" | "herdr" = "process") {
  return { executor: { kind: executor }, capacity: createCapacityAllocator(capacity) } as unknown as GrantsSession;
}
const ids: ExecutionOccurrenceIds = { parentId: "d0", childId: "d0.1", executionId: FIRST_ID, parentExecutionId: null };
const observed = (remaining = 60_000) => ({ approvalSpent: false, deadlineAt: Date.now() + remaining });
const second = (overrides: Partial<DelegationOutcome> = {}): DelegationOutcome => ({
  ok: true,
  work: "succeeded",
  text: "second answer",
  granted: ["tool:read"],
  depth: 1,
  exitCode: 0,
  cleanup: { state: "not-started", reason: "fixture" },
  observation: { state: "complete", reasons: [] },
  ...overrides,
});

test("an eligible failure runs once more as a fresh occurrence with its own capacity", async () => {
  setEnv(ENV_REPLAY_RETRY, undefined);
  setEnv(ENV_CHILD_IDLE_TIMEOUT, "1");
  const session = owner(4);
  const calls: Array<{ ids: typeof ids; reservation: string; allowance: number }> = [];
  const run: ReplayRun = async (retryIds, reservation, observe) => {
    calls.push({ ids: retryIds, reservation: reservation.executionId, allowance: reservation.childAllowance });
    observe.onExecutorEntry();
    return second();
  };
  const first = failedFirst();
  const result = await replayIfSafe(
    first,
    { session, ids, budget: 2, signal: undefined, operation: false, attempt: observed() },
    run,
  );
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].ids.executionId, FIRST_ID);
  assert.match(calls[0].ids.executionId, /^exec:/);
  assert.deepEqual({ ...calls[0].ids, executionId: "x" }, { ...ids, executionId: "x" }, "same logical position");
  assert.equal(calls[0].reservation, calls[0].ids.executionId);
  assert.equal(calls[0].allowance, 2, "the same subtree allowance as the first attempt");
  assert.equal(result.ok, true);
  assert.equal(result.text, "second answer");
  assert.equal(result.reason, undefined);
  assert.deepEqual(result.retry, {
    attempts: 2,
    firstFailure: "process exited without a final",
    executionId: calls[0].ids.executionId,
    first,
  });
});

test("a second failure keeps the second outcome and names the first", async () => {
  setEnv(ENV_CHILD_IDLE_TIMEOUT, "1");
  const first = failedFirst();
  const result = await replayIfSafe(
    first,
    { session: owner(), ids, budget: undefined, signal: undefined, operation: false, attempt: observed() },
    async () => second({ ok: false, work: "failed", exitCode: 2, reason: "the sub-agent exited with code 2" }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.reason, "the sub-agent exited with code 2; first attempt: the sub-agent exited with code 1");
  assert.equal(result.retry?.first, first);
});

test("no room in the fan-out bound leaves the first attempt standing and starts nothing", async () => {
  setEnv(ENV_CHILD_IDLE_TIMEOUT, "1");
  let ran = false;
  const first = failedFirst();
  const result = await replayIfSafe(
    first,
    { session: owner(0), ids, budget: undefined, signal: undefined, operation: false, attempt: observed() },
    async () => ((ran = true), second()),
  );
  assert.equal(ran, false);
  assert.equal(result.retry, undefined);
  assert.equal(result.exitCode, 1);
  assert.match(result.reason ?? "", /^the sub-agent exited with code 1; automatic retry not started: .*capacity/);
});

test("a retry refused at its own planning leaves the first attempt standing", async () => {
  setEnv(ENV_CHILD_IDLE_TIMEOUT, "1");
  const first = failedFirst();
  const result = await replayIfSafe(
    first,
    { session: owner(), ids, budget: undefined, signal: undefined, operation: false, attempt: observed() },
    async () => ({
      ok: false,
      text: "",
      reason: "tool:read requires explicit approval",
      granted: [],
      depth: 1,
      exitCode: null,
    }),
  );
  assert.equal(result.retry, undefined);
  assert.equal(result.cleanup, first.cleanup);
  assert.equal(
    result.reason,
    "the sub-agent exited with code 1; automatic retry not started: tool:read requires explicit approval",
  );
});

test("a retry that throws before its child starts leaves the first attempt standing", async () => {
  setEnv(ENV_CHILD_IDLE_TIMEOUT, "1");
  const result = await replayIfSafe(
    failedFirst(),
    { session: owner(), ids, budget: undefined, signal: undefined, operation: false, attempt: observed() },
    async () => {
      throw new Error("definition snapshot changed");
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.reason ?? "", /automatic retry not started: definition snapshot changed$/);
});

test("a retry that throws after its child started rejects loudly and names the first failure", async () => {
  setEnv(ENV_CHILD_IDLE_TIMEOUT, "1");
  await assert.rejects(
    replayIfSafe(
      failedFirst(),
      { session: owner(), ids, budget: undefined, signal: undefined, operation: false, attempt: observed() },
      async (_ids, _reservation, observe) => {
        observe.onExecutorEntry();
        throw new GovernanceRefusal(refusal("EXECUTOR_UNAVAILABLE", "executor lost"));
      },
    ),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "EXECUTOR_UNAVAILABLE");
      assert.equal(
        error.message,
        "executor lost; after an automatic retry of a replay-safe child whose first attempt failed " +
          "(process exited without a final)",
      );
      return true;
    },
  );
});

test("both attempts' child usage is reported: on the returned outcome and on an error thrown after the retry ran", async () => {
  // Integration with child usage (2026-11-17). Each attempt used the model and has its own lifecycle record; the
  // delegation reports their sum, and `retry.first` keeps the first attempt's own observation.
  setEnv(ENV_CHILD_IDLE_TIMEOUT, "1");
  const usage = (tokens: number, cost: number) => ({
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: tokens,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  });
  const one = { usage: usage(1, 0.5), measured: 1, unmeasured: 0 };
  const two = { usage: usage(2, 0.25), measured: 1, unmeasured: 0 };
  const both = { usage: usage(3, 0.75), measured: 2, unmeasured: 0 };
  const input = () => ({
    session: owner(),
    ids,
    budget: undefined,
    signal: undefined,
    operation: false,
    attempt: observed(),
  });
  const returned = await replayIfSafe(failedFirst({ observedUsage: one }), input(), async () =>
    second({ observedUsage: two }),
  );
  assert.deepEqual(returned.observedUsage, both);
  assert.deepEqual(returned.retry?.first.observedUsage, one);
  assert.deepEqual(delegationUsage([returned]), {
    usage: both.usage,
    childUsage: { reported: true, cost: 0.75, measured: 2, unmeasured: 0, coverage: "complete" },
  });
  const unread = await replayIfSafe(failedFirst({ observedUsage: { measured: 0, unmeasured: 1 } }), input(), async () =>
    second({ observedUsage: two }),
  );
  assert.deepEqual(unread.observedUsage, { usage: two.usage, measured: 1, unmeasured: 1 });
  const plain = await replayIfSafe(failedFirst(), input(), async () => second());
  assert.equal("observedUsage" in plain, false, "nothing observed, nothing invented");
  for (const lost of [new GovernanceRefusal(refusal("EXECUTOR_UNAVAILABLE", "executor lost")), new Error("lost")]) {
    const caught = await replayIfSafe(failedFirst({ observedUsage: one }), input(), async (_ids, _r, observe) => {
      observe.onExecutorEntry();
      throw withObservedUsage(lost, two);
    }).then(
      () => assert.fail("the retry's executor failure must reject"),
      (error: unknown) => error,
    );
    assert.notEqual(caught, lost, "a new error naming the first failure");
    assert.deepEqual(observedUsageOf(caught), both, lost.message);
    assert.deepEqual(childFailureOutcome(caught, 1).observedUsage, both, "a fan-out reports both attempts");
  }
});

test("composition refusals: switch, operation, Herdr, cancellation, cleanup, approval and deadline start nothing", async () => {
  setEnv(ENV_CHILD_IDLE_TIMEOUT, "1");
  const cases: Array<[string, () => Promise<DelegationOutcome>]> = [];
  const attempt = (
    first: DelegationOutcome,
    extra: Partial<Parameters<typeof replayIfSafe>[1]> = {},
    session = owner(),
  ) =>
    replayIfSafe(
      first,
      { session, ids, budget: undefined, signal: undefined, operation: false, attempt: observed(), ...extra },
      async () => {
        throw new Error("must not run");
      },
    );
  const aborted = new AbortController();
  aborted.abort();
  cases.push(["operation", () => attempt(failedFirst(), { operation: true })]);
  cases.push(["herdr", () => attempt(failedFirst(), {}, owner(4, "herdr"))]);
  cases.push(["parent abort", () => attempt(failedFirst(), { signal: aborted.signal })]);
  cases.push(["unknown cleanup", () => attempt(failedFirst({ cleanup: { state: "unknown", reason: "lost" } }))]);
  cases.push([
    "approval",
    () => attempt(failedFirst(), { attempt: { approvalSpent: true, deadlineAt: Date.now() + 60_000 } }),
  ]);
  cases.push(["unobserved approval", () => attempt(failedFirst(), { attempt: { deadlineAt: Date.now() + 60_000 } })]);
  cases.push(["no deadline", () => attempt(failedFirst(), { attempt: { approvalSpent: false } })]);
  cases.push(["short deadline", () => attempt(failedFirst(), { attempt: observed(500) })]);
  cases.push(["not replay-safe", () => attempt(failedFirst({ granted: ["tool:read", "tool:bash"] }))]);
  cases.push([
    "refused before launch",
    () => attempt({ ok: false, text: "", reason: "cannot grant tool:write", granted: [], depth: 1, exitCode: null }),
  ]);
  cases.push([
    "assurance veto",
    () =>
      attempt(failedFirst({ text: "BLOCKED_CRITICAL_ASSURANCE: no", cleanup: { state: "not-started", reason: "x" } })),
  ]);
  for (const [name, run] of cases) {
    const first = await run();
    assert.equal(first.retry, undefined, name);
    assert.doesNotMatch(first.reason ?? "", /automatic retry/, name);
    assert.equal(first.replayable, name === "operation" ? true : undefined, name);
  }
  setEnv(ENV_REPLAY_RETRY, "0");
  assert.equal((await attempt(failedFirst())).retry, undefined, "switched off");
  assert.equal((await attempt(failedFirst(), { operation: true })).replayable, undefined, "switched off");
  setEnv(ENV_REPLAY_RETRY, "yes");
  assert.equal((await attempt(failedFirst())).retry, undefined, "malformed is off");
  assert.equal((await attempt(failedFirst(), { operation: true })).replayable, undefined, "malformed is off");
});

test("under a stable operation an eligible failure is returned marked replayable, nothing reserved or run", async () => {
  setEnv(ENV_REPLAY_RETRY, undefined);
  setEnv(ENV_CHILD_IDLE_TIMEOUT, "1");
  const session = owner(1);
  const first = failedFirst();
  let ran = false;
  const result = await replayIfSafe(
    first,
    { session, ids, budget: undefined, signal: undefined, operation: true, attempt: observed() },
    async () => ((ran = true), second()),
  );
  assert.equal(ran, false);
  assert.deepEqual(result, { ...first, replayable: true });
  assert.equal(first.replayable, undefined, "the first attempt's own record is not rewritten");
  assert.equal(session.capacity.available, 1, "no capacity was taken");
  // Every other guard still refuses the mark: one per guard the composition supplies.
  const aborted = new AbortController();
  aborted.abort();
  const unmarked: Array<[string, Promise<DelegationOutcome>]> = [
    [
      "herdr",
      replayIfSafe(
        first,
        { session: owner(1, "herdr"), ids, budget: undefined, signal: undefined, operation: true, attempt: observed() },
        async () => second(),
      ),
    ],
    [
      "parent abort",
      replayIfSafe(
        first,
        { session, ids, budget: undefined, signal: aborted.signal, operation: true, attempt: observed() },
        async () => second(),
      ),
    ],
    [
      "approval spent",
      replayIfSafe(
        first,
        {
          session,
          ids,
          budget: undefined,
          signal: undefined,
          operation: true,
          attempt: { approvalSpent: true, deadlineAt: Date.now() + 60_000 },
        },
        async () => second(),
      ),
    ],
    [
      "deadline",
      replayIfSafe(
        first,
        { session, ids, budget: undefined, signal: undefined, operation: true, attempt: observed(500) },
        async () => second(),
      ),
    ],
    [
      "unsettled cleanup",
      replayIfSafe(
        failedFirst({ cleanup: { state: "unknown", reason: "lost" } }),
        { session, ids, budget: undefined, signal: undefined, operation: true, attempt: observed() },
        async () => second(),
      ),
    ],
    [
      "not replay-safe",
      replayIfSafe(
        failedFirst({ granted: ["tool:read", "tool:bash"] }),
        { session, ids, budget: undefined, signal: undefined, operation: true, attempt: observed() },
        async () => second(),
      ),
    ],
    [
      "answered",
      replayIfSafe(
        second(),
        { session, ids, budget: undefined, signal: undefined, operation: true, attempt: observed() },
        async () => second(),
      ),
    ],
  ];
  for (const [name, pending] of unmarked) assert.equal((await pending).replayable, undefined, name);
});

test("a parent cancelled while capacity is reconciled starts no retry and frees the reservation", async () => {
  setEnv(ENV_REPLAY_RETRY, undefined);
  setEnv(ENV_CHILD_IDLE_TIMEOUT, "1");
  const session = owner(1);
  const controller = new AbortController();
  let ran = false;
  const pending = replayIfSafe(
    failedFirst(),
    { session, ids, budget: undefined, signal: controller.signal, operation: false, attempt: observed() },
    async () => ((ran = true), second()),
  );
  // The decision has been taken (it is synchronous); the cancellation lands at the first await after it.
  controller.abort();
  const result = await pending;
  assert.equal(ran, false);
  assert.equal(result.retry, undefined);
  assert.equal(
    result.reason,
    "the sub-agent exited with code 1; automatic retry not started: the parent tool call was cancelled",
  );
  assert.equal(session.capacity.available, 1, "the retry's reservation was released");
});

// --- `/grants`: the planner preview names each allowed definition whose planned tools only read ----------------

test("/grants marks an allowed definition replay-safe and says when this session does not retry it", async () => {
  const session = createGrantsSession(undefined);
  session.cwd = await tempDir("replay-safe-grants-");
  session.ownGrant = ["agent:look", "agent:fix", "tool:read", "tool:grep", "tool:bash"];
  session.gated = [];
  session.depth = 0;
  session.maxDepth = 3;
  session.definitions = new Map([
    ["look", { name: "look", description: "Look", allowedTools: "read, grep", body: "Look.", source: "/look" }],
    ["fix", { name: "fix", description: "Fix", allowedTools: "read, bash", body: "Fix.", source: "/fix" }],
  ]);
  session.catalog = makeCatalog([
    ...classifyToolNames(["read", "grep", "bash"]),
    { capability: "agent:look", kind: "agentType" },
    { capability: "agent:fix", kind: "agentType" },
  ]);
  session.catalogReady = Promise.resolve(session.catalog);
  const render = async (executor: { kind: "process" | "herdr" } = session.executor) => {
    let output = "";
    await grantsCommand.handler("", {
      ui: { notify: (text: string) => void (output = text) },
      grants: {
        cwd: session.cwd,
        governed: true,
        ownGrant: session.ownGrant,
        executor,
        observed: true,
        depth: session.depth,
        maxDepth: session.maxDepth,
        catalog: session.catalog,
        definitions: session.definitions,
        sessionApprovals: session.sessionApprovals,
        inheritedApprovals: session.inheritedApprovals,
        snapshotOf: () => undefined,
        previewDelegation: (name: string) => planWithApprovals(session, { task: "(preview)", agent: name }, {}, null),
        runtimeFor: () => ({ modelSource: "default", thinkingSource: "default" }),
      },
    } as never);
    const lines = output.split("\n");
    const row = (name: string) => lines.find((line) => line.startsWith(`    allow  ${name}  `));
    return { look: row("look"), fix: row("fix"), notice: lines.filter((line) => line.startsWith("  replay-safe: ")) };
  };
  setEnv(ENV_REPLAY_RETRY, undefined);
  let rows = await render();
  assert.match(rows.look ?? "", /\]  tool:grep, tool:read  replay-safe$/);
  assert.match(rows.fix ?? "", /\]  tool:bash, tool:read$/);
  assert.deepEqual(rows.notice, [
    "  replay-safe: retried once automatically if it fails without answering; with operation_id, marked replayable " +
      "for the coordinator to retry instead",
  ]);
  // R-28's shape, from review: the enforcer never retries under Herdr, so the screen must not say it does.
  rows = await render({ kind: "herdr" });
  assert.match(rows.look ?? "", /\]  tool:grep, tool:read  replay-safe$/);
  assert.deepEqual(rows.notice, ["  replay-safe: not retried or marked replayable under the Herdr executor"]);
  setEnv(ENV_REPLAY_RETRY, "0");
  rows = await render();
  assert.match(rows.look ?? "", /\]  tool:grep, tool:read  replay-safe$/);
  assert.deepEqual(rows.notice, [
    "  replay-safe: not retried or marked replayable: switched off by PI_DADDY_REPLAY_RETRY",
  ]);
});

// --- evidence: complete (version 1) keeps both attempts; the model's summary (version 2) says only that it happened --

test("the model summary says a retry happened in one fixed phrase, at its complete path; details keep both", () => {
  const first = failedFirst({ reason: "the sub-agent exited with code 1 at /private/path" });
  const retried: DelegationOutcome = {
    ...second(),
    retry: { attempts: 2, firstFailure: "process exited without a final", executionId: FIRST_ID, first },
  };
  const complete = executionEvidence("delegate_all", [retried, failedFirst()], 2);
  assert.deepEqual(complete.outcomes[0].retry, {
    attempts: 2,
    firstFailure: "process exited without a final",
    first: { ...executionEvidence("delegate", [first], 1).outcomes[0] },
  });
  assert.equal("retry" in complete.outcomes[1], false);
  const summary = executionEvidenceSummary(complete);
  assert.deepEqual(summary.outcomes[0].retry, { attempts: 2, firstFailure: "process exited without a final" });
  assert.equal("retry" in summary.outcomes[1], false);
  assert.ok(!JSON.stringify(summary).includes("/private/path"), "the first attempt's prose stays in details");
  const walk = (value: unknown, source: unknown, path: string): void => {
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value))
        walk(child, (source as Record<string, unknown>)[key], `${path}.${key}`);
      return;
    }
    assert.equal(value, source, path);
  };
  walk(summary.outcomes[0].retry, complete.outcomes[0].retry, "retry");
});

test("a replayable failure carries one stable field at the same path in details, complete evidence and summary", () => {
  const marked: DelegationOutcome = { ...failedFirst(), replayable: true };
  const complete = executionEvidence("delegate_all", [marked, failedFirst(), second()], 3);
  assert.deepEqual(
    complete.outcomes.map((outcome) => ("replayable" in outcome ? outcome.replayable : "absent")),
    [true, "absent", "absent"],
  );
  const summary = executionEvidenceSummary(complete);
  assert.deepEqual(
    summary.outcomes.map((outcome) => ("replayable" in outcome ? outcome.replayable : "absent")),
    [true, "absent", "absent"],
  );
  // The mark adds exactly `"replayable":true` to the compact summary of an otherwise identical failure.
  const plain = JSON.stringify(summary.outcomes[1]);
  assert.equal(JSON.stringify(summary.outcomes[0]).length - plain.length, ',"replayable":true'.length);
});

// --- ledger: retry links stay outside the closed shared wire contract ------------------------------

test("the shared ledger remains closed to retry metadata", () => {
  const record = buildRecord({
    executionId: FIRST_ID,
    parentExecutionId: null,
    parentId: "d0",
    childId: "d0.0",
    depth: 1,
    requested: ["tool:read"],
    parentGrant: ["tool:read"],
    result: { effective: ["tool:read"], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    blocked: false,
    executor: "process",
    taskDigest: "9".repeat(64),
    now: new Date("2026-11-17T12:00:00.000Z"),
  });
  const wire = JSON.parse(JSON.stringify(record));
  assert.equal("retryOf" in wire, false);
  assert.equal(validateLedgerV3Event(wire), null);
  assert.notEqual(validateLedgerV3Event({ ...wire, retryOf: "exec:00000000-0000-4000-8000-000000000002" }), null);
});

// --- execution: an inherited deadline bounds both the recorded deadline and the run ------------------------------

test("an execution handed a deadline records exactly that deadline and cannot run past it", async () => {
  const dir = await tempDir("replay-safe-deadline-");
  const plan = {
    ok: true,
    args: [" deadline fixture task"],
    env: {},
    effective: [],
    result: { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    childDepth: 1,
    requested: [],
    taskDigest: "a".repeat(64),
  };
  const run = async (deadlineAt?: number) => {
    const reported: number[] = [];
    const outcome = await executePlannedChild({
      session: { executor: { kind: "process" } } as GrantsSession,
      plan,
      childId: "d0.1",
      executionId: FIRST_ID,
      parentExecutionId: null,
      cwd: dir,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      onDeadline: (at) => reported.push(at),
    });
    return { outcome, reported };
  };
  // Already past: nothing may start, and the recorded deadline is the inherited one, not "now plus a little".
  const past = Date.now() - 1_000;
  const late = await run(past);
  assert.deepEqual(late.reported, [past]);
  assert.equal(late.outcome.timedOut, true);
  assert.equal(late.outcome.cleanup?.state, "not-started");
});
