import assert from "node:assert/strict";
import { after, test } from "node:test";
import { grantsCommand } from "../extensions/grants-command.ts";
import { snapshotOf, republishable } from "../extensions/approvals.ts";
import { planWithApprovals, type GatedPlan } from "../extensions/run-delegation.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { classifyToolNames, makeCatalog } from "../src/kernel/catalog.ts";
import { refusal } from "../src/kernel/refusals.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

// These fail if the listing acquires Auto authority, treats status prose as authority, or hides a hard refusal.
async function fixture() {
  const session = createGrantsSession(undefined);
  session.cwd = await tempDir("grants-auto-preview-");
  session.ownGrant = ["agent:build", "tool:read", "tool:bash", "tool:write"];
  session.gated = ["tool:bash", "tool:write"];
  session.depth = 0;
  session.maxDepth = 3;
  session.sessionApprovals.clear();
  session.sessionApprovalBindings.clear();
  session.inheritedApprovals.clear();
  session.definitions = new Map([
    [
      "build",
      { name: "build", description: "Build", allowedTools: "Read, Bash, Write", body: "Build.", source: "/build" },
    ],
  ]);
  session.catalog = makeCatalog([
    ...classifyToolNames(["read", "bash", "write"]),
    { capability: "agent:build", kind: "agentType" },
  ]);
  session.catalogReady = Promise.resolve(session.catalog);
  const effects = { gates: 0, admissions: 0, publications: 0 };
  Object.assign(session, {
    approvalGateFor: () => {
      effects.gates++;
      throw new Error("a preview must not request approval");
    },
  });
  session.publishChildEnv = () => {
    effects.publications++;
  };
  session.autoMode = {
    reference: { socketPath: "/unused-auto-preview.sock", token: "a".repeat(48), ownerId: "b".repeat(32) },
    async read() {
      return { enabled: true, source: "session", ownerId: "b".repeat(32), revision: 0, pendingApprovals: [] };
    },
    async admit() {
      effects.admissions++;
      return true;
    },
    async waitEnabled() {
      assert.fail("a preview must not wait for Auto");
    },
    trackPending() {
      assert.fail("a preview must not create a pending approval");
    },
    async close() {},
  };
  const preview = (name = "build") => planWithApprovals(session, { task: "(preview)", agent: name }, {}, null);
  async function render(autoModeEnabled: boolean | undefined, replacement?: GatedPlan) {
    let output = "";
    let observed: GatedPlan | undefined;
    await grantsCommand.handler("", {
      ui: { notify: (text: string) => void (output = text) },
      grants: {
        cwd: session.cwd,
        governed: true,
        ownGrant: session.ownGrant,
        executor: session.executor,
        // Even ON prose is not enough when the typed observation is false or missing.
        autoModeStatus: "ON (display text)",
        autoModeEnabled,
        observed: true,
        depth: session.depth,
        maxDepth: session.maxDepth,
        catalog: session.catalog,
        definitions: session.definitions,
        sessionApprovals: session.sessionApprovals,
        inheritedApprovals: session.inheritedApprovals,
        snapshotOf: (name: string) => snapshotOf(session, name),
        previewDelegation: async (name: string) => (observed = replacement ?? (await preview(name))),
        runtimeFor: () => ({ modelSource: "default", thinkingSource: "default" }),
      },
    });
    assert.ok(observed);
    const row = output.split("\n").find((line) => /^\s+(?:AUTO|BLOCK|allow)  build  /.test(line));
    assert.ok(row, output);
    return { row, observed };
  }
  function assertReadOnly() {
    assert.deepEqual(effects, { gates: 0, admissions: 0, publications: 0 });
    assert.equal(session.sessionApprovals.size, 0);
    assert.equal(session.sessionApprovalBindings.size, 0);
    assert.deepEqual(republishable(session), []);
  }
  return { session, preview, render, assertReadOnly };
}

test("/grants reports Auto at dispatch without acquiring approval; OFF and unknown still block", async () => {
  const f = await fixture();
  for (const enabled of [true, false, undefined]) {
    const { row, observed } = await f.render(enabled);
    assert.equal(observed.plan.ok, false);
    assert.equal(observed.plan.refusal?.code, "GATED_UNAPPROVED");
    assert.deepEqual(observed.approval?.approved, []);
    assert.deepEqual(observed.plan.result?.gatedBlocked, ["tool:bash", "tool:write"]);
    if (enabled === true) {
      assert.match(row, /^\s+AUTO  build  /);
      assert.match(row, /tool:bash, tool:write.*Auto.*approval at dispatch.*live state.*rechecked/);
      assert.doesNotMatch(row, /requires explicit approval|\ballow\b/);
    } else {
      assert.match(row, /^\s+BLOCK  build  /);
      assert.match(row, /tool:bash, tool:write requires explicit approval/);
    }
    f.assertReadOnly();
  }
});

test("/grants keeps hard planner refusals and approval-flow errors blocked while Auto is ON", async () => {
  const cases: { code: string; change(f: Awaited<ReturnType<typeof fixture>>): void }[] = [
    {
      code: "DEFINITION_NOT_AUTHORIZED",
      change: ({ session }) => (session.ownGrant = ["tool:read", "tool:bash", "tool:write"]),
    },
    {
      code: "CAPABILITY_ESCALATION",
      change: ({ session }) => (session.ownGrant = ["agent:build", "tool:read", "tool:write"]),
    },
    { code: "DEPTH_EXCEEDED", change: ({ session }) => (session.maxDepth = 0) },
    {
      code: "UNKNOWN_TOOL",
      change: ({ session }) => (session.definitions.get("build")!.allowedTools = "Read, Bash, absent"),
    },
  ];
  for (const item of cases) {
    const f = await fixture();
    item.change(f);
    const { row, observed } = await f.render(true);
    assert.equal(observed.plan.refusal?.code, item.code);
    assert.match(row, /^\s+BLOCK  build  /, item.code);
    assert.ok(row.includes(observed.plan.reason!), row);
    assert.doesNotMatch(row, /Auto supplies|approval at dispatch/);
    f.assertReadOnly();
  }

  const f = await fixture();
  const failed = await f.preview();
  assert.ok(failed.plan.result!.gatedBlocked.length > 0);
  const reason = "grants: approval flow failed, denying (fixture error)";
  failed.plan = { ...failed.plan, reason, refusal: refusal("APPROVAL_FLOW_FAILED", reason) };
  const before = structuredClone(failed);
  const { row } = await f.render(true, failed);
  assert.match(row, /^\s+BLOCK  build  /);
  assert.ok(row.includes(reason), row);
  assert.deepEqual(failed, before, "rendering must not rewrite an execution result");
  f.assertReadOnly();
});
