import type { Delegation } from "../src/kernel/delegate.ts";
import { appendRecord, buildRecord } from "../src/governance/ledger.ts";
import type { ApprovalOutcome } from "./approvals.ts";
import type { ExecutionOccurrenceIds } from "./execution-occurrence.ts";
import type { GrantsSession } from "./session.ts";

export type ApprovalLedgerFacts = Pick<
  ApprovalOutcome,
  "approved" | "sources" | "scopes" | "expiresAt" | "uses" | "humanDenied"
>;

/**
 * The load-bearing capability decision append. Kept in one function so every delegation form writes the
 * same unique identity, approval provenance, trusted digests and refusal facts before a child can start.
 */
export async function recordDelegationDecision(input: {
  session: GrantsSession;
  plan: Delegation;
  ids: ExecutionOccurrenceIds;
  agent?: string;
  taskFrom?: string;
  taskFromExecutionId?: string;
  approval?: ApprovalOutcome;
  approvalFacts?: ApprovalLedgerFacts;
}): Promise<void> {
  const ledgerPath = input.session.ledgerPath;
  if (!ledgerPath) return;
  const { session, plan, ids, approval, approvalFacts } = input;
  await appendRecord(
    { path: ledgerPath, strict: true },
    buildRecord({
      episodeId: session.episodeId,
      executionId: ids.executionId,
      parentExecutionId: ids.parentExecutionId,
      parentId: ids.parentId,
      childId: ids.childId,
      depth: plan.childDepth,
      agentType: input.agent ?? "delegate",
      executor: session.executor.kind,
      taskFrom: input.taskFrom,
      taskFromExecutionId: input.taskFromExecutionId,
      requested: plan.requested,
      // ADR-0078: what crossed, recorded as a fact about this child rather than as the parent's request.
      ...(plan.handoffRecord ? { handoff: plan.handoffRecord } : {}),
      parentGrant: session.ownGrant,
      result: plan.result,
      blocked: !plan.ok,
      reason: plan.reason,
      // A step can spend an upfront manual once and acquire fresh Auto permission for another capability.
      approved:
        approval || approvalFacts
          ? [...new Set([...(approvalFacts?.approved ?? []), ...(approval?.approved ?? [])])]
          : undefined,
      approvalSources: { ...approvalFacts?.sources, ...approval?.sources },
      approvalScopes: { ...approvalFacts?.scopes, ...approval?.recordedScopes },
      approvalExpiresAt: { ...approvalFacts?.expiresAt, ...approval?.expiresAt },
      approvalUses: { ...approvalFacts?.uses, ...approval?.uses },
      humanDenied: approval?.humanDenied || approvalFacts?.humanDenied,
      gateOutcome: approval?.gateOutcome,
      definitionDigest: plan.definitionDigest,
      definitionHash: plan.definitionHash,
      definitionPackageVersion: plan.definitionPackageVersion,
      taskDigest: plan.taskDigest,
      correlation: plan.correlation,
      refusal: plan.refusal,
      now: new Date(),
    }),
  );
}
