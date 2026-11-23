/** Owner-bound dashboard settings. No provider call, global env edit, or permission inference. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GrantsSession } from "./session.ts";
import type { DashboardJevState, DashboardSettingsSnapshot } from "../src/products/dashboard-settings.ts";
import { telemetrySnapshot, setTelemetryEnabled, closeTelemetry } from "./dashboard-telemetry.ts";
import { isJevEditAction, type JevEditAction } from "../src/products/dashboard-settings.ts";
import { MAX_CHILDREN_PER_CALL } from "../src/kernel/fanout.ts";
import { workModeSnapshot } from "./work-mode.ts";
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
// Route identifiers are data, never terminal control sequences or free-form provider labels.
const safeIdentifier = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9@~][A-Za-z0-9._:/@~+-]{0,255}$/.test(value) ? value : undefined;
const safeStorageRoot = (value: unknown) =>
  typeof value === "string" && value.startsWith("/") && !/[\p{Cc}\p{Cf}]/u.test(value)
    ? value.length > 120
      ? `${value.slice(0, 117)}...`
      : value
    : undefined;
export async function dashboardJev(
  _session: GrantsSession,
  action: "status" | "enable" | "disable" | JevEditAction,
): Promise<DashboardJevState> {
  if (action !== "status") throw new Error("JEV support has been removed from this ecosystem");
  return unavailable();
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
    telemetry: telemetrySnapshot(session),
    workMode: workModeSnapshot(session),
  };
}
export async function setDashboardTelemetry(session: GrantsSession, enabled: boolean): Promise<void> {
  owner(session, true);
  if (enabled) setTelemetryEnabled(session, true);
  else await closeTelemetry(session);
}
export function closeDashboardTelemetry(session: GrantsSession): Promise<void> {
  return closeTelemetry(session);
}
