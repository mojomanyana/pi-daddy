import assert from "node:assert/strict";
import test from "node:test";
import { grantsCommand } from "../extensions/grants-command.ts";

/**
 * `/grants` is the only surface that tells an operator what an enabled advisor sends off the machine.
 *
 * It had said "sending the task text", which was true of the effort decision point and not of the pruned
 * handoff one — that sends the operator's own session turns, which is the sharper disclosure of the two. A
 * screen that names the smaller egress and omits the larger is worse than one that names neither, because it
 * reads as a complete answer. **The production change that breaks these:** dropping either clause from the
 * advisor line in `grants-command.ts`, or letting a refusal render without its reason.
 */

function render(advisor: { decider: string; taskEgress: "digest" | "raw"; refusal?: string }): Promise<string> {
  let out = "";
  const catalog = { all: [], byKind: () => [] };
  const ctx = {
    ui: { notify: (text: string) => void (out = text) },
    grants: {
      cwd: process.cwd(),
      governed: true,
      ownGrant: ["tool:read"],
      executor: { disclosure: "in-process (test)" },
      advisor,
      observed: true,
      depth: 0,
      maxDepth: 2,
      catalog,
      definitions: new Map(),
      sessionApprovals: new Set(),
      inheritedApprovals: new Map(),
      previewDelegation: async () => assert.fail("no definitions to preview"),
    },
  };
  return grantsCommand.handler("", ctx as never).then(() => out);
}

test("an enabled advisor's line names its task mode and the separate session-turn egress", async () => {
  const digest = (await render({ decider: "jev", taskEgress: "digest" }))
    .split("\n")
    .find((line) => line.includes("advisor"));
  assert.match(digest!, /jev.*task egress digest/);
  assert.match(digest!, /session turns/, "the pruned handoff's separate egress remains disclosed");
  assert.match(await render({ decider: "jev", taskEgress: "raw" }), /task egress raw/);
});

test("an advisor that is off says so, and says why when there is a reason", async () => {
  assert.match(await render({ decider: "none", taskEgress: "digest" }), /advisor {4}off/);
  const refused = await render({
    decider: "none",
    taskEgress: "digest",
    refusal: "settings set model; use PI_DADDY_ADVISOR_MODEL",
  });
  assert.match(refused, /advisor {4}off — settings set model; use PI_DADDY_ADVISOR_MODEL/);
});
