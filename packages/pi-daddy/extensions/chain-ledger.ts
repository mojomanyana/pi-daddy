import type { ApprovalOutcome } from "./approvals.ts";
import type { Delegation } from "../src/delegate.ts";
import { appendRecord, buildRecord } from "../src/ledger.ts";
import type { StructuredRefusal } from "../src/refusals.ts";
import { childSpawnId } from "../src/fanout.ts";
import type { GrantsSession } from "./session.ts";

/** Audit a chain preflight/gate refusal with the same trusted planner facts as a normal delegation. */
export async function recordChainRefusal(input: {
  session: GrantsSession;
  plan: Delegation;
  stepIndex: number;
  executionId: string;
  parentExecutionId: string | null;
  agent?: string;
  reason: string;
  refusal?: StructuredRefusal;
  approval?: ApprovalOutcome;
}): Promise<void> {
  if (!input.session.ledgerPath) return;
  await appendRecord(
    { path: input.session.ledgerPath, strict: true },
    buildRecord({
      executionId: input.executionId,
      parentExecutionId: input.parentExecutionId,
      parentId: input.session.ownSpawnId,
      childId: childSpawnId(input.session.ownSpawnId, input.stepIndex),
      depth: input.plan.childDepth,
      agentType: input.agent ?? "delegate",
      requested: input.plan.requested,
      parentGrant: input.session.ownGrant,
      result: input.plan.result,
      blocked: true,
      reason: input.reason,
      approved: input.approval?.approved,
      approvalSources: input.approval?.sources,
      approvalScopes: input.approval?.recordedScopes,
      approvalExpiresAt: input.approval?.expiresAt,
      approvalUses: input.approval?.uses,
      humanDenied: input.approval?.humanDenied,
      gateOutcome: input.approval?.gateOutcome,
      definitionDigest: input.plan.definitionDigest,
      taskDigest: input.plan.taskDigest,
      correlation: input.plan.correlation,
      // An approval banked before a later chain decline is a yes that led to no spawn, not the stale
      // GATED_UNAPPROVED refusal from the pre-approval plan.
      refusal: input.refusal ?? (input.approval?.approved.length ? undefined : input.plan.refusal),
      executor: input.session.executor.kind,
      now: new Date(),
    }),
  );
}
