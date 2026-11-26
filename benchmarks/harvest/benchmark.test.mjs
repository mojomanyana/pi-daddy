import assert from "node:assert/strict";
import { test } from "node:test";
import { pairedRun, summarize, cases, corpusHash } from "./benchmark.mjs";
import { hasHarvestSignal, harvestClassifierDigest } from "../../packages/pi-daddy/src/products/session-harvest.ts";

test("paired control scores production chat decisions and typed probabilities on the same blinded turns", async () => {
  assert.equal(corpusHash, "b736a2dc817d693840f81233a04708ca365f1eed466d15e561ae9d862897642d");
  const chat = { provider: "fixture", id: "fast", reasoning: false };
  const decision = { provider: "github-copilot", id: "gpt-6-luna-decisions" };
  const requests = [];
  const eligible = cases.filter((c) => hasHarvestSignal(c.signals));
  const registry = {
    find: () => chat,
    hasConfiguredAuth: () => true,
    streamSimple(_model, { messages }) {
      const text = messages[0].content[0].text;
      requests.push(["baseline", text.slice(text.indexOf("\n\nPrompt: ") + 2)]);
      return {
        result: async () => ({
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: '{"harvest":false,"category":"trivial","confidence":1,"reason":"fixture","scenarioId":"fixture"}',
            },
          ],
        }),
      };
    },
    async classify(model, { state, questions }) {
      assert.equal(model, decision);
      assert.deepEqual(Object.keys(state), ["turn"]);
      assert.equal(questions.save.type, "bool");
      requests.push(["luna", state.turn]);
      return {
        stopReason: "stop",
        answers: { save: { type: "bool", probability: 0.75 } },
        usage: { totalTokens: 2, cost: { total: 0, totalFromProvider: false } },
      };
    },
  };
  const rows = [];
  await pairedRun(registry, { baseline: chat, luna: decision, blockers: [] }, (row) => rows.push(row));
  assert.equal(requests.length, 110);
  for (const [i, c] of eligible.entries()) {
    const digest = harvestClassifierDigest(c.signals);
    const order = i % 2 ? ["luna", "baseline"] : ["baseline", "luna"];
    assert.deepEqual(
      requests.slice(2 * i, 2 * i + 2),
      order.map((arm) => [arm, digest]),
    );
  }
  const summary = summarize(rows);
  assert.equal(summary.observed, 60);
  assert.deepEqual(summary.sharedGateMisses, ["H48"]);
  assert.equal(summary.arms.baseline.missedEligible, 29);
  assert.equal(summary.arms.baseline.missedEndToEnd, 30);
  assert.equal(summary.arms.luna.falseSaves, 26);
  assert.equal(summary.arms.luna.missedEndToEnd, 1);
  assert.equal(summary.disagreements.length, 55);
  assert.deepEqual(summary.arms.luna.estimatedUsd, { reportingCalls: 55, total: 0 });
  assert.deepEqual(summary.arms.luna.billedUsd, { reportingCalls: 0, total: null });
});

test("partial and malformed results preserve production behavior and record response failures", async () => {
  const chat = { provider: "fixture", id: "fast", reasoning: false };
  let count = 0;
  const registry = {
    find: () => chat,
    hasConfiguredAuth: () => true,
    streamSimple: () => ({
      result: async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: 'prefix {"harvest":true,"category":"thrash","confidence":0.8}' }],
      }),
    }),
    classify: async () =>
      ++count === 1
        ? { stopReason: "stop", answers: { save: { type: "bool", probability: 2 } } }
        : { stopReason: "error" },
  };
  const rows = [];
  await assert.rejects(
    pairedRun(registry, { baseline: chat, luna: {}, blockers: [] }, (row) => rows.push(row)),
    /request failed/,
  );
  const eligible = rows.filter((row) => row.eligible);
  assert.equal(eligible.length, 2);
  assert.equal(eligible[0].baseline.save, true);
  assert.equal(eligible[0].baseline.status, "invalid-response");
  assert.equal(eligible[0].luna.save, false);
  assert.equal(eligible[0].luna.status, "invalid-response");
  assert.equal(eligible[1].luna.status, "request-error");
});
