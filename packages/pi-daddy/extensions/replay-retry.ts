/**
 * The one automatic retry of a replay-safe child (owner decision of 2026-11-17, "Read-only work, once").
 *
 * The decision is the kernel's (`src/kernel/replay-safe.ts`); this module gathers its facts and, when it says yes,
 * runs the same request again through the ordinary delegation path. The retry is a fresh execution: a new
 * execution identity, a new child process and session, its own capacity reservation and capability decision,
 * linked to the first by `retryOf` in the ledger. It is planned with nobody asked, so it can only be admitted if a
 * fresh unprompted delegation would be, and it inherits the first attempt's wall-clock deadline. There is never a
 * third attempt: the retry's own outcome is returned, not judged again.
 */
import { childExecutionLimits } from "./dashboard-settings.ts";
import { isCriticalAssuranceBlock, type DelegationOutcome } from "./execute-child.ts";
import type { ExecutionOccurrenceIds } from "./execution-occurrence.ts";
import type { GrantsSession } from "./session.ts";
import { reconcileDelegationCapacity, reserveDelegationCapacity } from "./session-capacity.ts";
import type { CapacityReservation } from "../src/kernel/capacity.ts";
import { ENV_REPLAY_RETRY } from "../src/kernel/env-names.ts";
import { newExecutionId } from "../src/kernel/execution-id.ts";
import { GovernanceRefusal } from "../src/kernel/refusals.ts";
import { replayRetryDecision, replayRetrySwitch } from "../src/kernel/replay-safe.ts";

/** What the first attempt's own path observed: approvals it spent and the deadline it recorded. */
export interface AttemptObservation {
  runtime?: import("./definition-runtime.ts").ResolvedDefinitionRuntime;
  approvalSpent?: boolean;
  deadlineAt?: number;
}

/** Run the retry with a fresh identity and reservation; resolves to its outcome, or rejects as a delegation does. */
export type ReplayRun = (
  ids: ExecutionOccurrenceIds,
  reservation: CapacityReservation,
  observe: { onExecutorEntry: () => void },
) => Promise<DelegationOutcome>;

function noted(outcome: DelegationOutcome, note: string): DelegationOutcome {
  return { ...outcome, reason: [outcome.reason, `automatic retry not started: ${note}`].filter(Boolean).join("; ") };
}

/**
 * Return `first` unchanged unless every guard holds; otherwise the retry's outcome carrying `first`. A retry that
 * could not start leaves `first` standing with a note. One whose child started and then threw rejects with the
 * first attempt named, as an ordinary delegation's executor failure rejects. Under a stable operation an attempt
 * that passes every other guard is not retried but returned marked `replayable` (owner decision of 2026-11-17,
 * "Principal retries once"): the operation's owner retries it under a new operation.
 */
export async function replayIfSafe(
  first: DelegationOutcome,
  input: {
    session: GrantsSession;
    ids: ExecutionOccurrenceIds;
    budget: number | undefined;
    signal: AbortSignal | undefined;
    operation: boolean;
    attempt: AttemptObservation;
  },
  run: ReplayRun,
): Promise<DelegationOutcome> {
  const { session, attempt } = input;
  const decision = replayRetryDecision({
    enabled: replayRetrySwitch(process.env[ENV_REPLAY_RETRY]).enabled,
    capabilities: first.granted,
    attempt: first,
    operation: input.operation,
    executor: session.executor.kind,
    parentAborted: Boolean(input.signal?.aborted),
    criticalAssuranceBlock: isCriticalAssuranceBlock(first),
    approvalSpent: attempt.approvalSpent !== false,
    remainingMs: attempt.deadlineAt === undefined ? Number.NaN : attempt.deadlineAt - Date.now(),
    idleMs: childExecutionLimits(session).idleMs,
  });
  if (!decision.retry) return "replayable" in decision ? { ...first, replayable: true } : first;

  const ids = { ...input.ids, executionId: newExecutionId() };
  let reservation: CapacityReservation;
  try {
    await reconcileDelegationCapacity(session);
    reservation = reserveDelegationCapacity(session, ids.executionId, input.budget);
  } catch (error) {
    // No room in the fan-out bound, or capacity could not be read: nothing started, so the first attempt stands.
    return noted(first, String(error instanceof Error ? error.message : error));
  }
  // The parent may have been cancelled while capacity was reconciled: start nothing, and free what was reserved.
  if (input.signal?.aborted) {
    reservation.finalize({ state: "not-started", reason: "parent tool call cancelled before the automatic retry" });
    return noted(first, "the parent tool call was cancelled");
  }
  let entered = false;
  let second: DelegationOutcome;
  try {
    second = await run(ids, reservation, { onExecutorEntry: () => (entered = true) });
  } catch (error) {
    if (!entered) return noted(first, String(error instanceof Error ? error.message : error));
    const note = `after an automatic retry of a replay-safe child whose first attempt failed (${decision.cause})`;
    if (error instanceof GovernanceRefusal)
      throw new GovernanceRefusal({
        code: error.code,
        message: `${error.message}; ${note}`,
        ...(error.details ? { details: error.details } : {}),
      });
    throw new Error(`${String(error instanceof Error ? error.message : error)}; ${note}`, { cause: error });
  }
  // A refusal at the retry's own planning started nothing: the first attempt is still the answer.
  if (!second.work && !second.final && !second.cleanup) return noted(first, second.reason ?? "refused");
  return {
    ...second,
    ...(second.ok ? {} : { reason: [second.reason, `first attempt: ${first.reason}`].filter(Boolean).join("; ") }),
    retry: { attempts: 2, firstFailure: decision.cause, executionId: ids.executionId, first },
  };
}
