import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_EPISODE_COST_CEILING,
  EpisodeCostGate,
  episodeCostCeilingFromSettings,
} from "../src/governance/episode-cost-gate.ts";

test("the soft threshold warns once at half the episode ceiling and records nothing", async () => {
  const warnings: string[] = [];
  const gates: unknown[] = [];
  const gate = new EpisodeCostGate(DEFAULT_EPISODE_COST_CEILING);

  gate.seedCost("exec:prior", 1.5);
  await gate.observe("exec:a", 0.99, false, {
    warn: (message) => warnings.push(message),
    gate: async (event) => gates.push(event),
  });
  await gate.observe("exec:a", 1, false, {
    warn: (message) => warnings.push(message),
    gate: async (event) => gates.push(event),
  });
  await gate.observe("exec:a", 3, false, {
    warn: (message) => warnings.push(message),
    gate: async (event) => gates.push(event),
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /50%/);
  assert.deepEqual(gates, []);
});

test("crossing the ceiling pauses once and either raises the episode ceiling or stops", async () => {
  const actions: string[] = [];
  const events: unknown[] = [];
  const gate = new EpisodeCostGate(5);
  const first = await gate.observe("exec:a", 5.01, false, {
    warn: () => {},
    pause: async () => actions.push("pause"),
    ask: async () => 8,
    resume: async () => actions.push("resume"),
    gate: async (event) => events.push(event),
  });
  const second = await gate.observe("exec:a", 9, false, {
    warn: () => {},
    pause: async () => actions.push("pause-again"),
    ask: async () => null,
    resume: async () => actions.push("resume-again"),
    gate: async (event) => events.push(event),
  });

  assert.equal(first, "continue");
  assert.equal(second, "continue", "one episode is asked only once");
  assert.deepEqual(actions, ["pause", "resume"]);
  assert.deepEqual(events, [{ cost: 5.01, ceiling: 5, outcome: "continued", newCeiling: 8 }]);

  const stopped = new EpisodeCostGate(5);
  assert.equal(
    await stopped.observe("exec:b", 6, false, {
      warn: () => {},
      pause: async () => {},
      ask: async () => null,
      stop: async () => {},
      gate: async () => {},
    }),
    "stop",
  );
  let stoppedSibling = false;
  await stopped.observe("exec:c", 1, false, {
    warn: () => {},
    stop: async () => {
      stoppedSibling = true;
    },
    gate: async () => assert.fail("the episode gate asked twice"),
  });
  assert.equal(stoppedSibling, true, "a stop answer applies to every concurrent child in the episode");

  let stoppedAfterLedgerFailure = false;
  const failedRecord = new EpisodeCostGate(5);
  await assert.rejects(
    failedRecord.observe("exec:c", 6, false, {
      warn: () => {},
      pause: async () => {},
      ask: async () => 10,
      stop: async () => {
        stoppedAfterLedgerFailure = true;
      },
      gate: async () => {
        throw new Error("ledger failed");
      },
    }),
    /ledger failed/,
  );
  assert.equal(stoppedAfterLedgerFailure, true, "an unrecorded continue must fail closed");
});

test("missing provider usage logs once per episode and cannot fire either threshold", async () => {
  const warnings: string[] = [];
  const gate = new EpisodeCostGate(5);
  const hooks = { warn: (message: string) => warnings.push(message), gate: async () => assert.fail("gate fired") };

  await gate.observe("exec:a", undefined, true, hooks);
  await gate.observe("exec:b", undefined, true, hooks);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no token usage/i);
});

test("settings select a positive episode ceiling and otherwise retain the five-dollar default", () => {
  assert.equal(episodeCostCeilingFromSettings({ episodeCostCeiling: 2.5 }), 2.5);
  assert.equal(episodeCostCeilingFromSettings({ episodeCostCeiling: 0 }), DEFAULT_EPISODE_COST_CEILING);
  assert.equal(episodeCostCeilingFromSettings({ episodeCostCeiling: "10" }), DEFAULT_EPISODE_COST_CEILING);
  assert.equal(episodeCostCeilingFromSettings(undefined), DEFAULT_EPISODE_COST_CEILING);
});
