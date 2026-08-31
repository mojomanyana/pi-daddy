import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDashboard } from "../src/dashboard-render.ts";
import type { DashboardNode, DashboardProjection } from "../src/dashboard-projection.ts";

const at = "2026-08-28T12:00:00.000Z";

function node(overrides: Partial<DashboardNode> = {}): DashboardNode {
  return {
    executionId: "exec:00000000-0000-4000-8000-000000000001",
    parentExecutionId: null,
    logicalChildId: "d0.1",
    depth: 1,
    agentName: "review",
    state: "running",
    provenance: "pi-daddy-enforced",
    startedAt: at,
    updatedAt: at,
    durationMs: 65_000,
    effectiveGrant: ["tool:read"],
    denied: [],
    executor: "herdr",
    runtime: { herdrPaneId: "w1:p2", herdrAgentName: "review-d0-1" },
    correlation: {
      run_id: "run-1",
      policy_label: "principal-feature",
      phase: "plan",
      assurance_effective: "critical",
    },
    ...overrides,
  };
}

function projection(nodes: DashboardNode[], overrides: Partial<DashboardProjection> = {}): DashboardProjection {
  return {
    nodes,
    workflows: [{
      runId: "run-1", label: "principal-feature", assurance: "critical", phases: ["plan"],
      provenance: "caller-declared",
    }],
    workflowFacts: [],
    corrupt: [],
    orphanEvents: 0,
    active: nodes.filter((candidate) => ["authorised", "starting", "running"].includes(candidate.state)).length,
    maxDepth: nodes.reduce((max, candidate) => Math.max(max, candidate.depth), 0),
    ...overrides,
  };
}

test("the compact tree shows workflow label, agent, state, elapsed time, pane and provenance", () => {
  const rendered = renderDashboard(projection([node()]), { color: false, width: 100 });
  assert.match(rendered, /PI-DADDY/);
  assert.match(rendered, /◆ principal-feature · critical · declared/);
  assert.match(rendered, /● review\s+running\s+1:05/);
  assert.match(rendered, /plan/);
  assert.match(rendered, /pane w1:p2/);
  assert.match(rendered, /P planned · O observed inline · V controller-validated · E enforced child/);
  assert.match(rendered, /depth 1 · 1 active/);
});

test("state colors follow the product palette", () => {
  const nodes = [
    node({ state: "running" }),
    node({ executionId: "exec:00000000-0000-4000-8000-000000000002", state: "completed" }),
    node({ executionId: "exec:00000000-0000-4000-8000-000000000003", state: "failed" }),
    node({ executionId: "exec:00000000-0000-4000-8000-000000000004", state: "refused" }),
    node({ executionId: "exec:00000000-0000-4000-8000-000000000005", state: "incomplete" }),
  ];
  const rendered = renderDashboard(projection(nodes), { color: true, width: 100, completedRoots: 10 });
  assert.match(rendered, /\u001b\[33m●/); // yellow active
  assert.match(rendered, /\u001b\[32m✓/); // green completed
  assert.match(rendered, /\u001b\[31m✕/); // red failed
  assert.match(rendered, /\u001b\[31m⛔/); // red refused
  assert.match(rendered, /\u001b\[90m○/); // grey incomplete
});

test("active descendants keep their ancestry while old completed siblings collapse", () => {
  const parent = node({ state: "completed" });
  const old = node({
    executionId: "exec:00000000-0000-4000-8000-000000000002",
    parentExecutionId: parent.executionId,
    logicalChildId: "d0.1.1",
    depth: 2,
    agentName: "old-review",
    state: "completed",
  });
  const active = node({
    executionId: "exec:00000000-0000-4000-8000-000000000003",
    parentExecutionId: parent.executionId,
    logicalChildId: "d0.1.2",
    depth: 2,
    agentName: "debug",
    state: "running",
  });
  const rendered = renderDashboard(projection([parent, old, active]), {
    color: false, width: 100, completedChildren: 0,
  });
  assert.match(rendered, /review/);
  assert.match(rendered, /debug/);
  assert.doesNotMatch(rendered, /old-review/);
  assert.match(rendered, /… 1 completed subtree/);
});

test("width truncation counts terminal cells and never leaves ANSI color open", () => {
  const rendered = renderDashboard(projection([node({ agentName: "review".repeat(20), state: "refused" })]), {
    color: true, width: 30,
  });
  for (const line of rendered.split("\n")) {
    let activeSgr = false;
    for (const match of line.matchAll(/\u001b\[([0-9;]*)m/g)) {
      activeSgr = match[1] !== "0" && match[1] !== "";
    }
    assert.equal(activeSgr, false, `unterminated ANSI style in ${JSON.stringify(line)}`);
    const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
    const cells = [...plain].reduce((sum, char) => sum + (/\p{Extended_Pictographic}|[\u2E80-\u9FFF\uF900-\uFAFF]/u.test(char) ? 2 : 1), 0);
    assert.ok(cells <= 30, `${cells} cells exceeds width: ${JSON.stringify(plain)}`);
  }
  const narrow = renderDashboard(projection([node()]), { color: false, width: 10 });
  assert.ok(narrow.split("\n").every((line) => [...line].length <= 10), "a narrow split must not be forced to 30 columns");
});

test("C1 terminal controls and Unicode format controls never survive rendering", () => {
  const controls = "bad\u009b31m\u009dtitle\u009c\u202ereversed\u2066isolate\u2069";
  const rendered = renderDashboard(projection([], {
    corrupt: [{ line: 1, reason: controls }],
  }), { color: false, width: 100 });

  assert.doesNotMatch(rendered.replaceAll("\n", ""), /[\p{Cc}\p{Cf}]/u);
  assert.match(rendered, /bad/);
});

test("expanded details show governance identifiers but never task text or child output", () => {
  const rendered = renderDashboard(projection([node({
    workspace: { id: "staging", access: "read", root: "/work/staging" },
  })], {
    corrupt: [{ line: 9, reason: "field task is forbidden" }],
  }), { color: false, width: 100, details: true });

  assert.match(rendered, /grant tool:read/);
  assert.match(rendered, /workspace staging · read/);
  assert.match(rendered, /executor herdr/);
  assert.match(rendered, /correlation run-1/);
  assert.match(rendered, /line 9: field task is forbidden/);
  assert.doesNotMatch(rendered, /SECRET/);
});
