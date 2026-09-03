import { DELEGATE_SUBJECT, shouldSeekApproval } from "../src/approval.ts";
import type { ChainStep } from "../src/chain.ts";
import { planDelegation } from "../src/delegate.ts";
import { childSpawnId } from "../src/fanout.ts";
import type { Capability } from "../src/resolve.ts";
import type { StructuredRefusal } from "../src/refusals.ts";
import type { GrantsSession } from "./session.ts";

/** One upfront legacy gate: capability + subject + the exact step whose task the dialog names. */
export interface GateRequest {
  subject: string;
  path: "definition" | "delegate";
  capability: Capability;
  task: string;
  stepIndex: number;
  plan: ReturnType<typeof planDelegation>;
}

export interface ChainPlan {
  requests: GateRequest[];
  uses: Map<number, Set<string>>;
  doomed?: {
    step: number;
    reason: string;
    plan: ReturnType<typeof planDelegation>;
    agent?: string;
    refusal?: StructuredRefusal;
  };
}

/**
 * Plan every step before any dialog. A non-gate refusal makes the whole chain doomed; correlated approvals
 * wait until their composed task exists, while legacy gates are deduplicated by capability@subject.
 */
export async function planChain(
  session: GrantsSession,
  steps: ChainStep[],
  executionIds: readonly string[],
  preflightModel?: (model: string | undefined) => StructuredRefusal | undefined,
): Promise<ChainPlan> {
  const requests: GateRequest[] = [];
  const uses = new Map<number, Set<string>>();
  const seen = new Set<string>();
  const context = await session.delegationContext();

  for (const [index, step] of steps.entries()) {
    const plan = planDelegation(
      {
        task: step.task,
        agent: step.agent,
        tools: step.tools,
        model: step.model,
        correlation: step.workspace
          ? { ...(step.correlation ?? {}), workspace_id: step.workspace.workspace_id }
          : step.correlation,
        boundWorkspaceId: step.workspace?.workspace_id,
        boundContextId: step.correlation?.context_id,
      },
      {
        ...context,
        spawnId: session.ownSpawnId,
        childSpawnId: childSpawnId(session.ownSpawnId, index),
        childExecutionId: executionIds[index],
      },
    );

    const modelRefusal = preflightModel?.(step.model);
    if (modelRefusal) {
      return {
        requests: [],
        uses,
        doomed: {
          step: index + 1,
          reason: modelRefusal.message,
          plan: { ...plan, ok: false, reason: modelRefusal.message, refusal: modelRefusal },
          agent: step.agent,
          refusal: modelRefusal,
        },
      };
    }

    if (!plan.ok && !shouldSeekApproval(plan.result)) {
      return {
        requests: [],
        uses,
        doomed: {
          step: index + 1,
          reason: plan.reason ?? "this step cannot run",
          plan,
          agent: step.agent,
          ...(plan.refusal ? { refusal: plan.refusal } : {}),
        },
      };
    }
    if (plan.approvalBinding) continue;

    const subject = step.agent ?? DELEGATE_SUBJECT;
    uses.set(index, new Set(plan.result.gatedBlocked.map((capability) => `${capability}@${subject}`)));
    for (const capability of plan.result.gatedBlocked) {
      const key = `${capability}@${subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requests.push({
        subject,
        path: step.agent ? "definition" : "delegate",
        capability,
        task: step.task,
        stepIndex: index,
        plan,
      });
    }
  }
  return { requests, uses };
}
