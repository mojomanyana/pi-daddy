import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAdvisor, type AdviceRecord } from "../src/advisors/advisor.ts";
import { nullDecider, type Decider } from "../src/advisors/decider.ts";
import { adviseEffort, EFFORT_PURPOSE } from "../extensions/effort-advice.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** A reasoning model that supports every level, and one that supports none. */
const REASONING = { reasoning: true, thinkingLevelMap: { off: "off", low: "low", medium: "medium", high: "high" } };
const registryFor = (model: unknown) => ({ find: () => model });
const MODEL = { provider: "openai-codex", id: "gpt-5.6-sol" };

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
    advisor: advisorAnswering("low", records),
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
    advisor: advisorAnswering("high", records),
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
  assert.equal(await adviseEffort({ ...base }), undefined, "no advisor at all");
  assert.equal(await adviseEffort({ ...base, advisor: advisorAnswering(undefined) }), undefined, "no answer");
  assert.equal(await adviseEffort({ ...base, advisor: advisorAnswering("xhigh") }), undefined, "level unsupported");
  assert.equal(
    await adviseEffort({ ...base, registry: { find: () => undefined }, advisor: advisorAnswering("low") }),
    undefined,
    "a model pi cannot resolve is not a model to reason about",
  );
  assert.equal(
    await adviseEffort({ ...base, registry: registryFor({ reasoning: false }), advisor: advisorAnswering("off") }),
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
  await adviseEffort({ advisor, model: MODEL, registry: registryFor(REASONING), task: "t" });
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
  assert.deepEqual(found.sort(), [...MAY_CONSULT_AN_ADVISOR].sort());
});

test("the one answer an advisor gives is spent on effort and nothing else", async () => {
  // The property the allowlist cannot state: what the answer is USED for. Breaks by: assigning the result of
  // `adviseEffort` to any field other than `thinking` — a capability, a model id, a workspace.
  const runner = await readFile(join(packageRoot, "extensions", "run-delegation.ts"), "utf8");
  const uses = [...runner.matchAll(/(\w+):\s*await adviseEffort\(/g)].map((m) => m[1]);
  assert.deepEqual(uses, ["thinking"], "an advisor's answer may fill exactly one blank");
});
