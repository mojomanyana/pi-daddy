/** Owner snapshot projection; one bounded RSS sample, no disk reads or durable writes. */
import { workspaceDiagnosticSnapshot } from "./workspace-diagnostics.ts";
import type { GrantsSession } from "./session.ts";
import { ENV_EXECUTION_ARCHIVE } from "../src/kernel/env-names.ts";
const samples = new WeakMap<GrantsSession, { at: number; rssBytes: number }>();
export function dashboardObservation(session: GrantsSession, now = Date.now()) {
  const value = session.dashboardObservations?.();
  if (!value) return {};
  let sample = samples.get(session);
  if (!sample || now - sample.at >= 2000) {
    sample = { at: now, rssBytes: process.memoryUsage().rss };
    samples.set(session, sample);
  }
  const live = session.dashboardLive?.();
  const initiative = session.dashboardInitiative?.();
  const workspace = workspaceDiagnosticSnapshot(session);
  return {
    observation: {
      version: 1 as const,
      ...value,
      ...live,
      sources: [...value.sources, ...(initiative ? [initiative] : []), ...(workspace ? [workspace] : [])],
      logicalOwnerId: session.ownSpawnId,
      artifacts: (session.dashboardArtifacts ?? [])
        .slice(-16)
        .map((r) => ({ operationId: r.operationId, executionId: r.executionId, sha256: r.manifest.sha256 })),
      resources: {
        scope: "owner-process" as const,
        sampledAt: new Date(sample.at).toISOString(),
        rssBytes: sample.rssBytes,
        hostHealth: "unknown" as const,
      },
      capture: {
        transcripts: session.nativeSessionRoot !== undefined,
        diagnostics: !!process.env[ENV_EXECUTION_ARCHIVE]?.trim(),
      },
    },
  };
}
