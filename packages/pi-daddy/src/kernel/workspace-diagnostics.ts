/** Read-only routing observations. Reuse the dispatch owners; no lease, pin, acceptance or grant mutation. */
import { checkRoutingAuthority } from "./routing-authority.ts";
import { resolveWorkspace, type WorkspaceRegistryFile } from "./workspace.ts";
import type { Capability } from "./resolve.ts";
import type { WorkspacePins } from "./workspace-pin.ts";
import { GovernanceRefusal } from "./refusals.ts";

export interface WorkspaceRoutingObservation {
  workspaceId: string;
  state:
    | "active"
    | "pending-activation"
    | "not-granted"
    | "not-pinned"
    | "not-registered"
    | "destination-changed"
    | "unavailable";
  registered: boolean;
  accepted: boolean | null;
  capability: "held" | "missing";
  pin: "matching" | "missing" | "moved" | "unchecked";
  canonicalRoot?: string;
  reason: string;
  recovery: string;
  dispatchChecks: string;
}
export async function inspectWorkspaceRouting(input: {
  workspaceId: string;
  registry: WorkspaceRegistryFile;
  accepted: boolean | null;
  ownGrant: readonly Capability[];
  pins?: WorkspacePins;
  depth: number;
}): Promise<WorkspaceRoutingObservation> {
  const { workspaceId, registry, accepted } = input;
  const authority = checkRoutingAuthority(workspaceId, input.ownGrant);
  const registered = Object.hasOwn(registry.workspaces, workspaceId);
  const pinned = input.pins?.has(workspaceId) ?? false;
  const result: WorkspaceRoutingObservation = {
    workspaceId,
    registered,
    accepted,
    capability: authority ? "missing" : "held",
    pin: pinned ? "unchecked" : "missing",
    state: "unavailable",
    reason: "Routing has not been checked.",
    recovery: "Inspect the exact registered workspace.",
    dispatchChecks:
      "Observed routing only; candidate, selected task/input scope, approvals, lease and native settlement " +
      "are checked by their owners at dispatch.",
  };
  if (!registered)
    return {
      ...result,
      state: "not-registered",
      reason: pinned
        ? "This session pinned the ID, but its registry entry has been removed."
        : "The ID is absent from the current registry.",
      recovery:
        "Review the registry with the operator. A remembered or removed ID does not authorize another directory.",
    };
  try {
    const workspace = await resolveWorkspace(registry, workspaceId, { pins: input.pins ?? new Map() });
    result.canonicalRoot = workspace.root;
    result.pin = "matching";
  } catch (error) {
    if (!(error instanceof GovernanceRefusal)) throw error;
    result.reason = error.message;
    if (error.code === "WORKSPACE_NOT_AUTHORIZED" && typeof error.details?.resolved_root === "string") {
      result.canonicalRoot = error.details.resolved_root;
      if (pinned)
        return {
          ...result,
          pin: "moved",
          state: "destination-changed",
          recovery:
            "The registered destination differs from this owner's pin. Review the change; reload cannot repin and no session is started automatically.",
        };
      result.state = accepted === true && input.depth === 0 ? "pending-activation" : "not-pinned";
      result.recovery =
        input.depth > 0
          ? "Ask the parent owner to select and grant the exact workspace. A descendant cannot mint its own pin."
          : accepted === true
            ? "Already accepted, but absent from this owner's settled pin. " +
              "Use an explicitly selected new root session after reviewing its destination; reload keeps the old pin."
            : "Review workspace acceptance with /grants workspaces. Acceptance applies to a new root session; reload does not create pins.";
    } else {
      result.recovery =
        "Correct the reported registry or Git-worktree problem. Routing requires the exact worktree root, not a subdirectory.";
      return result;
    }
  }
  if (authority)
    return {
      ...result,
      state: "not-granted",
      reason: authority.reason,
      recovery:
        "This current grant lacks routing authority (never granted or revoked). " +
        "The operator or parent must grant this exact ID; registration and acceptance do not grant it.",
    };
  if (result.pin !== "matching") return result;
  return {
    ...result,
    state: "active",
    reason: "The current capability and settled destination pin match a valid registered worktree.",
    recovery:
      "Reuse this workspace ID for the authorized operation. Dispatch still checks its current scope and execution prerequisites.",
  };
}
