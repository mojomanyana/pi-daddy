/**
 * How much of what a task refers to survives a `pruned` handoff? — the ADR-0078 probe, 2026-09-22.
 *
 * `selectPrunedTurns` says of itself: "It is NOT a claim that these are the right turns: whether it keeps
 * what a reader would have kept is unmeasured, and stays unmeasured until the handoff probe." This is that
 * probe, and it is a real measurement against the operator's own pi sessions rather than a fixture.
 *
 * **What is measured.** For each session the last message turn stands in for a task. From its PROSE — the text
 * a human or a model actually wrote, not the JSON envelope — an entity set is extracted, and an entity is
 * *recoverable* if some earlier turn's prose contains it. Recall is the share that survives.
 *
 * **Two recalls, and the gap between them is the finding.** *Selected* recall is of the turns the rule chose.
 * *Delivered* recall is of what fits `CONTEXT_MAX_BYTES`, which is what a child actually reads. They diverge
 * whenever the cap binds, and before `keepRank` the divergence had a sign: delivered recall PEAKED at 20 turns
 * and FELL at 50, because the budget was spent oldest-first and the cap cut the turns nearest the task. That is
 * what moved the fill order and the default.
 *
 * Measured at `6df397a`, 67 sessions, corpus of 129 files:
 *
 * | turns | selected | delivered | mean KiB | `longest` control | `oldest` control |
 * | ----- | -------- | --------- | -------- | ----------------- | ---------------- |
 * | 6     | 0.545    | 0.532     | 12.6     | 0.642             | 0.413            |
 * | 12    | 0.727    | 0.671     | 20.9     | 0.705             | 0.592            |
 * | 20    | 0.838    | 0.737     | 25.8     | 0.723             | 0.639            |
 * | 50    | 0.924    | 0.747     | 27.2     | 0.708             | 0.669            |
 *
 * **Two corrections review forced, both large enough to change the conclusion.**
 *
 * *The ground truth was measuring the file format.* It was drawn from `JSON.stringify(message)`, and 48.9% of
 * the scored entities never appeared in anything anyone wrote — `timestamp` was recoverable in 78 sessions out
 * of 78, `cacheRead` and `stopReason` in 75 — scoring near 1.00 because every turn carries them. Roughly a
 * seventh of the headline was the probe recognising its own envelope. Delivered recall at the default is
 * **0.737**, not the 0.870 first reported.
 *
 * *"A rule that kept the wrong turns would score badly here" was asserted, and was false.* On the old metric,
 * twenty turns chosen at RANDOM scored 0.899 against recency's 0.921, and the twenty LONGEST turns beat it
 * outright. So the controls are now measured every run and printed beside the rule. On the corrected metric
 * recency does win at 20 turns and above — but `longest` beats it at 6, which is a finding about the rule and
 * not about this file, and it is left in the table rather than explained away.
 *
 * **What this does not establish.**
 *  - **That entity recall is task success.** A child can hold every term a task names and still fail. Nothing
 *    here runs a child or grades an outcome, and no model was called.
 *  - **That these sessions resemble delegation.** They are ordinary pi sessions from 32 projects; the last turn
 *    stands in for a task because a corpus of real delegation tasks does not exist yet. Three are this project's
 *    own sessions.
 *  - **Precision.** An early draft reported 1.00, which was worthless: kept turns are adjacent to the task and
 *    almost always share a term with it. It is omitted rather than reported flatteringly.
 *  - **Stability to better than about 0.02.** The corpus is live. Review reran identical code four times in 25
 *    minutes and saw delivered recall span 0.011, which is why the corpus fingerprint is printed, why the
 *    assertion carries a tolerance, and why the gap between 20 and 50 turns is not treated as meaningful.
 *  - **That `pruned` should become the default mode.** It should not. A quarter of what a task names is missing
 *    at the default, and the cost of being wrong is the operator's own session leaving the machine.
 *  - **Anything about the advisor's selection.** This measures the mechanical rule only.
 *
 * **Rerun it:** `PI_DADDY_PROBE_SESSIONS=~/.pi/agent/sessions npm run test:integration`. Without that
 * variable the corpus is absent and the probe reports that it did not measure, rather than passing quietly.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fenceContext, selectPrunedTurns, type PrunableTurn } from "../src/kernel/context-handoff.ts";

/** A turn, plus the authored text inside it. The rule only ever sees `PrunableTurn`. */
type ProbeTurn = PrunableTurn & { prose: string };

const CORPUS = process.env.PI_DADDY_PROBE_SESSIONS;

/** Path-like tokens and long identifiers. Deliberately unrelated to anything the rule looks at. */
const ENTITY = /\b[\w.-]+\/[\w./-]+\.\w{1,5}\b|\b[A-Za-z_][A-Za-z0-9_]{5,}\b/g;
const STOP = new Set(
  (
    "function because should interface message content assistant instead between context session project without " +
    "options command package version import export return string number boolean request response default example " +
    "through another already something nothing"
  ).split(" "),
);

function entities(text: string): Set<string> {
  return new Set([...text.matchAll(ENTITY)].map((m) => m[0]).filter((t) => !STOP.has(t.toLowerCase())));
}

/** Read one pi session file into the same shape `context-staging.ts` reduces a live session to. */
function turnsOf(file: string): ProbeTurn[] {
  const out: ProbeTurn[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; id?: string; message?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message" || !entry.id) continue;
    // The PAYLOAD is the whole JSON, because that is exactly what `context-staging.ts` puts in front of a
    // child. The PROSE is what a human or a model actually wrote, and it is what the ground truth is drawn
    // from — see `prose()` for why that distinction turned out to carry the whole result.
    out.push({ id: entry.id, text: JSON.stringify(entry.message ?? entry), prose: prose(entry.message) });
  }
  return out;
}

/**
 * The authored text inside a message, with the JSON envelope left out.
 *
 * **This is the correction that matters.** The first version of this probe drew its ground truth from
 * `JSON.stringify(message)`, and review measured the consequence: 48.9% of the scored entities never appeared
 * in anything a human or model wrote. They were envelope keys — `timestamp` was in the recoverable set of
 * 78 sessions out of 78, `cacheRead`, `totalTokens` and `stopReason` in 75 — and they score essentially 1.00
 * because every turn carries them. Roughly a fifth of the headline number was the measurement recognising its
 * own file format. Recall over the entities that appear in the task's own words is 0.749 at the default, not
 * 0.870.
 */
function prose(message: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") return void parts.push(node);
    if (Array.isArray(node)) return void node.forEach(walk);
    if (node && typeof node === "object")
      for (const [key, value] of Object.entries(node as Record<string, unknown>))
        if (key === "text" || key === "content" || key === "thinking") walk(value);
  };
  walk(message);
  return parts.join("\n");
}

function sessionFiles(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) if (file.endsWith(".jsonl")) files.push(join(dir, file));
  }
  return files;
}

/**
 * What the child actually reads, through the REAL `fenceContext` and the same `keepRank` the stager sets.
 *
 * A first draft simulated the cap here with a `slice`, and that made the probe decorative in the way rule 7
 * warns about: reverting the production fill order would not have changed a single number, so the probe
 * could not have caught the regression it exists to describe. Calling the real function means a change to
 * how the budget is spent moves these rows.
 */
function delivered(kept: readonly PrunableTurn[]): string {
  return fenceContext(
    kept.map((turn, index) => ({ label: `parent turn ${turn.id}`, body: turn.text, keepRank: index + 1 })),
  ).text;
}

/** Control rules, so "the rule keeps the right turns" is measured against alternatives rather than asserted. */
const CONTROLS: Record<string, (all: readonly ProbeTurn[], n: number) => readonly ProbeTurn[]> = {
  recency: (all, n) => all.slice(Math.max(0, all.length - n)),
  longest: (all, n) => [...all].sort((a, b) => b.text.length - a.text.length).slice(0, n),
  oldest: (all, n) => all.slice(0, n),
};

test("pruned handoff recall over the operator's own pi sessions", () => {
  if (!CORPUS) {
    // Rule 8 applied to a probe: a measurement that silently measured nothing is worse than none, because
    // the suite goes green and the record reads as if it ran.
    console.log("probe: PI_DADDY_PROBE_SESSIONS is not set — no corpus, nothing measured");
    return;
  }
  const files = sessionFiles(CORPUS);
  // **A fingerprint, because the corpus moves.** Review reran identical code against this directory four
  // times in 25 minutes and saw delivered recall span 0.011 — wider than the 20-to-50 gap the first write-up
  // called "where the curve flattens". Numbers quoted without this line cannot be re-derived.
  console.log(`probe corpus: ${files.length} session files under ${CORPUS}, measured ${new Date().toISOString()}`);

  const rows: Record<string, unknown>[] = [];
  for (const turns of [6, 12, 20, 50]) {
    const scores: Record<string, { selected: number; delivered: number }> = {};
    for (const name of Object.keys(CONTROLS)) scores[name] = { selected: 0, delivered: 0 };
    let sessions = 0;
    let bytes = 0;
    for (const file of files) {
      const all = turnsOf(file);
      if (all.length < 10) continue;
      const task = all[all.length - 1];
      const prior = all.slice(0, -1);
      // Ground truth from the task's PROSE only. Envelope keys are in every turn and score for free.
      const taskEntities = entities(task.prose);
      if (taskEntities.size < 3) continue;
      const priorEntities = entities(prior.map((t) => t.prose).join("\n"));
      const recoverable = [...taskEntities].filter((e) => priorEntities.has(e));
      if (recoverable.length === 0) continue;
      sessions++;

      for (const [name, rule] of Object.entries(CONTROLS)) {
        // The production rule is exercised through `selectPrunedTurns`; the controls stand in for it, which
        // is the only way to learn whether the metric can tell one selection from another.
        const kept =
          name === "recency" ? (selectPrunedTurns(prior, { turns }).kept as ProbeTurn[]) : rule(prior, turns);
        const keptEntities = entities(kept.map((t) => t.prose).join("\n"));
        const deliveredText = delivered(kept);
        // Delivery is scored on prose too: a turn whose JSON crossed but whose text was cut carries nothing.
        const deliveredIds = new Set(kept.filter((t) => deliveredText.includes(t.text.slice(0, 200))).map((t) => t.id));
        const deliveredEntities = entities(
          kept
            .filter((t) => deliveredIds.has(t.id))
            .map((t) => t.prose)
            .join("\n"),
        );
        scores[name].selected += recoverable.filter((e) => keptEntities.has(e)).length / recoverable.length;
        scores[name].delivered += recoverable.filter((e) => deliveredEntities.has(e)).length / recoverable.length;
        if (name === "recency") bytes += Buffer.byteLength(deliveredText);
      }
    }
    assert.ok(sessions > 0, `no usable session in ${CORPUS} — the probe measured nothing`);
    rows.push({
      turns,
      sessions,
      selected: +(scores.recency.selected / sessions).toFixed(3),
      delivered: +(scores.recency.delivered / sessions).toFixed(3),
      // The cost axis the first write-up left out entirely. Recall rises with `turns` by construction, so a
      // number with no price attached has no stopping point.
      meanKiB: +(bytes / sessions / 1024).toFixed(1),
      "longest(control)": +(scores.longest.delivered / sessions).toFixed(3),
      "oldest(control)": +(scores.oldest.delivered / sessions).toFixed(3),
    });
  }
  console.table(rows);

  const at = (turns: number) => rows.find((r) => r.turns === turns)! as unknown as Record<string, number>;
  // **The property the fix bought**, and the only one asserted, because it is the only one that survived
  // review. Before `keepRank`, delivered recall FELL between 20 turns and 50: the budget was spent oldest-
  // first and the cap cut the newest. The absolute numbers drift with the corpus; monotonicity does not.
  assert.ok(
    at(50).delivered >= at(20).delivered - 0.02,
    `asking for MORE context must not deliver less: 20 turns → ${at(20).delivered}, ` +
      `50 turns → ${at(50).delivered}. A regression here means the budget is being spent oldest-first again.`,
  );
  assert.ok(
    at(20).delivered > at(6).delivered,
    "the raised default must beat the old one on delivered recall, or it should be put back",
  );
  // Recency must at least beat the worst plausible selection. It is NOT asserted to beat `longest`, which
  // review measured winning on the old metric — that is reported in the table and left to a reader.
  assert.ok(
    at(20).delivered > (at(20) as unknown as Record<string, number>)["oldest(control)"],
    "a rule that keeps the oldest turns should do worse; if it does not, this metric is measuring nothing",
  );
});
