/**
 * An advisor is a thing that answers a typed question. It is never a thing that decides (ADR-0077).
 *
 * The boundary is the whole design, and it is structural rather than remembered: **no type in this layer names a
 * `Capability` or a refusal code**, and no function in `kernel/` or `governance/` accepts an advisor's result. An
 * advisor may select among options the caller already had, rank them, annotate them, or propose one. It can never
 * widen an `effective` set, satisfy a gate, or stand in for a human's answer — not because it is asked not to, but
 * because nothing on those paths can receive what it returns. `test/advisors-boundary.test.ts` forces that.
 *
 * Non-generative on purpose. The first advisor is a classifier that returns a typed answer with a probability, not
 * prose, which is what makes an advisor auditable: "it chose `b` at 0.91" is a fact a reviewer can disagree with,
 * where a paragraph of reasoning is not.
 *
 * Degradation is "no advice", never a guess. Every path that cannot produce an answer — disabled, missing key,
 * timeout, transport error, a response shape we do not recognise — returns `null`, and the caller does what it
 * would have done without an advisor at all. That is why a caller must be written to work with `nullDecider`
 * first, and why `nullDecider` is the default.
 */

/** A question, in the three shapes the first advisor understands. */
export type Question =
  | { kind: "noul"; instructions: string; whenTrue: string; whenFalse: string }
  | { kind: "choice"; instructions: string; options: Readonly<Record<string, string>> }
  | { kind: "score"; instructions: string; levels: readonly string[] };

/** One typed answer. `confidence` is absent when the transport did not report one; it is never invented. */
export type Answer =
  | { kind: "noul"; value: boolean; confidence?: number }
  | { kind: "choice"; value: string; confidence?: number }
  | { kind: "score"; value: number; confidence?: number };

export interface AdviceRequest {
  /**
   * What the advisor is told about the situation. **Caller-composed and deliberately not the raw task**: the task
   * is never stored (ADR-0021) and must not be shipped to a third party either, so a caller passes the facts it
   * chose, and the record below names them by key without their values.
   */
  state: Readonly<Record<string, unknown>>;
  questions: Readonly<Record<string, Question>>;
}

export interface Advice {
  answers: Readonly<Record<string, Answer>>;
  /** What actually answered, as the transport reported it — a dated model id, not the one we asked for. */
  model?: string;
}

export interface Decider {
  /** Recorded in the ledger so a reviewer can tell which advisor a decision was taken beside. */
  readonly name: string;
  decide(request: AdviceRequest, signal?: AbortSignal): Promise<Advice | null>;
}

/**
 * The default, and the one every caller must work correctly with.
 *
 * Not a placeholder: it is how advisors stay optional. A caller that behaves differently under `nullDecider` than
 * under no advisor at all has made advice load-bearing, which is the one thing ADR-0077 forbids.
 */
export const nullDecider: Decider = {
  name: "none",
  decide: async () => null,
};
