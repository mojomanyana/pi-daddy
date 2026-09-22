import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAdvisor, type AdviceRecord } from "../src/advisors/advisor.ts";
import { nullDecider, type Decider } from "../src/advisors/decider.ts";
import { adviseEffort, EFFORT_PURPOSE } from "../extensions/effort-advice.ts";
import { createAdvisorSession } from "../extensions/advisor-session.ts";
import { ADVISOR_KEY_ENV, ENV_ADVISOR } from "../src/advisors/settings.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** A reasoning model that supports every level, and one that supports none. */
const REASONING = { reasoning: true, thinkingLevelMap: { off: "off", low: "low", medium: "medium", high: "high" } };
const registryFor = (model: unknown) => ({ find: () => model });
const MODEL = "openai-codex/gpt-5.6-sol";

function advisorAnswering(value: string | undefined, records: AdviceRecord[] = []) {
  const decider: Decider =
    value === undefined
      ? nullDecider
      : { name: "fake", decide: async () => ({ answers: { effort: { kind: "choice" as const, value } } }) };
  return createAdvisor({ decider, record: (r) => void records.push(r), enabled: value !== undefined });
}

/**
 * ADR-0077's first decision point. What matters is not that the advice is good — nothing here measures that — but
 * that it can only ever fill a blank with one of the options the caller already had.
 */

test("advice fills a blank effort with a level the model actually supports", async () => {
  // Breaks by: not consulting the advisor, or not passing its answer through as `thinking`.
  const records: AdviceRecord[] = [];
  const chosen = await adviseEffort({
    session: { advisorSession: { advisor: advisorAnswering("low", records) } },
    model: MODEL,
    registry: registryFor(REASONING),
    task: "rename a variable",
  });
  assert.equal(chosen, "low");
  assert.equal(records[0].purpose, EFFORT_PURPOSE);
  assert.deepEqual(records[0].questions, ["effort"]);
  assert.doesNotMatch(JSON.stringify(records[0]), /rename a variable/, "the task is sent, never recorded");
});

test("a caller's own choice is never second-guessed, and nothing is asked", async () => {
  // Advice fills a blank; it does not overrule. Breaks by: asking when `requested` is set, or preferring the answer.
  const records: AdviceRecord[] = [];
  const kept = await adviseEffort({
    session: { advisorSession: { advisor: advisorAnswering("high", records) } },
    requested: "minimal",
    model: MODEL,
    registry: registryFor(REASONING),
    task: "t",
  });
  assert.equal(kept, "minimal");
  assert.deepEqual(records, [], "an explicit choice costs no call and no ledger line");
});

test("no advisor, no answer, or an unsupported level all leave the blank blank", async () => {
  // The property that keeps an advisor optional: without one, the child is spawned exactly as it is today.
  // Breaks by: defaulting to some effort when there is no advice, which would make advice load-bearing.
  const base = { model: MODEL, registry: registryFor(REASONING), task: "t" };
  assert.equal(
    await adviseEffort({ ...base, session: { advisorSession: { advisor: advisorAnswering(undefined) } } }),
    undefined,
    "no advisor at all",
  );
  assert.equal(
    await adviseEffort({ ...base, session: { advisorSession: { advisor: advisorAnswering(undefined) } } }),
    undefined,
    "no answer",
  );
  assert.equal(
    await adviseEffort({ ...base, session: { advisorSession: { advisor: advisorAnswering("xhigh") } } }),
    undefined,
    "level unsupported",
  );
  assert.equal(
    await adviseEffort({
      ...base,
      registry: { find: () => undefined },
      session: { advisorSession: { advisor: advisorAnswering("low") } },
    }),
    undefined,
    "a model pi cannot resolve is not a model to reason about",
  );
  assert.equal(
    await adviseEffort({
      ...base,
      registry: registryFor({ reasoning: false }),
      session: { advisorSession: { advisor: advisorAnswering("off") } },
    }),
    undefined,
    "one option is not a choice; asking would spend a call to be told the only thing sayable",
  );
});

test("the options offered are exactly what the model reports, so advice cannot invent a level", async () => {
  // The whole permitted verb list is "select among things the caller already had". Breaks by: offering a fixed
  // list of levels rather than the model's own, which would let a child be spawned with an effort pi rejects.
  let offered: string[] = [];
  const advisor = createAdvisor({
    decider: {
      name: "spy",
      decide: async (request) => {
        const question = request.questions.effort;
        offered = question.kind === "choice" ? Object.keys(question.options) : [];
        return null;
      },
    },
    record: () => {},
    enabled: true,
  });
  await adviseEffort({
    session: { advisorSession: { advisor } },
    model: MODEL,
    registry: registryFor(REASONING),
    task: "t",
  });
  // `supportedModelEfforts` keeps a level whose map entry is absent, so this model supports `minimal` too. The
  // point is that the list came from the model, not from a constant in this file.
  assert.deepEqual(offered, ["off", "minimal", "low", "medium", "high"], "the model's own levels, and only those");
});

/**
 * Which composition modules may reach the advisors layer at all.
 *
 * The third boundary case, asked for by the review of the advisors layer. The import rules already stop `kernel/`
 * and `governance/` seeing advice, but composition may import both sides and composition is where decision points
 * live — so the guard that can exist there is not "these two things may never meet in one file" (the delegation
 * runner legitimately obtains approvals AND now asks for an effort) but "the set of places that consult an advisor
 * is written down". Adding a module here is a deliberate line in a diff, which is the point.
 */
const MAY_CONSULT_AN_ADVISOR = [
  "extensions/advisor-session.ts",
  "extensions/effort-advice.ts",
  "extensions/pruning-advice.ts",
  "extensions/run-delegation.ts",
  "extensions/session.ts",
];

test("only the modules written down here reach the advisors layer", async () => {
  // Breaks by: importing `src/advisors/` — or the composition modules that wrap it — anywhere else.
  const found: string[] = [];
  for (const directory of ["extensions", join("src", "products"), join("src", "executors")]) {
    for (const name of await readdir(join(packageRoot, directory))) {
      if (!name.endsWith(".ts")) continue;
      const text = await readFile(join(packageRoot, directory, name), "utf8");
      if (/from "[^"]*advisors\/|from "\.\/(advisor-session|effort-advice)\.ts"/.test(text))
        found.push(`${directory}/${name}`);
    }
  }
  // The two composition ROOTS, which `layering.test.ts` lets import anything: review measured that adding an
  // advisors import to `src/cli.ts` passed every guard there was.
  for (const root of ["index.ts", "cli.ts"]) {
    const text = await readFile(join(packageRoot, "src", root), "utf8");
    if (/from "\.\/advisors\/|from "[^"]*\/(advisor-session|effort-advice)\.ts"/.test(text)) found.push(`src/${root}`);
  }
  assert.deepEqual(found.sort(), [...MAY_CONSULT_AN_ADVISOR].sort());
});

test("each advisor's answer is spent on one field and nothing else", async () => {
  // The property the allowlist cannot state: what the answers are USED for. Breaks by: assigning the result of
  // `adviseEffort` to anything but `thinking`, or `advisePruning` to anything but `handoffTurnIds`.
  const runner = await readFile(join(packageRoot, "extensions", "run-delegation.ts"), "utf8");
  const effort = [...runner.matchAll(/([\w.]+)\s*=\s*await adviseEffort\(/g)].map((m) => m[1]);
  assert.deepEqual(effort, ["request.thinking"], "the effort answer fills exactly one blank");
  const pruning = [...runner.matchAll(/(?:const\s+)?([\w.]+)\s*=\s*await advisePruning\(/g)].map((m) => m[1]);
  assert.deepEqual(pruning, ["ids"], "the pruning answer is bound once");
  assert.match(runner, /handoffTurnIds: ids/, "and reaches the planner only as handoffTurnIds");
});

test("the levels come from the model the CHILD will run on, not the session's", async () => {
  // Review measured the first version reading the session's model while the child was spawned on `spec.model`, so
  // the levels offered came from a model the child would never use — and pi clamps rather than refusing, so the
  // effect was a silently shifted effort. Breaks by: passing the session's model to `adviseEffort` again.
  const models: Record<string, unknown> = {
    "openai-codex/gpt-5.6-sol": REASONING,
    // An ABSENT entry means supported; only an explicit null excludes a level, which is how this model differs.
    "anthropic/claude-x": {
      reasoning: true,
      thinkingLevelMap: { off: "off", minimal: null, low: null, medium: null, high: "high" },
    },
  };
  let offered: string[] = [];
  const advisor = createAdvisor({
    decider: {
      name: "spy",
      decide: async (request) => {
        const question = request.questions.effort;
        offered = question.kind === "choice" ? Object.keys(question.options) : [];
        return null;
      },
    },
    record: () => {},
    enabled: true,
  });
  await adviseEffort({
    session: { advisorSession: { advisor } },
    model: "anthropic/claude-x",
    registry: { find: (provider, id) => models[`${provider}/${id}`] },
    task: "t",
  });
  assert.deepEqual(offered, ["off", "high"], "the child's model decides which levels exist");
});

test("the advisor comes off the session, so the wiring cannot be severed without a test noticing", async () => {
  // Review measured that replacing `advisor: session.advisorSession.advisor` at the call site with `undefined` left
  // all 860 tests green: the whole decision point could be cut out silently. There is no such argument now — the
  // helper reads the session — so breaking it means editing this path, which this test covers.
  const records: AdviceRecord[] = [];
  const session = { advisorSession: { advisor: advisorAnswering("medium", records) } };
  const chosen = await adviseEffort({ session, model: MODEL, registry: registryFor(REASONING), task: "t" });
  assert.equal(chosen, "medium");
  assert.equal(records.length, 1, "and the use is recorded, as every use is");
});

test("a project may switch an advisor off through its settings block, and that block is actually read", async () => {
  // The narrowing the release advertised in four places. Review measured it was dead code: the session passed
  // `block: undefined`, so `enabled: false` turned nothing off. Breaks by: passing undefined again.
  const on = { [ENV_ADVISOR]: "jev", [ADVISOR_KEY_ENV]: "k" } as NodeJS.ProcessEnv;
  assert.equal(createAdvisorSession({ block: undefined, env: on }).deciderName, "jev");
  const off = createAdvisorSession({ block: { enabled: false }, env: on });
  assert.equal(off.deciderName, "none", "a project that says no gets no advisor");
  assert.match(String(off.settings.refusal), /not true for this project/);
  assert.equal(createAdvisorSession({ block: { timeoutMs: 500 }, env: on }).settings.timeoutMs, 500);
});
