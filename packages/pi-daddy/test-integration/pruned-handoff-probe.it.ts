/**
 * How much of what a task refers to survives a `pruned` handoff? — the ADR-0078 probe, 2026-09-22.
 *
 * `selectPrunedTurns` says of itself: "It is NOT a claim that these are the right turns: whether it keeps
 * what a reader would have kept is unmeasured, and stays unmeasured until the handoff probe." This is that
 * probe, and it is a real measurement against the operator's own pi sessions rather than a fixture.
 *
 * **What is measured.** For each session, the last message turn is treated as the task. From its text an
 * ENTITY set is extracted — path-like tokens and long identifiers — and an entity is *recoverable* if some
 * earlier turn contains it. Recall is the share of recoverable entities that survive into the payload.
 *
 * **Why this is not circular.** The rule selects by RECENCY (and by file names the caller passes, empty by
 * default). The ground truth is built from entity references, which the rule knows nothing about. A rule that
 * kept the wrong turns would score badly here, which is the only property that makes the number worth having.
 *
 * **Two recalls, and the gap between them is the finding.** *Selected* recall is of the turns the rule chose.
 * *Delivered* recall is of what fits `CONTEXT_MAX_BYTES`, which is what a child actually reads. They diverge
 * whenever the cap binds — 13% of sessions at the old default of 6 turns, 60% at 20 — and before `keepRank`
 * the divergence had a sign: delivered recall PEAKED at 20 turns and FELL at 50, because the budget was spent
 * oldest-first and the cap cut the turns nearest the task. That is what moved the fill order and the default.
 *
 * Measured at `f1bf16f`, 78 sessions with at least 10 turns and a task naming at least 3 entities:
 *
 * | turns | selected | delivered (oldest-first, before) | delivered (`keepRank`, now) |
 * | ----- | -------- | -------------------------------- | --------------------------- |
 * | 3     | 0.627    | 0.624                            | 0.626                       |
 * | 6     | 0.766    | 0.737                            | 0.763                       |
 * | 12    | 0.862    | 0.789                            | 0.838                       |
 * | 20    | 0.919    | 0.813                            | 0.870                       |
 * | 50    | 0.960    | 0.762                            | 0.874                       |
 *
 * **What this does not establish.**
 *  - **That entity recall is task success.** A child can hold every path a task names and still fail, and can
 *    succeed without one of them. Nothing here runs a child or grades an outcome, and no model was called.
 *  - **That these sessions resemble delegation.** They are ordinary pi sessions from other projects; the last
 *    turn stands in for a task because a corpus of real delegation tasks does not exist yet.
 *  - **Precision.** An earlier draft reported 1.00 and that number was worthless: kept turns are adjacent to
 *    the task, so they almost always share an entity with it. It is omitted rather than reported flatteringly.
 *  - **That `pruned` should become the default mode.** It should not, on this evidence. The best delivered
 *    recall measured is 0.874, so roughly an eighth of what a task refers to is missing even at the ceiling,
 *    and the cost of being wrong is the operator's own session leaving the machine. `none` stays the default.
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
function turnsOf(file: string): PrunableTurn[] {
  const out: PrunableTurn[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; id?: string; message?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message" || !entry.id) continue;
    out.push({ id: entry.id, text: JSON.stringify(entry.message ?? entry) });
  }
  return out;
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

test("pruned handoff recall over the operator's own pi sessions", () => {
  if (!CORPUS) {
    // Rule 8 applied to a probe: a measurement that silently measured nothing is worse than none, because
    // the suite goes green and the record reads as if it ran.
    console.log("probe: PI_DADDY_PROBE_SESSIONS is not set — no corpus, nothing measured");
    return;
  }
  const rows: { turns: number; sessions: number; selected: number; delivered: number; p10: number }[] = [];
  for (const turns of [6, 20, 50]) {
    let sessions = 0;
    let selectedSum = 0;
    let deliveredSum = 0;
    const recalls: number[] = [];
    for (const file of sessionFiles(CORPUS)) {
      const all = turnsOf(file);
      if (all.length < 10) continue;
      const task = all[all.length - 1];
      const prior = all.slice(0, -1);
      const taskEntities = entities(task.text);
      if (taskEntities.size < 3) continue;
      const priorEntities = entities(prior.map((t) => t.text).join("\n"));
      const recoverable = [...taskEntities].filter((e) => priorEntities.has(e));
      if (recoverable.length === 0) continue;

      const kept = selectPrunedTurns(prior, { turns }).kept;
      const keptEntities = entities(kept.map((t) => t.text).join("\n"));
      const deliveredEntities = entities(delivered(kept));
      const selectedRecall = recoverable.filter((e) => keptEntities.has(e)).length / recoverable.length;
      const deliveredRecall = recoverable.filter((e) => deliveredEntities.has(e)).length / recoverable.length;
      sessions++;
      selectedSum += selectedRecall;
      deliveredSum += deliveredRecall;
      recalls.push(deliveredRecall);
    }
    assert.ok(sessions > 0, `no usable session in ${CORPUS} — the probe measured nothing`);
    recalls.sort((a, b) => a - b);
    rows.push({
      turns,
      sessions,
      selected: +(selectedSum / sessions).toFixed(3),
      delivered: +(deliveredSum / sessions).toFixed(3),
      p10: +recalls[Math.floor(recalls.length * 0.1)].toFixed(3),
    });
  }
  console.table(rows);

  const atDefault = rows.find((r) => r.turns === 20)!;
  // **The property the fix bought, asserted rather than described.** Before `keepRank`, delivered recall fell
  // between 20 turns and 50 because the cap cut the newest turns. Monotonicity is the whole finding, so it is
  // what this checks; the absolute numbers are a measurement and will drift with the corpus.
  const atCeiling = rows.find((r) => r.turns === 50)!;
  assert.ok(
    atCeiling.delivered >= atDefault.delivered - 0.01,
    `asking for MORE context must not deliver less: 20 turns → ${atDefault.delivered}, ` +
      `50 turns → ${atCeiling.delivered}. A regression here means the budget is being spent oldest-first again.`,
  );
  assert.ok(
    atDefault.delivered > rows.find((r) => r.turns === 6)!.delivered,
    "the raised default must beat the old one on delivered recall, or it should be put back",
  );
});
