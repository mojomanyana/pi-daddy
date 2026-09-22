/**
 * Jev, through OpenRouter's Decisions endpoint — the first advisor adapter (ADR-0077).
 *
 * **What is verified and what is not.** The REQUEST shape below is taken from OpenRouter's own SDK reference for
 * `POST /api/alpha/decisions`: `{model, state, questions}`, where each question is `noul` with `criteria.true` and
 * `criteria.false`, `choice` with a `criteria` map of option to description, or `score` with a `criteria` array of
 * level descriptions. That much is documented. The RESPONSE is described there only as an `answers` object beside
 * `id`, `model`, `provider` and `usage`, with probabilities and confidence mentioned but never shown, and the one
 * public guide to this endpoint says plainly that it has not run paid calls either. **So no shape below has been
 * confirmed against a live response.** The parser therefore accepts what the documentation describes, tolerates the
 * obvious variants, and returns `null` for anything else rather than guessing — which is the same thing it does when
 * the endpoint is down. A live check is the `PI_DADDY_IT_JEV=1` tier, and until somebody runs it this adapter's
 * response handling is a reading of documentation, not a measurement.
 *
 * Nothing here can widen anything: it returns `Advice`, and no kernel or governance function accepts one.
 */
import type { Advice, AdviceRequest, Answer, Decider, Question } from "./decider.ts";

export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.13";

/** The wire form of one question, exactly as OpenRouter's reference documents it. */
export function wireQuestion(question: Question): Record<string, unknown> {
  if (question.kind === "noul")
    return {
      type: "noul",
      instructions: question.instructions,
      criteria: { true: question.whenTrue, false: question.whenFalse },
    };
  if (question.kind === "choice")
    return { type: "choice", instructions: question.instructions, criteria: { ...question.options } };
  return { type: "score", instructions: question.instructions, criteria: [...question.levels] };
}

export function wireRequest(request: AdviceRequest, model: string): Record<string, unknown> {
  return {
    model,
    state: request.state,
    questions: Object.fromEntries(Object.entries(request.questions).map(([key, q]) => [key, wireQuestion(q)])),
  };
}

/**
 * Read one answer out of a response, or nothing.
 *
 * Deliberately generous about WHERE the value and the probability sit, because the documentation names the fields
 * without showing them, and strict about WHAT they are: a `choice` answer must be one of the options that were
 * asked about, and a `score` must be an index into the levels. An answer outside the question's own vocabulary is
 * not a low-confidence answer, it is a response we did not understand, and the honest reading of that is no advice.
 */
export function parseAnswer(question: Question, raw: unknown): Answer | undefined {
  if (raw === null || raw === undefined) return undefined;
  const object = typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const value = object ? (object.value ?? object.answer ?? object.choice ?? object.result) : raw;
  const confidenceRaw = object ? (object.confidence ?? object.probability ?? object.p) : undefined;
  const confidence = typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw) ? confidenceRaw : undefined;
  const withConfidence = <T extends Answer>(answer: T): T =>
    (confidence === undefined ? answer : { ...answer, confidence }) as T;

  if (question.kind === "noul") {
    if (typeof value !== "boolean") return undefined;
    return withConfidence({ kind: "noul", value });
  }
  if (question.kind === "choice") {
    if (typeof value !== "string" || !Object.hasOwn(question.options, value)) return undefined;
    return withConfidence({ kind: "choice", value });
  }
  // A score is reported against the levels that were asked about; anything outside them is not an answer to this
  // question. Both 0-based and 1-based readings are accepted because the documentation shows neither.
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  const zeroBased = value >= 0 && value < question.levels.length;
  const oneBased = value >= 1 && value <= question.levels.length;
  if (!zeroBased && !oneBased) return undefined;
  return withConfidence({ kind: "score", value });
}

export function parseAdvice(request: AdviceRequest, body: unknown): Advice | null {
  if (typeof body !== "object" || body === null) return null;
  const envelope = body as Record<string, unknown>;
  const raw = envelope.answers;
  if (typeof raw !== "object" || raw === null) return null;
  const answers: Record<string, Answer> = {};
  for (const [key, question] of Object.entries(request.questions)) {
    const parsed = parseAnswer(question, (raw as Record<string, unknown>)[key]);
    // Every question or none: a caller that asked two questions and silently received one would have to guess which
    // of its branches the missing answer belonged to, and guessing is what an advisor exists to remove.
    if (!parsed) return null;
    answers[key] = parsed;
  }
  return { answers, ...(typeof envelope.model === "string" ? { model: envelope.model } : {}) };
}

export interface JevConfig {
  apiKey: string;
  model?: string;
  endpoint?: string;
  /** Injected so the adapter is testable without a network, and so nothing here reaches for a global. */
  fetch?: typeof globalThis.fetch;
}

export function jevDecider(config: JevConfig): Decider {
  return {
    name: "jev",
    async decide(request, signal) {
      const send = config.fetch ?? globalThis.fetch;
      const response = await send(config.endpoint ?? JEV_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(wireRequest(request, config.model ?? JEV_MODEL)),
        ...(signal ? { signal } : {}),
      });
      // A non-2xx is no advice, not an exception to propagate: the caller is mid-decision and the answer to "the
      // advisor is unavailable" is the same as the answer to "the advisor had nothing to say".
      if (!response.ok) return null;
      try {
        return parseAdvice(request, await response.json());
      } catch {
        return null;
      }
    },
  };
}
