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

function render(
  advisor: { decider: string; taskEgress: "digest" | "raw"; refusal?: string },
  definition = false,
): Promise<string> {
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
      definitions: definition
        ? new Map([
            [
              "review",
              { name: "review", description: "review", allowedTools: "Read", body: "review", source: "/review" },
            ],
          ])
        : new Map(),
      sessionApprovals: new Set(),
      inheritedApprovals: new Map(),
      previewDelegation: async () => ({
        plan: { ok: true, effective: ["tool:read"] },
      }),
      runtimeFor: () => ({
        model: "anthropic/claude-opus-4-6",
        modelSource: "definition",
        thinking: "high",
        thinkingSource: "definition",
      }),
    },
  };
  return grantsCommand.handler("", ctx as never).then(() => out);
}

test("retired advisor fields do not advertise or activate a runtime adviser", async () => {
  const output = await render({ decider: "jev", taskEgress: "raw" });
  assert.doesNotMatch(output, /advisor|task egress|session turns/);
});

test("/grants shows each definition's model and thinking with sources", async () => {
  const output = await render({ decider: "none", taskEgress: "digest" }, true);
  assert.match(output, /review.*model anthropic\/claude-opus-4-6 \(definition\)/);
  assert.match(output, /thinking high \(definition\)/);
});
