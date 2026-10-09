/** Owner-bound dashboard settings. No provider call, global env edit, or permission inference. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GrantsSession } from "./session.ts";
import type { DashboardJevState, DashboardSettingsSnapshot } from "../src/products/dashboard-settings.ts";
import { MAX_CHILDREN_PER_CALL } from "../src/kernel/fanout.ts";
import {
  ENV_CHILD_TIMEOUT,
  ENV_CHILD_IDLE_TIMEOUT,
  timeoutFromEnv,
  idleTimeoutFromEnv,
} from "../src/kernel/run-child.ts";

const bridges = new WeakMap<GrantsSession, Pick<ExtensionAPI, "events">>();
const unavailable = (error?: string): DashboardJevState => ({
  available: false,
  enabled: false,
  pending: false,
  ...(error ? { error } : {}),
});
export function registerDashboardSettings(pi: Pick<ExtensionAPI, "events">, session: GrantsSession): void {
  bridges.set(session, pi);
}
function owner(session: GrantsSession, edit = false) {
  const current = session.reloadLifecycle?.autoMode;
  if (!session.ownerBound || !current || current.reader !== session.autoMode)
    throw new Error("Session settings owner is unavailable");
  if (edit && !current.authority) throw new Error("Only the owning root session may edit settings");
  return current;
}
export function childExecutionLimits(session: GrantsSession, env: NodeJS.ProcessEnv = process.env) {
  const configured = session.reloadLifecycle?.executionSettings;
  const current = session.reloadLifecycle?.autoMode;
  const selected = configured?.nativeSessionId === current?.nativeSessionId ? configured : undefined;
  return Object.freeze({
    wallMs: selected?.wallMs ?? timeoutFromEnv(env[ENV_CHILD_TIMEOUT]),
    idleMs: selected?.idleMs ?? idleTimeoutFromEnv(env[ENV_CHILD_IDLE_TIMEOUT]),
    wallSource: selected?.wallMs === undefined ? ("startup" as const) : ("session" as const),
    idleSource: selected?.idleMs === undefined ? ("startup" as const) : ("session" as const),
  });
}
export function setDashboardLimit(session: GrantsSession, key: unknown, seconds: unknown): void {
  const current = owner(session, true);
  if (key !== "wall" && key !== "idle") throw new Error("Only child wall and idle limits are editable in this session");
  if (
    typeof seconds !== "number" ||
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    seconds > Math.floor(2_147_483_647 / 1000)
  )
    throw new Error("Child limit must be whole seconds from 0 to 2147483; 0 restores the default");
  const existing = session.reloadLifecycle.executionSettings;
  const settings =
    existing?.nativeSessionId === current.nativeSessionId
      ? { ...existing }
      : { nativeSessionId: current.nativeSessionId };
  const ms = key === "wall" ? timeoutFromEnv(String(seconds)) : idleTimeoutFromEnv(String(seconds));
  session.reloadLifecycle.executionSettings = { ...settings, [key === "wall" ? "wallMs" : "idleMs"]: ms };
}
const safeText = (value: unknown) => (typeof value === "string" ? value.slice(0, 120) : undefined);
export async function dashboardJev(
  session: GrantsSession,
  action: "status" | "enable" | "disable",
): Promise<DashboardJevState> {
  const current = owner(session, action !== "status");
  const pi = bridges.get(session);
  if (!pi?.events?.emit) {
    if (action !== "status") throw new Error("JEV bridge unavailable; load skill-harness in the owner Pi session");
    return unavailable();
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => (action === "status" ? resolve(unavailable()) : reject(new Error("JEV control was not acknowledged"))),
      200,
    );
    const reply = (input: unknown) => {
      const value = input as {
        version?: number;
        requestId?: string;
        sessionId?: string;
        pending?: boolean;
        error?: string;
        status?: {
          enabled?: boolean;
          mode?: string;
          storage?: string | null;
          remaining?: number;
          availability?: string;
          providerReadiness?: string;
        };
      };
      if (!value || value.version !== 1 || value.requestId !== requestId || value.sessionId !== current.nativeSessionId)
        return;
      clearTimeout(timer);
      if (session.reloadLifecycle.autoMode !== current || session.autoMode !== current.reader) {
        reject(new Error("JEV settings owner changed"));
        return;
      }
      if (!value.status || typeof value.status.enabled !== "boolean") {
        if (action !== "status") reject(new Error("JEV owner could not apply the request"));
        else resolve(unavailable("JEV owner is not bound to this session"));
        return;
      }
      resolve({
        available: true,
        enabled: value.status.enabled,
        pending: value.pending === true,
        mode: safeText(value.status.mode),
        storage: value.status.storage === null ? null : safeText(value.status.storage),
        remaining: Number.isSafeInteger(value.status.remaining) ? value.status.remaining : undefined,
        availability: safeText(value.status.availability),
        providerReadiness: safeText(value.status.providerReadiness),
        ...(value.error ? { error: "JEV request declined or unavailable; inspect the owner Pi session." } : {}),
      });
    };
    try {
      pi.events.emit("skill-harness:jev-control-v1", {
        version: 1,
        requestId,
        sessionId: current.nativeSessionId,
        action,
        reply,
      });
    } catch {
      clearTimeout(timer);
      reject(new Error("JEV control bridge failed"));
    }
  });
}
export async function dashboardSettingsSnapshot(
  session: GrantsSession,
  jev?: DashboardJevState,
): Promise<DashboardSettingsSnapshot> {
  const current = owner(session);
  const limits = childExecutionLimits(session);
  return {
    editable: Boolean(current.authority),
    wallSeconds: limits.wallMs / 1000,
    idleSeconds: limits.idleMs / 1000,
    wallSource: limits.wallSource,
    idleSource: limits.idleSource,
    descendants: session.capacity?.total ?? 0,
    reserved: session.capacity?.reserved ?? 0,
    maxDepth: session.maxDepth ?? 0,
    perCall: MAX_CHILDREN_PER_CALL,
    jev: jev ?? (await dashboardJev(session, "status")),
  };
}
