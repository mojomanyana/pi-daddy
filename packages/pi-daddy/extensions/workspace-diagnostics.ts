/** Explicit owner inspection, cached for display only. Never refresh authority or scan during a redraw. */
import { inspectWorkspaceRouting, type WorkspaceRoutingObservation } from "../src/kernel/workspace-diagnostics.ts";
import { loadWorkspaceRegistry, ENV_WORKSPACE_REGISTRY } from "../src/kernel/workspace.ts";
import { inspectAcceptedWorkspaces } from "../src/governance/workspace-acceptance.ts";
import type { DashboardSourceSnapshot } from "../src/kernel/dashboard-observation.ts";
import type { GrantsSession } from "./session.ts";
const cached = new WeakMap<GrantsSession, { lifecycle: object; signature: string; value: DashboardSourceSnapshot }>();
const signature = (s: GrantsSession) =>
  JSON.stringify([
    s.cwd,
    s.storeCwd,
    s.grantSource,
    s.depth,
    s.ownGrant,
    [...(s.workspacePin ?? [])],
    process.env[ENV_WORKSPACE_REGISTRY],
  ]);
const clip = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 240);
export function workspaceDiagnosticSnapshot(session: GrantsSession): DashboardSourceSnapshot | undefined {
  const prior = cached.get(session);
  if (!prior || prior.lifecycle !== session.reloadLifecycle || prior.signature !== signature(session)) return undefined;
  return structuredClone(prior.value);
}
export async function inspectSessionWorkspace(session: GrantsSession, workspaceId: string): Promise<string> {
  const lifecycle = session.reloadLifecycle,
    before = signature(session),
    registryPath = process.env[ENV_WORKSPACE_REGISTRY];
  const source = `Grant source: ${session.grantSource ?? "unobserved"}; selected store directory: ${session.storeCwd}`;
  let lines: string[],
    state: WorkspaceRoutingObservation["state"] = "unavailable";
  try {
    if (!session.ownerBound) throw Error("session owner is not bound");
    if (!registryPath) throw Error(`${ENV_WORKSPACE_REGISTRY} is not configured`);
    const registry = await loadWorkspaceRegistry(registryPath);
    const acceptance = await inspectAcceptedWorkspaces(registryPath);
    const result = await inspectWorkspaceRouting({
      workspaceId,
      registry,
      accepted: acceptance.state === "recorded" ? acceptance.accepted.includes(workspaceId) : null,
      ownGrant: [...session.ownGrant],
      pins: session.workspacePin ? new Map(session.workspacePin) : undefined,
      depth: session.depth,
    });
    state = result.state;
    lines = [
      `Workspace ${workspaceId}: ${state}`,
      source,
      `Registry: ${registryPath}`,
      `Known acceptance: ${result.accepted === null ? acceptance.state : result.accepted ? "accepted" : "not in current accepted set"}; capability: ${result.capability}; pin: ${result.pin}`,
      ...(result.canonicalRoot ? [`Canonical root: ${result.canonicalRoot}`] : []),
      result.reason,
      result.recovery,
      result.dispatchChecks,
    ];
  } catch (error) {
    lines = [
      `Workspace ${workspaceId}: unavailable`,
      source,
      String(error),
      "Correct the named configuration or unavailable source, then inspect again. No state was changed.",
    ];
  }
  if (session.reloadLifecycle !== lifecycle || signature(session) !== before)
    throw Error("Workspace inspection owner or authority changed; inspect again.");
  const previous = cached.get(session),
    observedAt = new Date().toISOString();
  cached.set(session, {
    lifecycle,
    signature: before,
    value: {
      producer: "workspace-routing",
      producerVersion: "1",
      generation: `workspace:${session.episodeId}`,
      sequence: (previous?.value.sequence ?? -1) + 1,
      observedAt,
      staleAfterMs: 120_000,
      availability: "observed",
      items: [
        {
          id: "workspace-routing",
          kind: "status",
          label: clip(`Workspace ${workspaceId}: ${state}`),
          state: state === "active" ? "observed" : "unavailable",
          details: [clip(`Last explicit inspection: ${observedAt}`), clip(source), ...lines.slice(-3).map(clip)],
        },
      ],
    },
  });
  return lines.join("\n");
}
