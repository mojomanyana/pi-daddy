import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildWorkflowFactEvent, verifyLedger } from "../src/ledger.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
import { parseDashboardLedger } from "../src/dashboard-projection.ts";
import { renderDashboard } from "../src/dashboard-render.ts";

const now = new Date("2026-08-28T12:00:00.000Z");

function fact(overrides: Record<string, unknown> = {}) {
  return buildWorkflowFactEvent({
    factId: "fact:00000000-0000-4000-8000-000000000001",
    source: "principal-pi-skills",
    provenance: "planned",
    kind: "workflow_phase",
    subject: "review:quality",
    state: "pending",
    correlation: { run_id: "run-1", policy_label: "principal-feature", assurance_effective: "critical" },
    now,
    ...overrides,
  } as never);
}

test("workflow facts have explicit provenance and identifier-only privacy bounds", () => {
  assert.equal(fact().event, "workflow_fact");
  assert.throws(() => fact({ subject: "Review the secret customer task" }), /subject/i);
  assert.throws(() => fact({ kind: "SECRET task text outside the closed vocabulary" }), /kind/i);
  assert.throws(() => fact({ provenance: "planned", state: "completed" }), /planned.*pending/i);
  assert.throws(() => fact({ provenance: "observed", state: "completed" }), /observed/i);
  assert.throws(() => fact({ correlation: {} }), /run_id/i);
  assert.throws(() => fact({ correlation: { run_id: "run-1", task_text: "SECRET" } }), /task_text/i);
});

test("the public workflow-fact builder cannot emit a timestamp rejected by v3", () => {
  assert.throws(
    () => fact({ now: { toISOString: () => "1" } }),
    /invalid ledger v3 event.*workflow fact/i,
  );
  assert.throws(
    () => fact({ now: { toISOString: () => 1 } }),
    /invalid ledger v3 event.*workflow fact/i,
  );
});

test("the dashboard rejects malformed fact identity rather than accepting a lookalike", () => {
  const malformed = { ...fact(), factId: `fact:${"-".repeat(36)}` };
  const projection = parseDashboardLedger(`${JSON.stringify(malformed)}\n`, { now });
  assert.equal(projection.workflowFacts.length, 0);
  assert.equal(projection.corrupt.length, 1);
});

test("the dashboard rejects provenance/state contradictions instead of upgrading them", () => {
  const contradictory = { ...fact(), state: "completed" };
  const projection = parseDashboardLedger(`${JSON.stringify(contradictory)}\n`, { now });
  assert.equal(projection.workflowFacts.length, 0);
  assert.equal(projection.corrupt.length, 1);
});

test("the canonical ledger reader also reports a contradictory workflow fact as corrupt", async () => {
  const path = join(await tempDir("workflow-fact-ledger-"), "ledger.jsonl");
  await writeFile(path, `${JSON.stringify({ ...fact(), state: "completed" })}\n`);
  const report = await verifyLedger(path);
  assert.equal(report.workflowFacts, 0);
  assert.equal(report.corrupt.length, 1);
});

test("planned, observed and controller-validated facts remain distinct from enforced children", () => {
  const events = [
    fact(),
    fact({
      factId: "fact:00000000-0000-4000-8000-000000000002",
      provenance: "observed", kind: "inline_skill", subject: "build", state: "observed",
    }),
    fact({
      factId: "fact:00000000-0000-4000-8000-000000000003",
      provenance: "controller_validated", kind: "transition", subject: "build-to-review", state: "completed",
    }),
  ];
  const projection = parseDashboardLedger(events.map((event) => JSON.stringify(event)).join("\n"), { now });
  assert.deepEqual(projection.workflowFacts.map((entry) => entry.provenance), [
    "planned", "observed", "controller-validated",
  ]);
  const rendered = renderDashboard(projection, { color: false, width: 100 });
  assert.match(rendered, /P .*review:quality.*pending/);
  assert.match(rendered, /O .*build.*observed/);
  assert.match(rendered, /V .*build-to-review.*completed/);
  assert.doesNotMatch(rendered, /E .*build-to-review/, "controller validation must never be upgraded to enforcement");
});
