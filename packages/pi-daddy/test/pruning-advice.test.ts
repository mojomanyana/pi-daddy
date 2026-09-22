import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdvisor, type AdviceRecord } from "../src/advisors/advisor.ts";
import { nullDecider, type Decider } from "../src/advisors/decider.ts";
import { advisePruning, MAX_JUDGED_TURNS, PRUNING_PURPOSE } from "../extensions/pruning-advice.ts";
import { createHandoffStager } from "../extensions/context-staging.ts";

const entriesOf = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `t${i}`, type: "message", message: `turn ${i}` }));
const parentSessionOf = (count: number) => ({ getEntries: () => entriesOf(count), getSessionFile: () => undefined });

/** Keeps the candidate at `keepIndexes`, drops the rest. */
function judging(keepIndexes: number[], records: AdviceRecord[] = []) {
  const decider: Decider = {
    name: "fake",
    decide: async (request) => ({
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key, index) => [
          key,
          { kind: "noul" as const, value: keepIndexes.includes(index) },
        ]),
      ),
    }),
  };
  return createAdvisor({ decider, record: (r) => void records.push(r), enabled: true });
}

const GRANTED = { mode: "pruned" as const, turns: 4 };
const stagerFor = (parentSession: ReturnType<typeof parentSessionOf>) =>
  createHandoffStager({ cwd: "/tmp", forkRoot: "/tmp/forks", parentSession });

/**
 * ADR-0077's second decision point. The rule keeps recent turns; an advisor can judge them against the task the
 * child is about to be given. The only verb it has is "drop".
 */

test("advice narrows the rule's selection, and the record says which rule ran", async () => {
  // Breaks by: not passing the ids to staging, or ignoring them there.
  const parentSession = parentSessionOf(8);
  const records: AdviceRecord[] = [];
  const kept = await advisePruning({
    session: { advisorSession: { advisor: judging([0], records) }, parentSession },
    granted: GRANTED,
    task: "do the thing",
  });
  assert.deepEqual(kept, ["t4"], "the first of the four candidates the rule offered");
  assert.equal(records[0].purpose, PRUNING_PURPOSE);

  const stage = stagerFor(parentSession);
  assert.equal(stage(GRANTED).record?.keptTurns, 4, "the rule alone keeps four");
  const advised = stage(GRANTED, { keepTurnIds: kept });
  assert.equal(advised.record?.keptTurns, 1);
  assert.equal(advised.record?.droppedTurns, 7);
  assert.equal(advised.record?.rule, "recent+files+advice", "the ledger says advice was involved");
});

test("a selector can only take turns away, whatever it returns", async () => {
  // The safety property, and the reason this is advice rather than authority. Staging intersects the ids with the
  // candidates the deterministic rule produced, so an invented id, an id from another session, or every id in
  // existence all add nothing. Breaks by: trusting `keepTurnIds` instead of intersecting.
  const stage = stagerFor(parentSessionOf(8));
  const ruleAlone = stage(GRANTED).record?.keptTurns ?? 0;

  const invented = stage(GRANTED, { keepTurnIds: ["t99", "not-a-turn", "../../etc/passwd"] });
  assert.equal(invented.record?.keptTurns, 0, "an id the rule never offered cannot become a turn");

  const olderThanTheWindow = stage(GRANTED, { keepTurnIds: ["t0", "t1"] });
  assert.equal(olderThanTheWindow.record?.keptTurns, 0, "a turn the rule dropped stays dropped");

  const everything = stage(GRANTED, { keepTurnIds: entriesOf(8).map((e) => e.id) });
  assert.equal(everything.record?.keptTurns, ruleAlone, "asking for all of them yields the rule's own selection");
});

test("no advisor, no answer, or an answer that drops everything leaves the rule's selection standing", async () => {
  // The property that keeps advisors optional: without one, `pruned` behaves exactly as it does today.
  // Breaks by: returning [] when the advisor keeps nothing, which would hand a child an empty handoff.
  const parentSession = parentSessionOf(8);
  const base = { granted: GRANTED, task: "t" };
  const none = createAdvisor({ decider: nullDecider, record: () => {} });
  assert.equal(
    await advisePruning({ ...base, session: { advisorSession: { advisor: none }, parentSession } }),
    undefined,
    "no advisor",
  );
  assert.equal(
    await advisePruning({ ...base, session: { advisorSession: { advisor: judging([]) }, parentSession } }),
    undefined,
    "an advisor that drops every candidate is answering a different question",
  );
  assert.equal(
    await advisePruning({ ...base, session: { advisorSession: { advisor: judging([0]) } } }),
    undefined,
    "no parent session to prune",
  );
  assert.equal(
    await advisePruning({
      ...base,
      granted: { mode: "summary", summary: "s" },
      session: { advisorSession: { advisor: judging([0]) }, parentSession },
    }),
    undefined,
    "only the pruned mode has turns to choose between",
  );
});

test("an unbounded number of candidates is not judged at all", async () => {
  // One question per candidate, on a path a human is waiting on. Beyond the bound the rule stands, which is the
  // safe direction. Breaks by: removing the MAX_JUDGED_TURNS check, which sends an unbounded request.
  const parentSession = parentSessionOf(MAX_JUDGED_TURNS + 10);
  let asked = 0;
  const counting = createAdvisor({
    decider: { name: "count", decide: async () => (asked++, null) },
    record: () => {},
    enabled: true,
  });
  const many = await advisePruning({
    session: { advisorSession: { advisor: counting }, parentSession },
    granted: { mode: "pruned", turns: MAX_JUDGED_TURNS + 5 },
    task: "t",
  });
  assert.equal(many, undefined);
  assert.equal(asked, 0, "nothing was asked");

  // And one candidate is not a selection either.
  await advisePruning({
    session: { advisorSession: { advisor: counting }, parentSession },
    granted: { mode: "pruned", turns: 1 },
    task: "t",
  });
  assert.equal(asked, 0);
});

test("the task reaches the advisor in the question and never reaches the record", async () => {
  // The same rule the effort decision point follows: sent so it can be judged, never stored (ADR-0021).
  // Breaks by: putting the task in `state` and then into the record, or recording the question text.
  const records: AdviceRecord[] = [];
  let sawTask = false;
  const spy = createAdvisor({
    decider: {
      name: "spy",
      decide: async (request) => {
        sawTask = Object.values(request.questions).some(
          (q) => q.kind === "noul" && q.instructions.includes("SECRET-TASK"),
        );
        assert.deepEqual(request.state, {}, "the state carries nothing; the questions carry it all");
        return null;
      },
    },
    record: (r) => void records.push(r),
    enabled: true,
  });
  await advisePruning({
    session: { advisorSession: { advisor: spy }, parentSession: parentSessionOf(8) },
    granted: GRANTED,
    task: "SECRET-TASK",
  });
  assert.equal(sawTask, true, "an advisor cannot judge a task it cannot see");
  assert.doesNotMatch(JSON.stringify(records), /SECRET-TASK/, "and it is still never written down");
});
