/** Cached owner observations. Refresh on state transitions, never on terminal redraw. */
import type { DashboardSourceSnapshot, DashboardContribution } from "../src/kernel/dashboard-observation.ts";
import type { InitiativeCoordinator } from "../src/governance/initiative-coordinator.ts";
import type { InitiativeTask, InitiativeTaskIdentity, InitiativeObservation } from "../src/kernel/initiative.ts";
import { artifactHash } from "../src/governance/operation-artifact-io.ts";
export function initiativeDashboard(
  coordinator: InitiativeCoordinator,
  tasks: InitiativeTask[],
  now: () => number = Date.now,
) {
  let sequence = 0,
    snapshot: DashboardSourceSnapshot | undefined,
    closed = false;
  let pending: Promise<void> | undefined;
  const metadata = coordinator.metadata();
  const createdAt = new Date(now()).toISOString();
  const last = new Map<
    string,
    {
      revision: string;
      observedAt: string;
      stale: boolean;
      observation: Omit<InitiativeObservation, "assertCurrent">;
    }
  >();
  const selected = tasks.slice(0, 5).map((task) => structuredClone(task));
  const key = (task: InitiativeTaskIdentity | InitiativeTask) => JSON.stringify([task.taskId, task.taskRevision]);
  return {
    /** Only a real owner read may supply facts; this cache is never consulted by admission or tools. */
    record(
      input: InitiativeTaskIdentity,
      observation: Awaited<ReturnType<InitiativeCoordinator["observe"]>>,
      revision: string,
    ) {
      if (closed || input.initiativeId !== metadata.initiativeId || !selected.some((task) => key(task) === key(input)))
        return;
      if (observation.status !== "observed") {
        last.delete(key(input));
        return;
      }
      const { assertCurrent: recheck, ...facts } = observation;
      void recheck;
      last.set(key(input), {
        revision,
        observedAt: new Date(now()).toISOString(),
        stale: false,
        observation: structuredClone(facts),
      });
    },
    invalidate(input?: InitiativeTaskIdentity) {
      for (const [id, entry] of last) if (!input || id === key(input)) entry.stale = true;
      if (snapshot)
        snapshot = {
          ...snapshot,
          items: snapshot.items.map((item) =>
            item.kind === "work" && (!input || item.id === input.taskId.slice(0, 160))
              ? {
                  ...item,
                  state: "unavailable",
                  details: item.details?.map((text, i) => (i === 3 ? `Stale: ${text}`.slice(0, 240) : text)),
                }
              : item,
          ),
        };
    },
    snapshot: () => snapshot,
    close() {
      closed = true;
      if (snapshot) snapshot = { ...snapshot, availability: "closed" };
    },
    refresh(): Promise<void> {
      if (closed) return Promise.resolve();
      if (pending) return pending;
      pending = (async () => {
        const items: DashboardContribution[] = [];
        const meta = coordinator.metadata();
        for (const task of selected) {
          const retained = last.get(key(task));
          const known = retained?.observation;
          const stale =
            retained?.stale ||
            retained?.revision !== coordinator.revision() ||
            (!!retained && now() - Date.parse(retained.observedAt) > 120000);
          items.push({
            id: task.taskId.slice(0, 160),
            kind: "work",
            label: task.taskId.slice(0, 180),
            state:
              !known || stale
                ? "unavailable"
                : known.reconciliationRequired
                  ? "unknown"
                  : known.execution === "running"
                    ? "running"
                    : known.execution === "settled"
                      ? "settled"
                      : "observed",
            details: [
              `Initiative scope: ${metadata.initiativeId.slice(0, 180)}`,
              `Task revision: ${task.taskRevision}`,
              `Last owner generation: ${known?.ownerGeneration ?? "unobserved"}; claim: ${known?.claim ?? "unavailable"}`,
              retained
                ? `Last observed ${retained.observedAt}${stale ? "; stale" : ""}; effect ${task.effectScope}`
                : `Not yet observed; effect ${task.effectScope}`,
              ...(known?.effectObservation
                ? [
                    `Target ${known.effectObservation.target.kind}: ${known.effectObservation.outcome}; ${known.effectObservation.provenance}`,
                    `Target identity: ${known.effectObservation.target.reference.slice(0, 215)}`,
                  ]
                : []),
            ],
          });
        }
        if (closed) return;
        items.unshift({
          id: "scope",
          kind: "status",
          label: `Initiative ${metadata.initiativeId.slice(0, 190)}`,
          state: "observed",
          details: [
            `${coordinator.recoveryOnly ? "Recovery-only observer" : "One-host coordinator"} generation ${meta.generation}`,
            `${meta.knownSessions} known session(s); ${meta.recordedAttempts} recorded attempt(s)`,
            `${tasks.length} selected task(s); first ${Math.min(5, tasks.length)} shown`,
            "Last-observed facts only, not task acceptance or execution authority. Releases belong to their owner.",
          ],
        });
        snapshot = {
          producer: "daddy-initiative",
          producerVersion: "v1",
          generation: `${meta.generation}:${artifactHash(metadata.initiativeId)}`,
          sequence: ++sequence,
          observedAt: [...last.values()].map((item) => item.observedAt).sort()[0] ?? createdAt,
          staleAfterMs: 120000,
          availability: "observed",
          items,
        };
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
