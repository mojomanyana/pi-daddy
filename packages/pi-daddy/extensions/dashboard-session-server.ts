import { randomBytes } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GrantsSession } from "./session.ts";
import { saveSessionModelEdits, sessionModelRows } from "./session-model-prompt.ts";

export interface DashboardSessionEndpoint {
  socketPath: string;
  token: string;
  close(): Promise<void>;
}

const endpoints = new WeakMap<GrantsSession, Promise<DashboardSessionEndpoint>>();

export function ensureDashboardSessionServer(session: GrantsSession): Promise<DashboardSessionEndpoint> {
  const existing = endpoints.get(session);
  if (existing) return existing;
  const started = start(session);
  endpoints.set(session, started);
  return started;
}

async function start(session: GrantsSession): Promise<DashboardSessionEndpoint> {
  const socketPath = join(tmpdir(), `pi-daddy-${process.pid}-${randomBytes(8).toString("hex")}.sock`);
  const token = randomBytes(24).toString("hex");
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.length > 16 * 1024) socket.destroy(new Error("dashboard request too large"));
      if (!input.includes("\n")) return;
      const line = input.slice(0, input.indexOf("\n"));
      void respond(session, token, line)
        .then((value) => socket.end(`${JSON.stringify(value)}\n`))
        .catch((error) => socket.end(`${JSON.stringify({ ok: false, error: String(error) })}\n`));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  await chmod(socketPath, 0o600);
  const cleanup = () => {
    close(server, socketPath);
  };
  process.once("exit", cleanup);
  server.unref();
  return {
    socketPath,
    token,
    close: async () => {
      process.off("exit", cleanup);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    },
  };
}

async function respond(session: GrantsSession, token: string, line: string): Promise<Record<string, unknown>> {
  const request = JSON.parse(line) as { token?: unknown; action?: unknown; edits?: unknown };
  if (request.token !== token) return { ok: false, error: "unauthorised dashboard request" };
  if (request.action === "set") {
    if (typeof request.edits !== "string") return { ok: false, error: "dashboard edits must be a string" };
    const invalid = await saveSessionModelEdits(
      session,
      request.edits,
      [...session.definitions.keys()].sort(),
      "grants-models",
    );
    if (invalid) return { ok: false, error: invalid };
  } else if (request.action !== "get") return { ok: false, error: "unknown dashboard action" };
  return {
    ok: true,
    rows: sessionModelRows(session, [...session.definitions.keys()].sort()),
    cost: null, // Live complete episode cost is unavailable; retained usage remains in the episode report.
  };
}

function close(server: Server, socketPath: string): void {
  server.close();
  void rm(socketPath, { force: true });
}
