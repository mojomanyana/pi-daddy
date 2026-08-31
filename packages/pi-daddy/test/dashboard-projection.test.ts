import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDashboardLedger,
  type DashboardNode,
} from "../src/dashboard-projection.ts";
import { renderDashboard } from "../src/dashboard-render.ts";

const digest = "a".repeat(64);
const now = new Date("2026-08-28T12:10:00.000Z");

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ledgerVersion: 3,
    event: "capability_decision",
    ts: "2026-08-28T12:00:00.000Z",
    executionId: "exec:00000000-0000-4000-8000-000000000001",
    parentExecutionId: null,
    parentId: "d0",
    childId: "d0.1",
    depth: 1,
    agentType: "review",
    requested: ["tool:read"],
    parentGrant: ["tool:read"],
    effective: ["tool:read"],
    denied: [],
    clipped: [],
    gatedBlocked: [],
    blocked: false,
    executor: "process",
    taskDigest: digest,
    ...overrides,
  };
}

function lifecycle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ledgerVersion: 3,
    event: "child_lifecycle",
    ts: "2026-08-28T12:00:01.000Z",
    executionId: "exec:00000000-0000-4000-8000-000000000001",
    parentExecutionId: null,
    childId: "d0.1",
    state: "starting",
    executor: "process",
    deadlineAt: "2026-08-28T12:20:00.000Z",
    ...overrides,
  };
}

const lines = (...events: unknown[]): string => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const byExecution = (nodes: DashboardNode[], id: string): DashboardNode => {
  const node = nodes.find((candidate) => candidate.executionId === id);
  assert.ok(node, `missing ${id}`);
  return node;
};

test("two occurrences at the same logical child position remain separate nodes", () => {
  const first = "exec:00000000-0000-4000-8000-000000000001";
  const second = "exec:00000000-0000-4000-8000-000000000002";
  const projection = parseDashboardLedger(lines(
    decision({ executionId: first }),
    decision({ executionId: second, ts: "2026-08-28T12:01:00.000Z" }),
    lifecycle({ executionId: first, state: "completed", exitCode: 0, signal: null }),
    lifecycle({ executionId: second, ts: "2026-08-28T12:01:01.000Z" }),
  ), { now });

  assert.equal(projection.nodes.length, 2);
  assert.equal(byExecution(projection.nodes, first).state, "completed");
  assert.equal(byExecution(projection.nodes, second).state, "starting");
  assert.deepEqual(projection.nodes.map((node) => node.logicalChildId), ["d0.1", "d0.1"]);
});

test("a refusal that never starts a process is still a red-state node", () => {
  const projection = parseDashboardLedger(lines(decision({
    blocked: true,
    denied: ["tool:write"],
    effective: [],
    refusal: { code: "CAPABILITY_ESCALATION", message: "blocked" },
  })), { now });

  assert.equal(projection.nodes[0]?.state, "refused");
  assert.equal(projection.nodes[0]?.durationMs, 0, "a refusal that never ran must not accrue runtime");
  assert.equal(projection.nodes[0]?.provenance, "pi-daddy-enforced");
});

test("an authorised decision that never starts freezes at the start grace bound", () => {
  const projection = parseDashboardLedger(lines(decision()), { now, startGraceMs: 5_000 });
  assert.equal(projection.nodes[0]?.state, "incomplete");
  assert.equal(projection.nodes[0]?.durationMs, 5_000);
});

test("a start with no terminal event expires to incomplete instead of running forever", () => {
  const projection = parseDashboardLedger(lines(
    decision(),
    lifecycle({ deadlineAt: "2026-08-28T12:05:00.000Z" }),
  ), { now });

  assert.equal(projection.nodes[0]?.state, "incomplete");
});

test("a running event cannot replace the lifecycle's recorded deadline", () => {
  const projection = parseDashboardLedger(lines(
    decision(),
    lifecycle({ deadlineAt: "2026-08-28T12:05:00.000Z" }),
    lifecycle({
      state: "running",
      ts: "2026-08-28T12:00:02.000Z",
      deadlineAt: "2026-08-28T13:00:00.000Z",
    }),
  ), { now });

  assert.equal(projection.nodes[0]?.state, "incomplete", "the starting deadline remains the occurrence bound");
  assert.equal(projection.nodes[0]?.durationMs, 299_000);
  assert.equal(projection.corrupt.length, 1);
  assert.match(projection.corrupt[0]?.reason ?? "", /deadline changed/);
});

test("restarting reconstructs the same state and retained Herdr identity from ledger facts", () => {
  const text = lines(
    decision(),
    lifecycle({ state: "running", executor: "herdr", herdrPaneId: "w1:p2", herdrAgentName: "review-d0-1" }),
    lifecycle({ state: "completed", executor: "herdr", ts: "2026-08-28T12:02:00.000Z", exitCode: 0, signal: null }),
  );
  const first = parseDashboardLedger(text, { now });
  assert.deepEqual(first, parseDashboardLedger(text, { now }));
  assert.equal(first.nodes[0]?.runtime?.herdrPaneId, "w1:p2");
});

test("corrupt and unsupported lines are reported by number and never repaired or ignored", () => {
  const projection = parseDashboardLedger([
    JSON.stringify(decision()),
    "{not-json",
    JSON.stringify({ ...decision(), ledgerVersion: 4 }),
    JSON.stringify({ ...lifecycle(), executionId: undefined }),
    JSON.stringify({
      ledgerVersion: 3, event: "workspace_lease", ts: now.toISOString(),
      executionId: "exec:00000000-0000-4000-8000-000000000009", parentExecutionId: null,
      childId: "d0.9", workspaceId: "w", root: "/w", access: "read", outcome: "teleported",
    }),
  ].join("\n"), { now });

  assert.equal(projection.nodes.length, 1);
  assert.deepEqual(projection.corrupt.map((entry) => entry.line), [2, 3, 4, 5]);
  assert.match(projection.corrupt[0]?.reason ?? "", /JSON/i);
});

test("malformed JSON diagnostics never echo raw ledger content", () => {
  const secret = "SECRET_TASK";
  const projection = parseDashboardLedger(secret, { now });
  assert.equal(projection.corrupt.length, 1);
  assert.doesNotMatch(projection.corrupt[0]?.reason ?? "", new RegExp(secret));
  assert.doesNotMatch(renderDashboard(projection, { color: false }), new RegExp(secret));
});

test("schema-shaped free text cannot become dashboard task or output text", () => {
  const taskSecret = "SECRET TASK TEXT";
  const outputSecret = "SECRET OUTPUT TEXT";
  const hostile = decision({
    agentType: taskSecret,
    effective: [outputSecret],
    correlation: { run_id: "run-secret", policy_label: taskSecret, phase: "plan" },
  });
  const historical: Record<string, unknown> = { ...hostile, ledgerVersion: 2 };
  delete historical.executionId;
  delete historical.parentExecutionId;

  const projection = parseDashboardLedger(lines(hostile, historical), { now });
  const rendered = renderDashboard(projection, { color: false, details: true });
  assert.equal(projection.corrupt.length, 1, "v3 rejects fields that claim identifiers but carry prose");
  assert.doesNotMatch(rendered, new RegExp(taskSecret));
  assert.doesNotMatch(rendered, new RegExp(outputSecret));
});

test("malformed nested v3 fields are corruption, not renderer crashes", () => {
  const projection = parseDashboardLedger(lines(decision({
    correlation: { run_id: "run-1", phase: 42 },
  })), { now });
  assert.equal(projection.nodes.length, 0);
  assert.equal(projection.corrupt.length, 1);
  assert.doesNotThrow(() => renderDashboard(projection, { color: false }));
});

test("v2 occurrences are historical and are never lifecycle-joined by childId", () => {
  const legacy: Record<string, unknown> = { ...decision(), ledgerVersion: 2 };
  delete legacy.executionId;
  delete legacy.parentExecutionId;
  const oldLifecycle: Record<string, unknown> = { ...lifecycle(), ledgerVersion: 2, state: "completed" };
  delete oldLifecycle.executionId;
  delete oldLifecycle.parentExecutionId;
  delete oldLifecycle.deadlineAt;

  const projection = parseDashboardLedger(lines(legacy, legacy, oldLifecycle), { now });
  assert.equal(projection.nodes.length, 2);
  assert.ok(projection.nodes.every((node) => node.state === "historical"));
  assert.equal(projection.orphanEvents, 1, "the ambiguous v2 lifecycle is disclosed, not guessed");
});

test("malformed explicit v2 events are corruption, not historical or orphan rows", () => {
  const malformedDecision: Record<string, unknown> = { ...decision(), ledgerVersion: 2 };
  delete malformedDecision.executionId;
  delete malformedDecision.parentExecutionId;
  delete malformedDecision.childId;
  const malformedLifecycle: Record<string, unknown> = { ...lifecycle(), ledgerVersion: 2 };
  delete malformedLifecycle.executionId;
  delete malformedLifecycle.parentExecutionId;
  delete malformedLifecycle.childId;
  const missingDiscriminator: Record<string, unknown> = { ...malformedDecision, childId: "d0.1" };
  delete missingDiscriminator.event;

  const projection = parseDashboardLedger(lines(malformedDecision, malformedLifecycle, missingDiscriminator), { now });
  assert.equal(projection.nodes.length, 0);
  assert.equal(projection.orphanEvents, 0);
  assert.equal(projection.corrupt.length, 3);
  assert.ok(projection.corrupt.every((entry) => /v2/i.test(entry.reason)));
});

test("a lifecycle event after terminal state is corrupt and cannot resurrect a child", () => {
  const projection = parseDashboardLedger(lines(
    decision(),
    lifecycle({ state: "completed", exitCode: 0, signal: null }),
    lifecycle({ state: "running", ts: "2026-08-28T12:02:00.000Z" }),
  ), { now });
  assert.equal(projection.nodes[0]?.state, "completed");
  assert.equal(projection.corrupt.length, 1);
  assert.match(projection.corrupt[0]?.reason ?? "", /after terminal lifecycle/);
});

test("duplicate capability decisions for one execution id are corruption, not one merged occurrence", () => {
  const projection = parseDashboardLedger(lines(decision(), decision({ agentType: "debug" })), { now });
  assert.equal(projection.nodes.length, 1);
  assert.equal(projection.nodes[0]?.agentName, "review");
  assert.equal(projection.corrupt.length, 1);
  assert.match(projection.corrupt[0]?.reason ?? "", /duplicate capability decision/);
});

test("a self-parent execution is corrupt rather than a node that disappears from the tree", () => {
  const executionId = "exec:00000000-0000-4000-8000-000000000001";
  const projection = parseDashboardLedger(lines(decision({ executionId, parentExecutionId: executionId })), { now });
  assert.equal(projection.nodes.length, 0);
  assert.equal(projection.corrupt.length, 1);
});

test("a multi-node parent cycle is reported rather than hidden", () => {
  const first = "exec:00000000-0000-4000-8000-000000000001";
  const second = "exec:00000000-0000-4000-8000-000000000002";
  const projection = parseDashboardLedger(lines(
    decision({ executionId: first, parentExecutionId: second }),
    decision({ executionId: second, parentExecutionId: first, childId: "d0.2" }),
  ), { now });
  assert.equal(projection.nodes.length, 0);
  assert.equal(projection.corrupt.length, 2);
  assert.ok(projection.corrupt.every((entry) => /parent cycle/.test(entry.reason)));
});

test("parent execution identity, runtime identity and caller-declared workflow labels stay distinct", () => {
  const parent = "exec:00000000-0000-4000-8000-000000000001";
  const child = "exec:00000000-0000-4000-8000-000000000003";
  const correlation = {
    run_id: "run-principal-1",
    policy_label: "principal-feature",
    phase: "plan",
    assurance_effective: "critical",
  };
  const projection = parseDashboardLedger(lines(
    decision({ executionId: parent, correlation }),
    lifecycle({ executionId: parent, state: "running", executor: "herdr", herdrPaneId: "w1:p2", herdrAgentName: "review-d0-1" }),
    decision({
      executionId: child,
      parentExecutionId: parent,
      parentId: "d0.1",
      childId: "d0.1.1",
      depth: 2,
      agentType: "debug",
      correlation: { ...correlation, phase: "review:quality" },
    }),
  ), { now });

  assert.equal(byExecution(projection.nodes, child).parentExecutionId, parent);
  assert.equal(byExecution(projection.nodes, parent).runtime?.herdrPaneId, "w1:p2");
  assert.deepEqual(projection.workflows, [{
    runId: "run-principal-1",
    label: "principal-feature",
    assurance: "critical",
    phases: ["plan", "review:quality"],
    provenance: "caller-declared",
  }]);
});
