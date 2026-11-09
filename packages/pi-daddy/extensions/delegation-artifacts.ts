/** Compose durable producer evidence with the existing live operation election. */
import type { OperationClaim, OperationRequest, OperationReference } from "../src/kernel/dispatch-operation.ts";
import type { OperationArtifactOutcome, OperationArtifactRef } from "../src/kernel/operation-artifact.ts";
import type { OperationArtifactStore } from "../src/governance/operation-artifacts.ts";
import type { GrantsSession } from "./session.ts";
const owners = new WeakMap<
  OperationClaim,
  {
    store: OperationArtifactStore;
    request: OperationRequest;
    reference?: OperationArtifactRef;
    publish?: (reference: OperationArtifactRef) => void;
  }
>();
export function operationHistory(session: GrantsSession, operationId: string, includeFinal = true) {
  return session.reloadLifecycle?.operationFinals?.artifacts?.history(operationId, includeFinal) ?? null;
}
export async function claimWithArtifact(
  session: GrantsSession,
  request: OperationRequest,
  claim: () => Promise<OperationClaim>,
  scope = session.reloadLifecycle?.operationFinals,
): Promise<OperationClaim> {
  if (scope !== session.reloadLifecycle?.operationFinals) throw Error("Operation owner changed before admission");
  const store = scope?.artifacts;
  // Unit-only hosts without the extension lifecycle still exercise the pure live election.
  if (!store) {
    if (session.reloadLifecycle) throw Error("Durable operation owner is not ready; no dispatch started");
    return claim();
  }
  const old = store.history(request.operationId, false);
  if (old) {
    if (old.requestDigest !== request.requestDigest) throw Error("Operation identity conflict with retained request");
    const live = await session.autoMode!.operations!.read(request.operationId);
    if (!live || live.executionId !== old.operation.executionId) return { reused: true, operation: old.operation };
  }
  if (scope !== session.reloadLifecycle?.operationFinals) throw Error("Operation owner changed before admission");
  const initiative = session.initiativeOperations?.capture(request);
  await initiative?.assertCurrent();
  const owned = await claim();
  if (owned.reused) {
    if (old?.artifact && old.operation.executionId === owned.operation.executionId)
      owned.operation.artifact = old.artifact;
    return owned;
  }
  try {
    if (scope !== session.reloadLifecycle?.operationFinals) throw Error("Operation owner changed during admission");
    await initiative?.begin();
    if (scope !== session.reloadLifecycle?.operationFinals)
      throw Error("Operation owner changed during initiative admission");
    const admission = store.admit(request);
    if (!admission.created) throw Error("A retained operation already owns this attempt; no dispatch started");
  } catch (error) {
    await initiative?.notAdmitted().catch(() => undefined);
    await owned.finish?.("not-started", { cleanup: { state: "not-started" } }).catch(() => undefined);
    // This execution never left admission. Persist that original-owner fact even after selection revocation.
    // A competing retained execution remains authoritative: never overwrite it with this occurrence's no-start.
    try {
      const admission = store.admit(request);
      if (
        admission.created ||
        ("operation" in admission &&
          admission.operation.executionId === request.executionId &&
          admission.requestDigest === request.requestDigest)
      ) {
        const reference = store.finish(request, {
          operation: {
            ...owned.operation,
            state: "not-started",
            runtime: { cleanup: { state: "not-started" } },
            updatedAt: new Date().toISOString(),
          },
        });
        try {
          scope.publishArtifact?.(reference);
        } catch {
          /* optional reference hint */
        }
      }
    } catch {
      /* Unavailable persistence remains uncertain; absence is never no-start proof. */
    }
    throw error;
  }
  const state = { store, request: { ...request }, publish: scope.publishArtifact };
  owners.set(owned, state);
  const started = owned.started!;
  owned.started = async (cwd, workspaceId) => {
    await initiative?.assertCurrent({ cwd, workspaceId });
    store.started(request, cwd, workspaceId);
    await started(cwd, workspaceId);
    owned.operation = { ...owned.operation, state: "running", cwd, workspaceId };
  };
  const finish = owned.finish!;
  owned.finish = async (status, runtime) => {
    await finish(status, runtime);
    owned.operation = {
      ...owned.operation,
      state: status,
      ...(runtime ? { runtime } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (!owners.get(owned)!.reference) retainOperationArtifact(owned, { operation: owned.operation });
    owned.operation.artifact = owners.get(owned)!.reference;
    if (status === "settled" && owned.operation.artifact) {
      // Artifact retention happens before live settlement. Wake the selected work map only after both.
      try {
        initiative?.settled?.();
      } catch {
        /* A consumer can recover on its next work-map read. */
      }
    }
  };
  return owned;
}
export function retainOperationArtifact(claim: OperationClaim, outcome: OperationArtifactOutcome) {
  const owner = owners.get(claim);
  if (!owner) return;
  const reference = owner.store.finish(owner.request, outcome);
  owner.reference = reference;
  claim.operation.artifact = reference;
  // Pi receives only a small reference, never duplicated full authored content.
  try {
    owner.publish?.(reference);
  } catch {
    /* Durable publication is authoritative; optional hints are recoverable. */
  }
  return reference;
}
export function operationArtifactReference(session: GrantsSession, operation: OperationReference) {
  const historical = operationHistory(session, operation.operationId, false);
  return historical?.operation.executionId === operation.executionId ? historical.artifact : undefined;
}
