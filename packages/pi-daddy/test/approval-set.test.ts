import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createGrantsSession } from "../extensions/session.ts";
import { obtainApprovals, snapshotOf, storedApprovals } from "../extensions/approvals.ts";
import { approvalsPath, saveApproval } from "../src/governance/approval-store.ts";
import { createApprovalGate, SCOPE_LABELS } from "../src/governance/approval-prompt.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
const capabilities = ["tool:bash", "tool:edit", "tool:write"];

async function fixture(answer: string) {
  const session = createGrantsSession(undefined);
  session.cwd = await tempDir("permission-set-project-");
  session.depth = 0;
  session.publishChildEnv = () => {};
  session.definitions.set("builder", {
    name: "builder",
    description: "Build a change",
    allowedTools: "Bash Edit Write",
    body: "Implement the selected task.",
    source: "/selected/builder/SKILL.md",
  });
  const titles: string[] = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      notify() {},
      async select(title: string) {
        titles.push(title);
        return answer;
      },
    },
  };
  return { session, titles, ctx };
}

for (const scope of ["once", "session", "always"] as const) {
  test(`one exact-set ${scope} choice preserves each permission's record`, async () => {
    const old = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = await tempDir("permission-set-agent-");
    try {
      const { session, ctx, titles } = await fixture(SCOPE_LABELS[scope]);
      const outcome = await obtainApprovals(session, capabilities, "builder", "definition", ctx, "Fix queue sorting.");
      assert.equal(titles.length, 1);
      assert.match(titles[0], /3 permissions/);
      for (const phrase of ["run shell commands", "edit files", "write files"]) assert.ok(titles[0].includes(phrase));
      assert.deepEqual(outcome.approved, capabilities);
      assert.deepEqual(outcome.recordedScopes, Object.fromEntries(capabilities.map((cap) => [cap, scope])));
      assert.deepEqual(outcome.sources, Object.fromEntries(capabilities.map((cap) => [cap, "prompt"])));
      assert.equal(session.sessionApprovals.size, scope === "once" ? 0 : 3);
      assert.equal(outcome.banked?.length, scope === "once" ? 0 : 3);
      if (scope === "once") assert.deepEqual(Object.keys(outcome.uses), capabilities);
      if (scope === "always") {
        const saved = JSON.parse(await readFile(approvalsPath(session.cwd), "utf8"));
        assert.deepEqual(
          Object.keys(saved.approvals).sort(),
          capabilities.map((cap) => `${cap}@builder`),
        );
        assert.ok(
          Object.values(saved.approvals).every((entry) => !JSON.stringify(entry).includes("Fix queue sorting")),
        );
      }
    } finally {
      if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = old;
    }
  });
}

test("a denied permission set grants nothing and excludes already-held permissions from the question", async () => {
  const { session, ctx, titles } = await fixture("Deny");
  session.sessionApprovals.add("tool:write@builder");
  const result = await obtainApprovals(session, capabilities, "builder", "definition", ctx);
  assert.equal(titles.length, 1);
  assert.match(titles[0], /2 permissions/);
  assert.doesNotMatch(titles[0], /• write files/);
  assert.deepEqual(result.approved, ["tool:write"]);
  assert.equal(result.humanDenied, true);
  assert.equal(result.gateOutcome, "declined");
  assert.deepEqual(result.banked, []);
  assert.equal(session.sessionApprovals.size, 1);
});

test("changed instructions require a new exact-set answer and say why", async () => {
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await tempDir("permission-recheck-agent-");
  try {
    const { session, ctx, titles } = await fixture("Deny");
    const prior = snapshotOf(session, "builder")!;
    for (const capability of capabilities)
      assert.equal(
        await saveApproval(
          session.cwd,
          `${capability}@builder`,
          {
            approvedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            cwd: session.cwd,
            grantAtApproval: prior.ceiling,
            bodyAtApproval: prior.bodySha256,
          },
          (name) => snapshotOf(session, name),
          new Date(),
        ),
        true,
      );
    session.definitions.get("builder")!.body = "Different instructions require different approval.";
    const preview = await storedApprovals(session, capabilities, "builder");
    assert.deepEqual(preview.approved, []);
    assert.deepEqual(preview.needsPrompt, capabilities);
    const result = await obtainApprovals(session, capabilities, "builder", "definition", ctx);
    assert.equal(titles.length, 1);
    assert.match(titles[0], /agent instructions changed/);
    assert.deepEqual(result.approved, []);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
});

const request = (caps: string[]) => ({
  capability: caps[0]!,
  capabilities: caps,
  subject: "builder",
  path: "definition" as const,
});
for (const answer of [SCOPE_LABELS.session, SCOPE_LABELS.once, "Deny"]) {
  test(`concurrent exact permission sets preserve ${answer} semantics`, async () => {
    const titles: string[] = [];
    const gate = createApprovalGate({
      hasUI: true,
      mode: "tui",
      ui: {
        notify() {},
        async select(title) {
          titles.push(title);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return answer;
        },
      },
    });
    const results = await Promise.all([
      gate.request(request(capabilities)),
      gate.request(request([...capabilities].reverse())),
    ]);
    assert.equal(titles.length, answer === SCOPE_LABELS.once ? 2 : 1);
    assert.equal(results[1].joined ?? false, answer !== SCOPE_LABELS.once);
    if (answer === "Deny") assert.ok(results.every((result) => result.scope === null));
  });
}

test("overlapping but different permission sets never share a dialog", async () => {
  let count = 0;
  const gate = createApprovalGate({
    hasUI: true,
    mode: "tui",
    ui: {
      notify() {},
      async select() {
        count++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return SCOPE_LABELS.session;
      },
    },
  });
  const results = await Promise.all([gate.request(request(capabilities)), gate.request(request(["tool:bash"]))]);
  assert.equal(count, 2);
  assert.ok(results.every((result) => !result.joined));
  assert.equal((await gate.request({ ...request(capabilities), capabilities: [] })).kind, "error");
});

test("canceling a pending exact set cannot bank any member", async () => {
  const { session, ctx } = await fixture(SCOPE_LABELS.session);
  const controller = new AbortController();
  ctx.ui.select = async () => {
    controller.abort();
    return SCOPE_LABELS.session;
  };
  const result = await obtainApprovals(
    session,
    capabilities,
    "builder",
    "definition",
    ctx,
    "Do work",
    controller.signal,
  );
  assert.equal(result.gateOutcome, "aborted");
  assert.deepEqual(result.approved, []);
  assert.deepEqual(result.banked, []);
  assert.equal(session.sessionApprovals.size, 0);
});
