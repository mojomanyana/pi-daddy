/** Provisional Auto observations are not consumed step approvals in a chain that never starts. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { createGrantsSession } from "../extensions/session.ts";
import { registerChainTool } from "../extensions/delegate-chain.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);

test("Auto ON for an early permission set then OFF and denial never records an unadmitted Auto use", async () => {
  const root = await tempDir("chain-auto-preflight-");
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const ownGrant = ["tool:delegate", "tool:write", "tool:bash", "agent:first", "agent:second"];
    const session = createGrantsSession(undefined, {
      root: { PI_DADDY_GRANT: ownGrant.join(","), PI_DADDY_FANOUT: "6" },
    });
    session.ownerBound = true;
    session.cwd = root;
    session.ledgerPath = join(root, "ledger.jsonl");
    session.gated = ["tool:write", "tool:bash"];
    session.publishChildEnv = () => {};
    for (const name of ["first", "second"])
      session.definitions.set(name, {
        name,
        description: "test role",
        allowedTools: "Write Bash",
        body: "Test role.",
        source: join(root, name, "SKILL.md"),
      });
    session.delegationContext = async () => ({
      ownGrant,
      depth: 0,
      maxDepth: 2,
      gated: session.gated,
      definitions: session.definitions,
    });
    let reads = 0,
      admissions = 0,
      prompts = 0;
    session.autoMode = {
      read: async () => ({
        enabled: ++reads === 1,
        source: "session",
        ownerId: "fixture",
        revision: reads,
        pendingApprovals: [],
      }),
      admit: async () => {
        admissions++;
        throw Error("No step may be admitted");
      },
      trackPending: () => () => {},
      waitEnabled: async (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(Error("Stopped")), { once: true });
        }),
      close: async () => {},
    } as never;
    let tool: any;
    registerChainTool(
      {
        registerTool: (value: unknown) => {
          tool = value;
        },
      } as never,
      session,
    );
    await assert.rejects(
      () =>
        tool.execute(
          "auto-boundary",
          {
            steps: [
              { agent: "first", task: "First task" },
              { agent: "second", task: "Second task: {previous}" },
            ],
          },
          undefined,
          undefined,
          {
            cwd: root,
            mode: "tui",
            hasUI: true,
            ui: {
              notify() {},
              async select() {
                prompts++;
                return "Deny";
              },
            },
          },
        ),
      /chain refused/,
    );
    assert.equal(prompts, 1);
    assert.equal(admissions, 0);
    assert.equal(session.sessionApprovals.size, 0);
    const rows = (await readFile(session.ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).body);
    assert.ok(!rows.some((row) => row.event === "child_started"));
    assert.ok(
      !rows.some((row) => Object.values(row.approvalSources ?? {}).includes("auto")),
      "unadmitted Auto is not an approval fact",
    );
    assert.ok(!rows.some((row) => Object.keys(row.approvalUses ?? {}).length), "no use was consumed");
    assert.ok(rows.some((row) => row.agentType === "second" && row.humanDenied));
  } finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
  }
});
