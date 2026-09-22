/**
 * The first decision point that consults an advisor (ADR-0077, roadmap PR 8): how hard a child should think.
 *
 * **Why this one.** It is the shape the boundary was designed for. The options are not invented by the advisor —
 * they are the thinking levels this session's own model reports it supports (`supportedModelEfforts`), so the
 * advisor picks among things the caller already had, which is the entire permitted verb list. It touches no
 * capability, no gate and no grant: the worst an advisor can do here is make a child think harder or less hard
 * than a human would have chosen, and the ledger says it did.
 *
 * **Only when the caller said nothing.** An explicit `thinking` on the call is the operator's or the model's own
 * choice and is never second-guessed; advice fills a blank, it does not overrule. With no advisor, no key, no
 * answer, a timeout or an unrecognised response, the blank stays blank and the child is spawned exactly as it is
 * today — which is the property that keeps advisors optional rather than load-bearing.
 */
import { supportedModelEfforts } from "../src/kernel/model-preflight.ts";
import type { Advisor } from "../src/advisors/advisor.ts";

/** What pi's resolved catalogue entry carries that decides which efforts exist. */
interface ResolvedModel {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

export const EFFORT_PURPOSE = "child-effort";

export async function adviseEffort(input: {
  /** The session, read here rather than passed as an advisor: an argument can be severed and nothing notices. */
  session: { advisorSession: { advisor: Advisor } };
  /** Absent means the caller chose one; nothing is asked and nothing is recorded. */
  requested?: string;
  /**
   * The model the CHILD will run on, `provider/id`, not the session's.
   *
   * Review measured the first version reading the parent session's model while the child was spawned on
   * `spec.model`: the levels offered then came from a model the child would never use, and pi clamps rather than
   * refuses, so the effect was a silently shifted effort rather than a loud failure.
   */
  model?: string;
  registry: { find(provider: string, modelId: string): unknown };
  task: string;
  agent?: string;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const advisor = input.session.advisorSession.advisor;
  const slash = input.model === undefined ? -1 : input.model.indexOf("/");
  if (input.requested !== undefined || slash <= 0) return input.requested;
  const resolved = input.registry.find(input.model!.slice(0, slash), input.model!.slice(slash + 1)) as
    ResolvedModel | undefined;
  if (!resolved) return undefined;
  const levels = supportedModelEfforts(resolved);
  // One option is not a choice, and a model with no reasoning has exactly one. Asking would spend a call and a
  // ledger line to be told the only thing that could be said.
  if (levels.length < 2) return undefined;

  const advice = await advisor.ask(
    EFFORT_PURPOSE,
    {
      // The task text is what the decision is actually about, and it is the one thing this package has never
      // stored (ADR-0021). It is sent to the advisor because an advisor cannot judge a task it cannot see, and it
      // is NOT recorded: `createAdvisor` writes the question keys and the answer, never the state. An operator who
      // is not willing to send task text to a third party leaves the advisor off, which is the default.
      state: { task: input.task, ...(input.agent ? { definition: input.agent } : {}) },
      questions: {
        effort: {
          kind: "choice",
          instructions:
            "How much reasoning effort does this task need? Choose the cheapest level that would still do it well.",
          options: Object.fromEntries(levels.map((level) => [level, effortDescription(level)])),
        },
      },
    },
    input.signal,
  );
  const chosen = advice?.answers.effort;
  // Belt and braces: `parseAnswer` already refuses a choice outside the options it was given, so this can only
  // fire if a future decider is written that does not. An effort the model does not support would be refused by
  // pi in the child, after the spawn, which is a worse place to find out.
  if (!chosen || chosen.kind !== "choice" || !(levels as readonly string[]).includes(chosen.value)) return undefined;
  return chosen.value;
}

function effortDescription(level: string): string {
  switch (level) {
    case "off":
      return "No reasoning. Mechanical work: a rename, a formatting pass, reading one file back.";
    case "minimal":
      return "Almost none. A single obvious step with no choice in it.";
    case "low":
      return "A little. One decision, or a change confined to one file.";
    case "medium":
      return "Ordinary. Several steps, or a change that has to fit existing code.";
    case "high":
      return "Substantial. Design choices, or work across several files that must stay consistent.";
    case "xhigh":
      return "Very high. A subtle problem where the obvious approach is likely to be wrong.";
    default:
      return "The most this model can do. Reserve it for work that has defeated a lesser effort.";
  }
}
