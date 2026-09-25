import type { CorrelationMetadata } from "../src/kernel/correlation.ts";
import type { WorkspacePins } from "../src/kernel/workspace-pin.ts";
import type { Capability } from "../src/kernel/resolve.ts";
import { appendLedgerEvent, buildWorkspaceLeaseEvent } from "../src/governance/ledger.ts";
import { GovernanceRefusal, refusal, type StructuredRefusal } from "../src/kernel/refusals.ts";
import {
  ENV_WORKSPACE_REGISTRY,
  loadWorkspaceRegistry,
  resolveWorkspace,
  type ValidatedWorkspace,
  type WorkspaceAccess,
} from "../src/kernel/workspace.ts";
import {
  acquireWorkspaceLease,
  defaultWorkspaceLeaseDir,
  type WorkspaceLease,
  leaseAcquisitionOutcome,
  type LeaseReleaseOutcome,
} from "../src/governance/workspace-lease.ts";

export interface DelegationWorkspaceSpec {
  workspace_id: string;
  access: WorkspaceAccess;
}

/**
 * Tools that cannot change a worktree.
 *
 * **`tool:delegate` is deliberately NOT here, and that is a scope decision.** It was added, and it was true of
 * the capability and false of the code: a routed child's cwd IS the leased root, `PI_DADDY_LEDGER` was
 * passed through relative (`init` scaffolds `.pi/grants.jsonl`), and a `read` lease takes no kernel lock — so
 * two delegating children classified `read` both created `.pi/` in one worktree and neither excluded the
 * other. Making `tool:delegate` non-writing requires first making every child-inherited path absolute, and
 * that is a change to the ledger and lease plumbing rather than to ADR-0035. Tracked as R-141.
 */
const KNOWN_READ_ONLY_TOOLS = new Set(["tool:read", "tool:grep", "tool:find", "tool:ls"]);

/**
 * A model may ask for stricter coordination but cannot label a write-capable grant read-only.
 *
 * **Only a TOOL is considered, and that is a fix rather than an oversight.** The check used to require *every*
 * requested capability to be a known read-only tool, which was correct while `tool:` and `ext:` were the only
 * things that could appear — and became wrong the moment ADR-0035's review made `workspace:<id>` grantable to
 * a child. Measured: `governedWorkspaceAccess("read", ["tool:read", "workspace:staging"])` returned `"write"`,
 * so the intended shape — *route this child read-only and let it route its own grandchild* — silently took an
 * exclusive writer lease, blocked every other writer on that root, and recorded `access: "write"` in the
 * ledger when the operator had asked for `read`. A record asserting a stronger claim than anybody made is the
 * same failure this whole review is about, pointing the other way.
 *
 * A `workspace:`, `agent:` or `skill:` id confers no filesystem ability whatsoever: routing chooses a
 * directory, `agent:` authorises a definition whose ceiling is still clipped to the child's own grant, and
 * `skill:` loads instructions. None of them can write, so none of them should force a writer lease. If a
 * descendant does hold a write tool, that tool is in `requested` and this check refuses on its own terms.
 */
export function governedWorkspaceAccess(declared: WorkspaceAccess, requested: readonly Capability[]): WorkspaceAccess {
  if (declared === "write") return "write";
  const tools = requested.filter((c) => c.startsWith("tool:") || c.startsWith("ext:"));
  return tools.every((capability) => KNOWN_READ_ONLY_TOOLS.has(capability)) ? "read" : "write";
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
  episodeId?: string;
  executionId: string;
  parentExecutionId: string | null;
  signal?: AbortSignal;
  ledgerPath?: string;
  /** The CALLING session's own destination pin (ADR-0042); the environment holds its child's, not its own. */
  workspacePin?: WorkspacePins;
}): Promise<PreparedWorkspace> {
  if (input.correlation?.workspace_id && input.correlation.workspace_id !== input.spec.workspace_id) {
    throw new GovernanceRefusal(
      refusal(
        "APPROVAL_SCOPE_MISMATCH",
        `correlation workspace ${input.correlation.workspace_id} does not match requested workspace ${input.spec.workspace_id}`,
        { workspace_id: input.spec.workspace_id },
      ),
    );
  }
  const registryPath = process.env[ENV_WORKSPACE_REGISTRY];
  if (!registryPath) {
    throw new GovernanceRefusal(
      refusal("WORKSPACE_NOT_REGISTERED", `${ENV_WORKSPACE_REGISTRY} is required when a delegation names a workspace`, {
        workspace_id: input.spec.workspace_id,
      }),
    );
  }
  // ADR-0042. The pin comes from the caller's session, NOT from `process.env`: `publishChildEnv` writes the
  // child's narrowed pin into the environment, so reading it back here would check this session's routing
  // against its child's authority. `ownGrant` has always lived in memory for the same reason.
  const workspace = await resolveWorkspace(
    await loadWorkspaceRegistry(registryPath),
    input.spec.workspace_id,
    // **No environment fallback.** Review called the old `?? parseWorkspacePin(process.env[...])` a live read
    // of a variable the session no longer owns — `publishChildEnv` writes its CHILD's pin there. No state
    // could be constructed where it read a usable value, but "currently unreachable" is a weaker property
    // than "cannot happen", and the whole rule here is that a session's own pin lives in memory. A caller
    // with no pin routes nowhere, which is what a caller with no pin should do.
    input.workspacePin ? { pins: input.workspacePin } : { pins: new Map() },
  );
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
          ...(input.episodeId ? { episodeId: input.episodeId } : {}),
          executionId: input.executionId,
          parentExecutionId: input.parentExecutionId,
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
    const structured: StructuredRefusal =
      error instanceof GovernanceRefusal
        ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
        : refusal("WORKSPACE_LEASE_STALE", `workspace lease failed (${String(error)})`);
    if (input.ledgerPath) {
      await appendLedgerEvent(
        { path: input.ledgerPath, strict: true },
        buildWorkspaceLeaseEvent({
          ...(input.episodeId ? { episodeId: input.episodeId } : {}),
          executionId: input.executionId,
          parentExecutionId: input.parentExecutionId,
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
  episodeId?: string;
  executionId: string;
  parentExecutionId: string | null;
  ledgerPath?: string;
  reason: string;
  /** Deliberately keep the lease: a herdr writer tab would not close, so the pane may still be live. */
  retain?: boolean;
}): Promise<LeaseReleaseOutcome | "retained" | undefined> {
  if (!input.prepared) return undefined;
  // A retained lease writes no `state: "released"`, so the record stays `active` and the NEXT owner reads
  // it as a crash — the exact blame `retained` was added to remove. Marking it keeps the successor honest;
  // R-104 was fixed in the release event's wording only.
  // **Ledger what happened, not what was intended (R-152).** This used to discard `markRetained`'s result and
  // write the word "retained" unconditionally, so a helper that had already died, or a lease already released,
  // was still recorded as a pane that may still be live.
  const outcome: LeaseReleaseOutcome = input.retain
    ? await input.prepared.lease.markRetained(input.reason)
    : await input.prepared.lease.release(input.reason);
  if (input.ledgerPath) {
    await appendLedgerEvent(
      { path: input.ledgerPath, strict: true },
      buildWorkspaceLeaseEvent({
        ...(input.episodeId ? { episodeId: input.episodeId } : {}),
        executionId: input.executionId,
        parentExecutionId: input.parentExecutionId,
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
