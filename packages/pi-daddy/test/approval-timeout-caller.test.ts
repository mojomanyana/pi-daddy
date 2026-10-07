import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createGrantsSession } from "../extensions/session.ts";
import { obtainApprovals } from "../extensions/approvals.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);

test("actual approval caller ignores unused malformed timeout for existing and no-UI authority paths", async () => {
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldTimeout = process.env.PI_DADDY_APPROVAL_TIMEOUT;
  process.env.PI_CODING_AGENT_DIR = await tempDir("approval-timeout-agent-");
  process.env.PI_DADDY_APPROVAL_TIMEOUT = "bad";
  try {
    const session = createGrantsSession(undefined);
    session.cwd = await tempDir("approval-timeout-cwd-");
    let selects = 0;
    const ctx = {
      hasUI: true,
      mode: "interactive",
      ui: {
        notify() {},
        async select() {
          selects++;
          return "Allow for this session";
        },
      },
    };
    session.sessionApprovals.add("tool:bash@<delegate>");
    const existing = await obtainApprovals(session, ["tool:bash"], "<delegate>", "delegate", ctx);
    assert.deepEqual(existing.approved, ["tool:bash"]);
    assert.equal(existing.sources["tool:bash"], "session");
    session.sessionApprovals.clear();
    const noUI = await obtainApprovals(session, ["tool:bash"], "<delegate>", "delegate", { ...ctx, hasUI: false });
    assert.equal(noUI.gateOutcome, "no-ui");
    const required = await obtainApprovals(session, ["tool:bash"], "<delegate>", "delegate", ctx);
    assert.equal(required.gateOutcome, "error");
    assert.deepEqual(required.approved, []);
    assert.equal(session.sessionApprovals.size, 0);
    assert.equal(selects, 0, "malformed needed setting refuses before calling the UI");
    process.env.PI_DADDY_APPROVAL_TIMEOUT = "2";
    const valid = await obtainApprovals(session, ["tool:bash"], "<delegate>", "delegate", ctx);
    assert.deepEqual(valid.approved, ["tool:bash"]);
    assert.equal(selects, 1);
  } finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldTimeout === undefined) delete process.env.PI_DADDY_APPROVAL_TIMEOUT;
    else process.env.PI_DADDY_APPROVAL_TIMEOUT = oldTimeout;
  }
});
