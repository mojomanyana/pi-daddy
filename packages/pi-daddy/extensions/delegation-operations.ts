/** Non-authorizing dispatch election. The elected caller still runs the ordinary governance path. */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Type } from "typebox";
import { shouldSeekApproval } from "../src/kernel/approval.ts";
import { planDelegation } from "../src/kernel/delegate.ts";
import type { OperationClaim } from "../src/kernel/dispatch-operation.ts";
import { validOperationId } from "../src/kernel/dispatch-operation.ts";
import { GovernanceRefusal } from "../src/kernel/refusals.ts";
import { assertDefinitionIdentity } from "./definition-describe.ts";
import { assertDelegationAuthority } from "./delegation-authority.ts";
import { recordDelegationDecision } from "./delegation-ledger.ts";
import type { GrantsSession } from "./session.ts";
import type { ChildSpec, DelegationToolContext } from "./run-delegation.ts";
import type { ExecutionOccurrenceIds } from "./execution-occurrence.ts";
import type { DelegationOutcome } from "./execute-child.ts";

export const operationIdShape = () =>
  Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 160,
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$",
      description:
        "Stable caller operation ID. Identical concurrent dispatch returns its existing reference; terminal IDs never replay work. Use a new ID only for an intentional new attempt.",
    }),
  );
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export async function claimDelegationOperation(
  session: GrantsSession,
  spec: ChildSpec,
  ids: ExecutionOccurrenceIds,
  ctx: DelegationToolContext,
  signal?: AbortSignal,
): Promise<OperationClaim | undefined> {
  if (spec.operation_id === undefined) return undefined;
  assertDelegationAuthority(session);
  if (!validOperationId(spec.operation_id)) throw Error("Invalid operation_id");
  if (signal?.aborted) throw Error("Operation request aborted");
  await session.ensureDefinitions?.();
  assertDefinitionIdentity(session, spec);
  const context = await session.delegationContext();
  const model = spec.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const preview = planDelegation(
    { ...spec, model, boundWorkspaceId: spec.workspace?.workspace_id },
    {
      ...context,
      stageHandoff: undefined,
      fanoutBudget: 0,
      spawnId: ids.parentId,
      childSpawnId: ids.childId,
      childExecutionId: ids.executionId,
    },
  );
  if (!preview.ok && !shouldSeekApproval(preview.result)) {
    await recordDelegationDecision({ session, plan: preview, ids, agent: spec.agent });
    if (preview.refusal) throw new GovernanceRefusal(preview.refusal);
    throw Error(preview.reason ?? "Operation request is not authorized");
  }
  const operations = session.autoMode?.operations;
  if (!operations) throw Error("Session operation admission is unavailable; no dispatch started");
  const cwd = await realpath(ctx.cwd);
  const { operation_id: _id, ...request } = spec;
  const requestDigest = createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          request,
          cwd,
          model,
          piThinking: session.currentThinking?.(),
          definitionDigest: preview.definitionDigest,
          grant: [...session.ownGrant].sort(),
          gated: [...session.gated].sort(),
          depth: session.depth,
          maxDepth: session.maxDepth,
          executor: session.executor.kind,
          definition: spec.agent ? session.definitions.get(spec.agent)?.body : null,
          runtimeSettings: session.definitionRuntimeSettings,
          runtimeOverrides: [...session.definitionRuntimeOverrides.entries()].sort(([a], [b]) => a.localeCompare(b)),
          workspaceRoot: spec.workspace ? session.workspacePin?.get(spec.workspace.workspace_id) : null,
        }),
      ),
    )
    .digest("hex");
  return operations.claim(
    {
      operationId: spec.operation_id,
      requestDigest,
      executionId: ids.executionId,
      cwd,
      workspaceId: spec.workspace?.workspace_id ?? null,
    },
    signal,
  );
}
export function existingOperationOutcome(claim: OperationClaim, depth: number): DelegationOutcome {
  const active = ["admitting", "running"].includes(claim.operation.state);
  return {
    ok: false,
    work: "unknown",
    text:
      `No new child started. Operation ${claim.operation.operationId} already exists (${claim.operation.state}), execution ${claim.operation.executionId}. ` +
      (active
        ? "Follow the original operation; this reference is not its final result."
        : "No mutation result was replayed. Inspect the original outcome before an intentional new attempt with a new operation_id."),
    reason: active ? "existing-operation" : "operation-already-ended",
    granted: [],
    depth,
    exitCode: null,
    operation: { ...claim.operation, reused: true },
  };
}
export async function finishDelegationOperation(claim: OperationClaim, result: DelegationOutcome) {
  const cleanup = result.cleanup;
  const state =
    cleanup?.state === "settled"
      ? "settled"
      : cleanup?.state === "not-started" || (!result.work && !result.final && !cleanup)
        ? "not-started"
        : "uncertain";
  await claim.finish!(state, {
    work: result.work,
    control: result.control,
    ...(result.final
      ? {
          final:
            result.final.state === "complete"
              ? {
                  state: result.final.state,
                  sessionId: result.final.sessionId,
                  messageId: result.final.messageId,
                  leafId: result.final.leafId,
                  sha256: result.final.sha256,
                }
              : { state: result.final.state },
        }
      : {}),
    ...(state === "not-started" && !cleanup ? { cleanup: { state: "not-started" } } : {}),
    ...(cleanup
      ? {
          cleanup: {
            state: cleanup.state,
            ...(cleanup.state === "settled"
              ? {
                  receiptPath: cleanup.identity.receiptPath,
                  executionId: cleanup.identity.executionId,
                }
              : {}),
          },
        }
      : {}),
  });
  result.operation = {
    ...claim.operation,
    state,
    cwd: result.cwd ?? claim.operation.cwd,
    workspaceId: result.workspaceId ?? claim.operation.workspaceId,
    reused: false,
  };
}
