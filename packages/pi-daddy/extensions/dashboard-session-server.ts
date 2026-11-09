import { isJevEditAction } from "../src/products/dashboard-settings.ts";
import { dashboardObservation } from "./dashboard-observation.ts";
import { dashboardSettingsSnapshot, dashboardJev, setDashboardLimit } from "./dashboard-settings.ts";
import { randomBytes } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GrantsSession } from "./session.ts";
import { getDashboardControlState, setAutoApproval } from "./session-auto-mode.ts";
import { saveSessionModelEdits, sessionModelRows } from "./session-model-prompt.ts";

export interface DashboardSessionEndpoint {
  socketPath: string;
  token: string;
  close(): Promise<void>;
}

const versions = new WeakMap<
  GrantsSession,
  {
    owner: unknown;
    getter: GrantsSession["ecosystemVersions"];
    checked: number;
    value: ReturnType<NonNullable<GrantsSession["ecosystemVersions"]>> | undefined;
  }
>();
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
    let input = "",
      handled = false;
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      if (handled) return;
      input += chunk;
      if (input.length > 16 * 1024) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      handled = true;
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
  const request = JSON.parse(line) as {
    token?: unknown;
    action?: unknown;
    edits?: unknown;
    enabled?: unknown;
    key?: unknown;
    seconds?: unknown;
    option?: unknown;
    expectedOwner?: { sessionId?: unknown; cwd?: unknown; generation?: unknown };
  };
  if (request.token !== token) return { ok: false, error: "unauthorised dashboard request" };
  if (request.action === "edit-jev" || (request.action !== "get" && request.expectedOwner !== undefined)) {
    const observed = session.dashboardObservations?.(),
      expected = request.expectedOwner;
    if (
      !observed ||
      !expected ||
      expected.sessionId !== observed.sessionId ||
      expected.cwd !== observed.cwd ||
      expected.generation !== observed.generation
    )
      return { ok: false, error: "Dashboard owner changed before action; refresh and inspect the new session" };
  }
  const lifecycle = session.reloadLifecycle,
    owner = lifecycle.autoMode;
  const displayOwner = session.dashboardObservations?.()?.generation;
  let jev;
  if (request.action === "set-limit") {
    setDashboardLimit(session, request.key, request.seconds);
  } else if (request.action === "edit-jev") {
    if (!isJevEditAction(request.option)) return { ok: false, error: "Unknown JEV setting" };
    jev = await dashboardJev(session, request.option);
  } else if (request.action === "set-jev") {
    if (typeof request.enabled !== "boolean") return { ok: false, error: "JEV requires an explicit boolean" };
    jev = await dashboardJev(session, request.enabled ? "enable" : "disable");
  } else if (request.action === "set-auto") {
    if (typeof request.enabled !== "boolean") return { ok: false, error: "Auto mode requires an explicit boolean" };
    await setAutoApproval(session, request.enabled, "dashboard");
  } else if (request.action === "set") {
    await getDashboardControlState(session);
    if (typeof request.edits !== "string") return { ok: false, error: "dashboard edits must be a string" };
    const invalid = await saveSessionModelEdits(
      session,
      request.edits,
      [...session.definitions.keys()].sort(),
      "grants-models",
    );
    if (invalid) return { ok: false, error: invalid };
  } else if (request.action !== "get") return { ok: false, error: "unknown dashboard action" };
  const controls = await getDashboardControlState(session);
  const settings = await dashboardSettingsSnapshot(session, jev);
  if (
    session.reloadLifecycle !== lifecycle ||
    lifecycle.autoMode !== owner ||
    session.dashboardObservations?.()?.generation !== displayOwner
  )
    throw Error("Dashboard owner changed; action outcome requires reconciliation");
  return {
    ok: true,
    ...controls,
    ...dashboardObservation(session),
    ...(session.activity ? { activity: { ...session.activity } } : {}),
    rows: sessionModelRows(session, [...session.definitions.keys()].sort()),
    versions: versionSnapshot(session),
    settings,
    cost: null, // Live complete episode cost is unavailable; retained usage remains in the episode report.
  };
}

function versionSnapshot(session: GrantsSession) {
  try {
    const cached = versions.get(session),
      now = Date.now(),
      owner = session.reloadLifecycle.autoMode;
    if (cached && cached.owner === owner && cached.getter === session.ecosystemVersions && now - cached.checked < 5000)
      return cached.value;
    const value = session.ecosystemVersions?.();
    versions.set(session, { owner, getter: session.ecosystemVersions, checked: now, value });
    return value;
  } catch {
    return {
      rows: [],
      checkedAt: new Date().toISOString(),
      note: "Version inventory unavailable; permission controls remain connected.",
    };
  }
}

function close(server: Server, socketPath: string): void {
  server.close();
  void rm(socketPath, { force: true });
}
