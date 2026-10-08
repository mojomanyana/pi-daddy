import type { EcosystemVersions } from "./ecosystem-versions.ts";
import { createConnection } from "node:net";

export interface DashboardSessionSnapshot {
  rows: Array<{ definition: string; model: string; thinking: string; source: string }>;
  cost: number | null;
  activity?: { rootId: string; path: string; taskId: string };
  versions?: EcosystemVersions;
  auto: { enabled: boolean; source: "default" | "environment" | "session" };
  pendingApprovals: Array<{ id: string; subject: string; capability: string }>;
}

export type DashboardSessionAction =
  { action: "get" } | { action: "set"; edits: string } | { action: "set-auto"; enabled: boolean };

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

/** A slow status poll cannot overwrite a newer acknowledged mutation. Failed requests expose no guessed mode. */
export function createDashboardConnection(
  request?: (action: DashboardSessionAction) => Promise<DashboardSessionSnapshot>,
) {
  const state: { snapshot?: DashboardSessionSnapshot; pending: boolean; error?: string } = { pending: false };
  let generation = 0;
  return {
    state,
    async refresh() {
      if (!request || state.pending) return;
      const observed = generation;
      try {
        const snapshot = await request({ action: "get" });
        if (generation === observed) {
          state.snapshot = snapshot;
          state.error = undefined;
        }
      } catch (error) {
        if (generation === observed) {
          state.snapshot = undefined;
          state.error = `Controls unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    },
    async change(action: Exclude<DashboardSessionAction, { action: "get" }>) {
      if (!request || !state.snapshot || state.pending) return false;
      generation++;
      state.pending = true;
      try {
        state.snapshot = await request(action);
        state.error = undefined;
        return true;
      } catch (error) {
        state.snapshot = undefined;
        state.error = `Control change not confirmed: ${error instanceof Error ? error.message : String(error)}`;
        return false;
      } finally {
        state.pending = false;
      }
    },
  };
}
