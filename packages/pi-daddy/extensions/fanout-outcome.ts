/**
 * How `delegate_all` aggregates its children into one answer.
 *
 * Pure, and split out of `./delegation.ts` for two reasons: the 400-line module ceiling this project
 * enforces mechanically, and the fact that three of the four functions here exist because the aggregate
 * path had its own copies of defects already fixed on the single-delegation path. That is the R-96/R-97
 * shape — a fix applied where it was found and not where it was duplicated — so the aggregation is now one
 * testable place rather than four inline blocks.
 */
import { GovernanceRefusal, refusal } from "../src/refusals.ts";
import { isCriticalAssuranceBlock, type DelegationOutcome } from "./execute-child.ts";

/**
 * The outcome recorded for a child whose delegation threw rather than returning.
 *
 * Every swallowed child used to report the same contentless `"delegation infrastructure failed"` with no
 * code and no error identity, so a fan-out could report four indistinguishable failures with four different
 * causes (R-116).
 */
export function childFailureOutcome(error: unknown, depth: number): DelegationOutcome {
  return {
    ok: false,
    text: "",
    reason: `delegation infrastructure failed: ${String(error instanceof Error ? error.message : error)}`,
    ...(error instanceof GovernanceRefusal
      ? { refusal: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }
      : {}),
    granted: [],
    depth,
    exitCode: null,
  };
}

/**
 * Every child is reported, including the ones that failed. R-03's rule: a missing result must never be
 * indistinguishable from an empty one, and a fan-out that hid its refusals would let an orchestrator
 * summarise four reviews when only three happened.
 */
export function buildFanoutReport(
  outcomes: readonly DelegationOutcome[],
  children: readonly { agent?: string }[],
): string {
  return outcomes
    .map((outcome, index) => {
      const label = `### child ${index + 1}${children[index]?.agent ? ` (${children[index].agent})` : ""}`;
      return outcome.ok
        ? `${label} — completed\n\n${outcome.text || "(no output)"}`
        : `${label} — FAILED: ${outcome.reason}${outcome.text ? `\n\n${outcome.text}` : ""}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Raises whatever the fan-out cannot report as a result, losing nothing on the way.
 *
 * The upstream controller's verdict outranks our own infrastructure noise — it is the answer the caller is
 * waiting for, and ADR-0034 requires the token to pass through unchanged. But an infrastructure failure
 * must not VANISH behind it, which is what happened when a retained-lease error and a critical block landed
 * in the same fan-out: `??=` kept the first error, the critical token was checked first, and the retained
 * lease was never mentioned to anyone (R-117).
 */
export function throwFanoutInfrastructure(
  outcomes: readonly DelegationOutcome[],
  infrastructureErrors: readonly unknown[],
): void {
  const criticalBlock = outcomes.find(isCriticalAssuranceBlock);
  if (criticalBlock) {
    if (infrastructureErrors.length > 0) throw new AggregateError(infrastructureErrors, criticalBlock.text);
    throw new Error(criticalBlock.text);
  }
  if (infrastructureErrors.length === 1) throw infrastructureErrors[0];
  if (infrastructureErrors.length > 1) {
    throw new AggregateError(
      infrastructureErrors,
      `fan-out hit ${infrastructureErrors.length} infrastructure failures: ` +
      infrastructureErrors.map((error) => String(error instanceof Error ? error.message : error)).join("; "),
    );
  }
}

/**
 * The refusal for a fan-out where every child failed.
 *
 * Mixed codes used to drop EVERY code and throw a bare `Error`, so on total failure the machine-readable
 * half existed nowhere — `details.refusals` is only returned on the partial-success path. Naming them in
 * `details` keeps the codes reachable without inventing one false aggregate code.
 */
export function totalFanoutFailure(failed: readonly DelegationOutcome[], message: string): GovernanceRefusal {
  const codes = [...new Set(failed.flatMap((outcome) => outcome.refusal?.code ?? []))];
  if (codes.length === 1 && failed.every((outcome) => outcome.refusal)) {
    return new GovernanceRefusal(refusal(codes[0], message, { failed: failed.length }));
  }
  return new GovernanceRefusal(refusal(
    "FANOUT_FAILED", message,
    { failed: failed.length, codes: codes.length > 0 ? codes.sort().join(",") : "none" },
  ));
}
