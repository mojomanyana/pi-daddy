import type { DashboardOwnerObservation } from "../kernel/dashboard-observation.ts";
import type { DashboardSettingsSnapshot } from "./dashboard-settings.ts";
import type { EcosystemVersions } from "./ecosystem-versions.ts";
import { createConnection } from "node:net";

export interface DashboardSessionSnapshot {
  rows: Array<{ definition: string; model: string; thinking: string; source: string }>;
  cost: number | null;
  observation?: DashboardOwnerObservation;
  activity?: { rootId: string; path: string; taskId: string };
  versions?: EcosystemVersions;
  settings?: DashboardSettingsSnapshot;
  auto: { enabled: boolean; source: "default" | "environment" | "session" };
  pendingApprovals: Array<{ id: string; subject: string; capability: string }>;
}

export type DashboardSessionAction = (
  | { action: "get" }
  | { action: "set"; edits: string }
  | { action: "set-auto"; enabled: boolean }
  | { action: "set-jev"; enabled: boolean }
  | { action: "set-limit"; key: "wall" | "idle"; seconds: number }
) & { expectedOwner?: { sessionId: string; cwd: string; generation: string } };

export async function dashboardSessionRequest(
  socketPath: string,
  token: string,
  request: DashboardSessionAction,
): Promise<DashboardSessionSnapshot> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy(new Error("dashboard session request timed out")));
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      output += chunk;
      if (output.length > 64 * 1024) socket.destroy(new Error("dashboard session response too large"));
    });
    socket.once("end", () => {
      try {
        const parsed = JSON.parse(output) as DashboardSessionSnapshot & { ok?: boolean; error?: string };
        if (!parsed.ok) throw new Error(parsed.error ?? "dashboard session request failed");
        if (
          !parsed.auto ||
          typeof parsed.auto.enabled !== "boolean" ||
          !["default", "environment", "session"].includes(parsed.auto.source) ||
          !Array.isArray(parsed.pendingApprovals) ||
          !Array.isArray(parsed.rows)
        )
          throw new Error("dashboard owner does not provide compatible permission controls");
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...request, token })}\n`));
  });
}

/** Controls use only a connected owner; last observations remain explicitly disconnected evidence. */
export function createDashboardConnection(
  request?: (action: DashboardSessionAction) => Promise<DashboardSessionSnapshot>,
) {
  const state: {
    snapshot?: DashboardSessionSnapshot;
    lastObserved?: DashboardSessionSnapshot;
    pending: boolean;
    error?: string;
    acknowledgment?: { action: string; state: "pending" | "applied" | "refused" | "unconfirmed"; effect: string };
  } = { pending: false };
  let generation = 0,
    poll = 0,
    requestedJev: boolean | undefined;
  const retired = new Set<string>();
  const accept = (snapshot: DashboardSessionSnapshot) => {
    const previous = state.lastObserved?.observation,
      next = snapshot.observation;
    if (previous && !next) return false;
    if (next && retired.has(next.generation)) return false;
    if (previous && next && previous.generation === next.generation && next.sequence <= previous.sequence) return false;
    if (previous && next && previous.generation !== next.generation) {
      if (retired.size >= 16) throw Error("Dashboard owner changed repeatedly; reopen the panel");
      retired.add(previous.generation);
    }
    state.snapshot = snapshot;
    state.lastObserved = snapshot;
    state.error = undefined;
    if (
      state.acknowledgment?.state === "pending" &&
      requestedJev !== undefined &&
      snapshot.settings?.jev &&
      !snapshot.settings.jev.pending
    )
      state.acknowledgment.state = snapshot.settings.jev.enabled === requestedJev ? "applied" : "refused";
    return true;
  };
  return {
    state,
    async refresh() {
      if (!request || state.pending) return;
      const observed = generation,
        order = ++poll;
      try {
        const snapshot = await request({ action: "get" });
        if (generation === observed && order === poll && !accept(snapshot)) {
          state.snapshot = undefined;
          state.error = "Owner observation is stale or unavailable; controls disabled until a fresh reply.";
        }
      } catch (error) {
        if (generation === observed && order === poll) {
          state.snapshot = undefined;
          state.error = `Controls unavailable; showing last observation: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    },
    async change(action: Exclude<DashboardSessionAction, { action: "get" }>) {
      if (!request || !state.snapshot || state.pending) return false;
      const observedOwner = state.snapshot.observation;
      generation++;
      state.pending = true;
      requestedJev = action.action === "set-jev" ? action.enabled : undefined;
      const effect =
        action.action === "set-auto"
          ? "current permission handling; admitted work unchanged"
          : action.action === "set-jev"
            ? "current JEV session; separate paid-call and storage choices"
            : "future children; running children unchanged";
      state.acknowledgment = { action: action.action, state: "pending", effect };
      try {
        const snapshot = await request({
          ...action,
          ...(observedOwner
            ? {
                expectedOwner: {
                  sessionId: observedOwner.sessionId,
                  cwd: observedOwner.cwd,
                  generation: observedOwner.generation,
                },
              }
            : {}),
        });
        if (!accept(snapshot)) throw Error("owner acknowledgment is stale; reconcile before another action");
        state.acknowledgment.state =
          action.action === "set-jev"
            ? snapshot.settings?.jev.pending
              ? "pending"
              : snapshot.settings?.jev.enabled === action.enabled
                ? "applied"
                : "refused"
            : "applied";
        return true;
      } catch (error) {
        state.snapshot = undefined;
        state.acknowledgment.state = "unconfirmed";
        state.error = `Control change not confirmed; inspect owner before retrying: ${error instanceof Error ? error.message : String(error)}`;
        return false;
      } finally {
        state.pending = false;
      }
    },
  };
}
