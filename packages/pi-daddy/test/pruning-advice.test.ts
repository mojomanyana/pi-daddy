import { DEFAULT_CONTEXT_TURNS } from "../src/kernel/context-handoff.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdvisor, type AdviceRecord } from "../src/advisors/advisor.ts";
import { nullDecider, type Decider } from "../src/advisors/decider.ts";
import { advisePruning, MAX_JUDGED_TURNS, PRUNING_PURPOSE } from "../extensions/pruning-advice.ts";
import { createHandoffStager } from "../extensions/context-staging.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { handoffPlanContext } from "../extensions/run-delegation.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { after } from "node:test";

after(cleanupTempDirs);
import { ADVISOR_KEY_ENV, ENV_ADVISOR } from "../src/advisors/settings.ts";

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
const executionId = "exec:00000000-0000-4000-8000-000000000001";
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
    executionId,
  });
  assert.deepEqual(kept, ["t4"], "the first of the four candidates the rule offered");
  assert.equal(records[0].purpose, PRUNING_PURPOSE);
  assert.equal(records[0].executionId, executionId);

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

test("beyond the bound the OLDEST candidates go unjudged and are kept, and the request stays bounded", async () => {
  // **Changed 2026-09-22, and the old behaviour is the reason.** This asserted that beyond `MAX_JUDGED_TURNS`
  // nothing was asked at all. That was fine while the rule offered six turns, and became a silent feature
  // death the moment `DEFAULT_CONTEXT_TURNS` rose to 20: every default request would exceed the bound, so the
  // pruning decision point would never fire again. Judging a SUBSET is still only narrowing — an unjudged turn
  // is kept, never dropped — so nothing about attenuation changes.
  //
  // Breaks by: removing the slice and asking one question per candidate, which sends an unbounded request on a
  // path a human is waiting on; or by dropping the unjudged ids from the result, which turns "not judged" into
  // "dropped" and makes the advisor able to do more than narrow.
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
  assert.equal(many, undefined, "a decider that answers nothing still leaves the rule's selection standing");
  assert.equal(asked, 1, "exactly one bounded request, not one per candidate and not none at all");

  // The bound holds: whatever the rule offered, only MAX_JUDGED_TURNS questions are ever sent.
  let sent = 0;
  const counted = createAdvisor({
    decider: {
      name: "size",
      decide: async (request) => {
        sent = Object.keys(request.questions).length;
        return null;
      },
    },
    record: () => {},
    enabled: true,
  });
  await advisePruning({
    session: { advisorSession: { advisor: counted }, parentSession },
    granted: { mode: "pruned", turns: MAX_JUDGED_TURNS + 5 },
    task: "t",
  });
  assert.equal(sent, MAX_JUDGED_TURNS, `the request must carry at most ${MAX_JUDGED_TURNS} questions, saw ${sent}`);

  // And one candidate is not a selection either: nothing further is asked.
  const before = asked;
  await advisePruning({
    session: { advisorSession: { advisor: counting }, parentSession },
    granted: { mode: "pruned", turns: 1 },
    task: "t",
  });
  assert.equal(asked, before, "a single candidate is not a choice, so no question is sent");
});

test("pruning receives the task digest and neither task text nor paths reach the record", async () => {
  // Breaks by: bypassing the same default-off task-egress policy as effort advice, or recording question text.
  const records: AdviceRecord[] = [];
  let instructions = "";
  const spy = createAdvisor({
    decider: {
      name: "spy",
      decide: async (request) => {
        instructions = Object.values(request.questions)
          .filter((q) => q.kind === "noul")
          .map((q) => q.instructions)
          .join("\n");
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
    task: "Change private/SECRET-TASK.ts",
  });
  assert.match(instructions, /"language":"typescript"/);
  assert.doesNotMatch(instructions, /private\/SECRET-TASK|Change /, "raw task text and paths stay local");
  assert.doesNotMatch(JSON.stringify(records), /SECRET-TASK/, "and they are still never written down");
  assert.equal(records[0].taskEgress, "digest");
});

test("the current delegation tool call stays local and remains unjudged", async () => {
  // Pi persists the assistant message before executing its tool calls. Breaks by: sending that current turn as a
  // PART, which re-exports the raw task argument despite digest mode, or by treating exclusion as rejection.
  const current = {
    id: "current",
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-current",
          name: "delegate",
          arguments: { task: "SECRET TASK", context: { files: ["private/secret.ts"] } },
        },
      ],
    },
  };
  const parentSession = { getEntries: () => [...entriesOf(5), current] };
  let sent = "";
  const advisor = createAdvisor({
    decider: {
      name: "spy",
      decide: async (request) => {
        sent = JSON.stringify(request);
        return {
          answers: Object.fromEntries(
            Object.keys(request.questions).map((key) => [key, { kind: "noul" as const, value: true }]),
          ),
        };
      },
    },
    record: () => {},
    enabled: true,
  });
  const kept = await advisePruning({
    session: { advisorSession: { advisor }, parentSession },
    granted: { mode: "pruned", turns: 6 },
    task: "SECRET TASK",
    toolCallId: "call-current",
  });
  assert.doesNotMatch(sent, /SECRET TASK|private\/secret\.ts|call-current/);
  assert.ok(kept?.includes("current"), "not shown to the advisor means kept, not rejected");
});

test("the ids reach staging through the session's own hook, not just through a direct call", async () => {
  // The defect this test exists for: `stageHandoff` was declared as `(granted) => stager(granted)`, a
  // one-parameter arrow assignable to the two-parameter type, so the ids arrived at the hook and were dropped. The
  // advisor was still asked and the task and turns still left the machine; only the narrowing was lost. Every
  // other test called `createHandoffStager` directly and so could not see it. TypeScript cannot either.
  //
  // Breaks by: dropping `options` from the arrow in `session.ts`'s `delegationContext`.
  const session = createGrantsSession(undefined);
  session.parentSession = parentSessionOf(8);
  const context = await session.delegationContext();
  assert.ok(context.stageHandoff, "the session supplies a staging hook");

  const wide = context.stageHandoff!(GRANTED, {});
  assert.equal(wide.record?.keptTurns, 4, "with no ids, the rule's own selection");

  const narrowed = context.stageHandoff!(GRANTED, { keepTurnIds: ["t4"] });
  assert.equal(narrowed.record?.keptTurns, 1, "the ids must survive the hop into the stager");
  assert.equal(narrowed.record?.rule, "recent+files+advice");
});

test("a partial advisor response is no advice, not a narrowing nobody asked for", async () => {
  // Eleven of twelve answers missing would otherwise read as "drop eleven". Breaks by: filtering on
  // `answer?.kind === "noul" && answer.value` instead of requiring every candidate to come back.
  const partial = createAdvisor({
    decider: {
      name: "partial",
      decide: async (request) => ({
        answers: { [Object.keys(request.questions)[0]]: { kind: "noul" as const, value: true } },
      }),
    },
    record: () => {},
    enabled: true,
  });
  const kept = await advisePruning({
    session: { advisorSession: { advisor: partial }, parentSession: parentSessionOf(8) },
    granted: GRANTED,
    task: "t",
  });
  assert.equal(kept, undefined, "an answer to one of four questions is not an answer");
});

test("the workspace settings file cannot choose the advisor's destination or lengthen its bound", async () => {
  // `.pi/pi-daddy/settings.json` is writable by any child holding `tool:write`. A model is a destination and a
  // longer timeout is not a narrowing; letting the file set either would be the shape 0.35.0 exists to close.
  // Breaks by: reading `model` from the block, or taking `timeoutMs` without clamping.
  const { advisorSettingsFrom } = await import("../src/advisors/settings.ts");
  const on = { [ENV_ADVISOR]: "jev", [ADVISOR_KEY_ENV]: "k" } as NodeJS.ProcessEnv;
  assert.match(String(advisorSettingsFrom({ model: "openai/gpt-4o" }, on).refusal), /not a narrowing/);
  assert.equal(advisorSettingsFrom({ model: "openai/gpt-4o" }, on).enabled, false);
  assert.equal(advisorSettingsFrom({ timeoutMs: 30000 }, on).timeoutMs, 2000, "clamped, never raised");
  assert.equal(advisorSettingsFrom({ timeoutMs: 500 }, on).timeoutMs, 500, "a shorter bound is a narrowing");

  // And the one control the file keeps must fail CLOSED: anything that is not exactly `true` disables.
  for (const enabled of [false, "false", 0, null]) {
    const settings = advisorSettingsFrom({ enabled }, on);
    assert.equal(settings.enabled, false, `enabled: ${JSON.stringify(enabled)} must not leave the advisor on`);
    assert.match(String(settings.refusal), /not true for this project/);
  }

  // A key name is echoed back into the /grants panel, and this file is child-writable.
  const forged = advisorSettingsFrom({ "\u001b[31mowned\n  grant      tool:*": 1 }, on);
  assert.doesNotMatch(String(forged.refusal), /\u001b|\n/, "no control characters reach a trust surface");
});

test("an advisor is not asked for a delegation that is already refused, nor before the handoff is authorised", async () => {
  // Both were fixed by hand and forced by nothing: reviewers restored each defective version and the whole suite
  // stayed green. Breaks by: dropping the `blocked` guard, or asking before the preview plan carries the handoff.
  let asked = 0;
  const counting = createAdvisor({
    decider: { name: "count", decide: async () => (asked++, null) },
    record: () => {},
    enabled: true,
  });
  const session = { advisorSession: { advisor: counting }, parentSession: parentSessionOf(8) };
  const base = { fanoutBudget: 4 };

  const blocked = await handoffPlanContext({
    session,
    base,
    task: "t",
    blocked: true,
    preview: async () => {
      throw new Error("a refused delegation must not even be planned for advice");
    },
  });
  assert.deepEqual(blocked, base, "nothing added");
  assert.equal(asked, 0, "a doomed delegation ships nothing to a third party");

  const refusedHandoff = await handoffPlanContext({
    session,
    base,
    task: "t",
    blocked: false,
    preview: async () => ({}), // the plan carries no handoff: the grant or the ceiling refused it
  });
  assert.deepEqual(refusedHandoff, base);
  assert.equal(asked, 0, "a handoff the grant refuses ships nothing either");

  const otherMode = await handoffPlanContext({
    session,
    base,
    task: "t",
    blocked: false,
    preview: async () => ({ handoff: { mode: "summary" } }),
  });
  assert.deepEqual(otherMode, base);
  assert.equal(asked, 0, "only `pruned` has turns to choose between");
});

test("the ids an advisor chooses reach the planner's context", async () => {
  // The blocker that was invisible to the type system, now forced on this side of the seam too. Breaks by:
  // dropping `handoffTurnIds` from the returned context.
  const context = await handoffPlanContext({
    session: { advisorSession: { advisor: judging([0]) }, parentSession: parentSessionOf(8) },
    base: { fanoutBudget: 4 },
    task: "t",
    blocked: false,
    preview: async () => ({ handoff: { mode: "pruned", turns: 4 } }),
  });
  assert.deepEqual(context, { fanoutBudget: 4, handoffTurnIds: ["t4"] });
});

test("a session reads its project's advisor block from disk, not from a caller's argument", async () => {
  // Commit `5bbf20c` fixed "the settings block was never read" and a reviewer then restored `block: undefined`
  // with the suite green, because the test for it called `createAdvisorSession` directly. This one goes through
  // the session factory against a real file. Breaks by: passing `undefined` again in `session.ts`.
  const cwd = await tempDir("advisor-settings-");
  await mkdir(join(cwd, ".pi", "pi-daddy"), { recursive: true });
  await writeFile(join(cwd, ".pi", "pi-daddy", "settings.json"), JSON.stringify({ advisor: { enabled: false } }));
  const previous = { cwd: process.cwd(), env: { ...process.env } };
  try {
    process.chdir(cwd);
    process.env[ENV_ADVISOR] = "jev";
    process.env[ADVISOR_KEY_ENV] = "k";
    const session = createGrantsSession(undefined);
    assert.equal(session.advisorSession.deciderName, "none", "the project said no, and the session read it");
    assert.match(String(session.advisorSession.settings.refusal), /not true for this project/);
  } finally {
    process.chdir(previous.cwd);
    delete process.env[ENV_ADVISOR];
    if (previous.env[ADVISOR_KEY_ENV] === undefined) delete process.env[ADVISOR_KEY_ENV];
  }
});

test("the pruning advisor still fires at the DEFAULT turn count", async () => {
  // **The test that would have caught this.** Raising `DEFAULT_CONTEXT_TURNS` from 6 to 20 silently killed the
  // pruning decision point, because `advisePruning` gave up entirely above `MAX_JUDGED_TURNS` (12) and a default
  // request now offers 20 candidates. Nothing failed: the advisor simply stopped being consulted, which is the
  // shape three reviewers found in the previous change and is invisible to a suite that only tests the mechanism
  // with explicit small numbers.
  //
  // Breaks by: restoring `candidates.length > MAX_JUDGED_TURNS → return undefined`, or raising
  // `DEFAULT_CONTEXT_TURNS` again past what the advisor can handle without revisiting this.
  const parentSession = parentSessionOf(DEFAULT_CONTEXT_TURNS + 5);
  let asked = 0;
  const counting = createAdvisor({
    decider: { name: "count", decide: async () => (asked++, null) },
    record: () => {},
    enabled: true,
  });
  await advisePruning({
    session: { advisorSession: { advisor: counting }, parentSession },
    granted: { mode: "pruned" }, // no explicit `turns`, so the default applies
    task: "t",
  });
  assert.equal(asked, 1, "a default pruned handoff must still reach the advisor");
});

test("an unjudged turn is KEPT, so judging a subset is still only narrowing", async () => {
  // The safety property the subset must not break: the advisor may narrow and never widen, and a turn it was
  // never shown must not be treated as a turn it rejected. Breaks by: returning only the judged ids.
  const total = MAX_JUDGED_TURNS + 4;
  const parentSession = parentSessionOf(total);
  // Reject every question it is asked; the four oldest are never asked and must survive.
  const rejecting = createAdvisor({
    decider: {
      name: "reject-all",
      decide: async (request) => ({
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [key, { kind: "noul" as const, value: false }]),
        ),
      }),
    },
    record: () => {},
    enabled: true,
  });
  const kept = await advisePruning({
    session: { advisorSession: { advisor: rejecting }, parentSession },
    granted: { mode: "pruned", turns: total },
    task: "t",
  });
  assert.equal(kept?.length, 4, `the ${total - MAX_JUDGED_TURNS} unjudged turns must be kept, got ${kept?.length}`);
});
