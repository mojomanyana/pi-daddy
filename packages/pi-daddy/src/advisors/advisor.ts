/**
 * The wrapper that makes "every use is recorded" structural rather than a rule (ADR-0077).
 *
 * A caller cannot reach a `Decider` directly through this layer's public surface: it asks an `Advisor`, and asking
 * always produces an `advice` record — including when the answer was "no advice", which is the case a reviewer most
 * needs to see, because an advisor that silently stops answering would otherwise look exactly like one nobody used.
 *
 * **What is recorded, and what is not.** The record names the purpose, the decider, the question keys, the answers
 * and how long it took. It does NOT contain the state. A caller composes that state from its own context, which can
 * include task text, file contents and a repository's private material; the ledger has never stored a task
 * (ADR-0021) and an advisor must not become the way it starts. The question keys are the caller's own constants,
 * so they name the decision without describing the situation.
 */
import type { Advice, AdviceRequest, Decider } from "./decider.ts";

/** Two seconds. An advisor is on the path of a decision a human is waiting for; it is not worth more than that. */
export const DEFAULT_ADVICE_TIMEOUT_MS = 2000;

export interface AdviceRecord {
  /** Stable root episode; absent on records written before episode identity shipped. */
  episodeId?: string;
  /** The governed child this advice applied to; absent on records written before attribution shipped. */
  executionId?: string;
  /** Which decision this advice was for, from the caller's own closed list. */
  purpose: string;
  decider: string;
  /** Question keys only — never the state, and never a question's free text. */
  questions: string[];
  answered: boolean;
  durationMs: number;
  /** Present only when advice came back. */
  answers?: Readonly<Record<string, { value: string | number | boolean; confidence?: number }>>;
  model?: string;
  /**
   * Why there is no advice. `declined` means the advisor answered with nothing; `error` means it could not be
   * reached or its response was unrecognised; `cancelled` means the CALLER went away, which is not the advisor's
   * failure and must not read as one.
   */
  outcome: "answered" | "disabled" | "timeout" | "error" | "declined" | "cancelled";
}

export interface Advisor {
  ask(purpose: string, request: AdviceRequest, signal?: AbortSignal, executionId?: string): Promise<Advice | null>;
}

export function createAdvisor(input: {
  decider: Decider;
  /** Where the record goes. Injected so this layer does no I/O and governance does not import it. */
  record: (entry: AdviceRecord) => void | Promise<void>;
  timeoutMs?: number;
  /** Absent or false means the null decider is used whatever `decider` says. */
  enabled?: boolean;
  episodeId?: string;
}): Advisor {
  const timeoutMs = input.timeoutMs ?? DEFAULT_ADVICE_TIMEOUT_MS;
  return {
    async ask(purpose, request, signal, executionId) {
      const started = Date.now();
      const base = {
        ...(input.episodeId ? { episodeId: input.episodeId } : {}),
        ...(executionId ? { executionId } : {}),
        purpose,
        decider: input.decider.name,
        questions: Object.keys(request.questions),
      };
      const write = async (entry: AdviceRecord) => {
        try {
          await input.record(entry);
        } catch {
          // Recording is an observation of a decision that has already been taken. Failing to write it must not
          // change what the caller does, for `execute-child`'s reason: an audit failure that discards the work is
          // worse than one that is merely missing.
        }
      };
      if (input.enabled !== true) {
        await write({ ...base, decider: "none", answered: false, durationMs: 0, outcome: "disabled" });
        return null;
      }
      const timer = new AbortController();
      const cancel = setTimeout(() => timer.abort(), timeoutMs);
      const linked = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
      try {
        // RACED, not merely signalled. A decider that ignores its signal would otherwise run as long as it liked
        // and then be recorded as a timeout — measured at fifty times the configured bound. The `Decider` contract
        // cannot make an implementation honour an abort, so the bound is enforced on this side of it.
        const advice = await Promise.race([
          input.decider.decide(request, linked),
          new Promise<null>((settle) => linked.addEventListener("abort", () => settle(null), { once: true })),
        ]);
        const durationMs = Date.now() - started;
        if (!advice) {
          await write({ ...base, answered: false, durationMs, outcome: outcomeFor(timer.signal, signal, "declined") });
          return null;
        }
        await write({
          ...base,
          answered: true,
          durationMs,
          outcome: "answered",
          answers: Object.fromEntries(
            Object.entries(advice.answers).map(([key, answer]) => [
              key,
              { value: answer.value, ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }) },
            ]),
          ),
          ...(advice.model ? { model: advice.model } : {}),
        });
        return advice;
      } catch {
        // Including an abort. A caller asked for advice and is getting none; it proceeds exactly as it would have.
        await write({
          ...base,
          answered: false,
          durationMs: Date.now() - started,
          outcome: outcomeFor(timer.signal, signal, "error"),
        });
        return null;
      } finally {
        clearTimeout(cancel);
      }
    },
  };
}

/** The bound fired, the caller went away, or neither — three different facts a reviewer needs to tell apart. */
function outcomeFor(
  timer: AbortSignal,
  caller: AbortSignal | undefined,
  otherwise: "declined" | "error",
): AdviceRecord["outcome"] {
  if (timer.aborted && !caller?.aborted) return "timeout";
  if (caller?.aborted) return "cancelled";
  return otherwise;
}
