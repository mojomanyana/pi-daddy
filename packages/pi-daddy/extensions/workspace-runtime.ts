import type { CorrelationMetadata } from "../src/correlation.ts";
import type { Capability } from "../src/resolve.ts";
import {
  appendLedgerEvent,
  buildWorkspaceLeaseEvent,
} from "../src/ledger.ts";
import { GovernanceRefusal, refusal, type StructuredRefusal } from "../src/refusals.ts";
import {
  acquireWorkspaceLease,
  defaultWorkspaceLeaseDir,
  ENV_WORKSPACE_REGISTRY,
  loadWorkspaceRegistry,
  resolveWorkspace,
  type ValidatedWorkspace,
  type WorkspaceAccess,
  type WorkspaceLease,
  leaseAcquisitionOutcome,
  type LeaseReleaseOutcome,
} from "../src/workspace.ts";

export interface DelegationWorkspaceSpec {
  workspace_id: string;
  access: WorkspaceAccess;
}

const KNOWN_READ_ONLY_TOOLS = new Set(["tool:read", "tool:grep", "tool:find", "tool:ls"]);

/** A model may ask for stricter coordination but cannot label a write-capable grant read-only. */
export function governedWorkspaceAccess(declared: WorkspaceAccess, requested: readonly Capability[]): WorkspaceAccess {
  if (declared === "write") return "write";
  return requested.every((capability) => KNOWN_READ_ONLY_TOOLS.has(capability)) ? "read" : "write";
}

export interface PreparedWorkspace {
  workspace: ValidatedWorkspace;
  lease: WorkspaceLease;
  correlation: CorrelationMetadata;
}

/** Resolve an operator-registered root and acquire its governed-writer lease before any child starts. */
export async function prepareDelegationWorkspace(input: {
  spec: DelegationWorkspaceSpec;
  correlation?: CorrelationMetadata;
  childId: string;
  signal?: AbortSignal;
  ledgerPath?: string;
}): Promise<PreparedWorkspace> {
  if (input.correlation?.workspace_id && input.correlation.workspace_id !== input.spec.workspace_id) {
    throw new GovernanceRefusal(refusal(
      "APPROVAL_SCOPE_MISMATCH",
      `correlation workspace ${input.correlation.workspace_id} does not match requested workspace ${input.spec.workspace_id}`,
      { workspace_id: input.spec.workspace_id },
    ));
  }
  const registryPath = process.env[ENV_WORKSPACE_REGISTRY];
  if (!registryPath) {
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_NOT_REGISTERED",
      `${ENV_WORKSPACE_REGISTRY} is required when a delegation names a workspace`,
      { workspace_id: input.spec.workspace_id },
    ));
  }
  const workspace = await resolveWorkspace(await loadWorkspaceRegistry(registryPath), input.spec.workspace_id);
  let lease: WorkspaceLease | undefined;
  try {
    lease = await acquireWorkspaceLease({
      workspace,
      access: input.spec.access,
      leaseDir: defaultWorkspaceLeaseDir(),
      ownerId: input.childId,
      signal: input.signal,
    });
    const correlation = { ...(input.correlation ?? {}), workspace_id: input.spec.workspace_id };
    if (input.ledgerPath) {
      await appendLedgerEvent(
        { path: input.ledgerPath, strict: true },
        buildWorkspaceLeaseEvent({
          childId: input.childId,
          workspaceId: workspace.workspaceId,
          root: workspace.root,
          access: input.spec.access,
          outcome: leaseAcquisitionOutcome(input.spec.access, lease.recovered),
          recovered: lease.recovered,
          correlation,
          now: new Date(),
        }),
      );
    }
    return { workspace, lease, correlation };
  } catch (error) {
    // A load-bearing ledger failure can happen after the kernel lock was acquired. Release before trying
    // to record the refusal, or this live parent would strand its own writer lease until process exit.
    await lease?.release("setup-failed");
    const structured: StructuredRefusal = error instanceof GovernanceRefusal
      ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
      : refusal("WORKSPACE_LEASE_STALE", `workspace lease failed (${String(error)})`);
    if (input.ledgerPath) {
      await appendLedgerEvent(
        { path: input.ledgerPath, strict: true },
        buildWorkspaceLeaseEvent({
          childId: input.childId,
          workspaceId: workspace.workspaceId,
          root: workspace.root,
          access: input.spec.access,
          outcome: "refused",
          refusal: structured,
          correlation: { ...(input.correlation ?? {}), workspace_id: input.spec.workspace_id },
          now: new Date(),
        }),
      );
    }
    throw error;
  }
}

/**
 * Records what release actually DID, rather than asserting a handover. `release()` cannot throw
 * (R-99) — but THIS function still can, through its own strict append, so callers wrap it rather than
 * calling it bare from a `finally`. An earlier version of this comment claimed the opposite, and the
 * refusal path took it at its word. Returning a value rather than throwing is
 * the whole reason it returns a value. `retained` is a deliberate non-release and is reported as such
 * so the next owner's `recovered: true` does not blame a healthy path (R-104).
 */
export async function releaseDelegationWorkspace(input: {
  prepared: PreparedWorkspace | undefined;
  childId: string;
  ledgerPath?: string;
  reason: string;
  /** Deliberately keep the lease: a herdr writer tab would not close, so the pane may still be live. */
  retain?: boolean;
}): Promise<LeaseReleaseOutcome | "retained" | undefined> {
  if (!input.prepared) return undefined;
  // A retained lease writes no `state: "released"`, so the record stays `active` and the NEXT owner reads
  // it as a crash — the exact blame `retained` was added to remove. Marking it keeps the successor honest;
  // R-104 was fixed in the release event's wording only.
  const outcome: LeaseReleaseOutcome | "retained" = input.retain
    ? (await input.prepared.lease.markRetained(input.reason), "retained")
    : await input.prepared.lease.release(input.reason);
  if (input.ledgerPath) {
    await appendLedgerEvent(
      { path: input.ledgerPath, strict: true },
      buildWorkspaceLeaseEvent({
        childId: input.childId,
        workspaceId: input.prepared.workspace.workspaceId,
        root: input.prepared.workspace.root,
        access: input.prepared.lease.access,
        outcome: leaseReleaseLedgerOutcome(outcome, input.reason),
        releaseReason: input.reason,
        correlation: input.prepared.correlation,
        now: new Date(),
      }),
    );
  }
  return outcome;
}

function leaseReleaseLedgerOutcome(
  outcome: LeaseReleaseOutcome | "retained",
  reason: string,
): "timeout" | "released" | "released-unrecorded" | "lost" | "retained" {
  if (outcome === "retained") return "retained";
  if (outcome === "lost") return "lost";
  if (outcome === "released-unrecorded") return "released-unrecorded";
  return reason === "timeout" ? "timeout" : "released";
}
