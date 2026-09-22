/**
 * The second decision point: which of the parent's turns a `pruned` handoff actually carries (ADR-0077).
 *
 * The deterministic rule keeps the last few turns plus older ones naming the given files. That rule is honest and
 * its recall is unmeasured — it is a proxy for "what matters here", not an answer. An advisor can judge the turns
 * against the task the child is about to be given, which the rule cannot see.
 *
 * **It can only take turns away.** The candidates are exactly what `selectPrunedTurns` produced; the advisor is
 * asked one boolean per candidate and the ids it kept are handed back. Staging then intersects those ids with the
 * candidates again, so even a selector that invented an id, returned one from another session, or returned every
 * id in existence cannot put a turn in front of a child that the rule did not already offer. Narrowing is the only
 * verb available, which is what makes this advice rather than authority.
 *
 * With no advisor, no answer, a timeout or an unrecognised response, nothing is returned and the rule's own
 * selection stands — the same "identical to today" property the effort decision point has.
 */
import { selectPrunedTurns, type ContextRequest } from "../src/kernel/context-handoff.ts";
import type { Advisor } from "../src/advisors/advisor.ts";
import type { Question } from "../src/advisors/decider.ts";

export const PRUNING_PURPOSE = "handoff-pruning";

/**
 * How many candidates may be judged. One question per turn, and a decision a human is waiting on should not carry
 * an unbounded number of them; beyond this the rule's own selection stands, which is the safe direction.
 */
export const MAX_JUDGED_TURNS = 12;

/** Just enough of the parent's session for the rule; the same shape `context-staging` reduces entries to. */
export interface ParentTurnSource {
  getEntries(): Array<{ id: string; type: string }>;
}

export async function advisePruning(input: {
  session: { advisorSession: { advisor: Advisor }; parentSession?: ParentTurnSource };
  granted: ContextRequest;
  task: string;
  signal?: AbortSignal;
}): Promise<string[] | undefined> {
  if (input.granted.mode !== "pruned" || !input.session.parentSession) return undefined;
  const all = turnsOf(input.session.parentSession);
  const candidates = selectPrunedTurns(all, {
    ...(input.granted.turns !== undefined ? { turns: input.granted.turns } : {}),
    ...(input.granted.files !== undefined ? { files: input.granted.files } : {}),
  }).kept;
  // Nothing to narrow, or more than a bounded number to judge: the rule stands and no call is made.
  if (candidates.length < 2 || candidates.length > MAX_JUDGED_TURNS) return undefined;

  const questions: Record<string, Question> = {};
  for (const [index, turn] of candidates.entries())
    questions[`turn${index}`] = {
      kind: "noul",
      // Both bounded: the task is embedded once per candidate, so an unbounded task became a request twelve times
      // its size, on a two-second budget and the operator's key.
      instructions: `Would a sub-agent doing this task be helped by seeing this part of the parent's session?\n\nTASK: ${input.task.slice(0, 2000)}\n\nPART:\n${turn.text.slice(0, 2000)}`,
      whenTrue: "It bears on the task: a decision, a constraint, a fact the task depends on.",
      whenFalse: "It does not: unrelated work, chatter, or something the task already states.",
    };

  const advice = await input.session.advisorSession.advisor.ask(
    PRUNING_PURPOSE,
    // The state is empty: everything the advisor needs is already in the questions, and a question carries the
    // task and one turn rather than the whole session. Nothing here is recorded — `createAdvisor` writes keys.
    { state: {}, questions },
    input.signal,
  );
  if (!advice) return undefined;
  // Every candidate or none. A response missing eleven of twelve answers would otherwise read as "drop eleven",
  // which is a narrowing nobody asked for rather than the "unrecognised response means no advice" contract.
  if (candidates.some((_, index) => advice.answers[`turn${index}`]?.kind !== "noul")) return undefined;
  const kept = candidates
    .filter((_, index) => (advice.answers[`turn${index}`] as { value: boolean }).value)
    .map((turn) => turn.id);
  // An advisor that drops everything is answering a different question from the one that was asked; the rule's
  // selection stands rather than handing a child a handoff with nothing in it.
  return kept.length === 0 ? undefined : kept;
}

function turnsOf(session: ParentTurnSource): Array<{ id: string; text: string }> {
  try {
    return session
      .getEntries()
      .filter((entry) => entry.type === "message")
      .map((entry) => ({ id: entry.id, text: JSON.stringify((entry as { message?: unknown }).message ?? entry) }));
  } catch {
    return [];
  }
}
