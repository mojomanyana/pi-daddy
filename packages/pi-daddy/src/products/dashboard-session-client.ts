import { createConnection } from "node:net";

export interface DashboardSessionSnapshot {
  rows: Array<{ definition: string; model: string; thinking: string; source: string }>;
  cost: number;
  ceiling: number;
}

export async function dashboardSessionRequest(
  socketPath: string,
  token: string,
  request: { action: "get" } | { action: "set"; edits: string },
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
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...request, token })}\n`));
  });
}
