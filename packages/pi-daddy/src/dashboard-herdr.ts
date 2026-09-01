import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ENV_DASHBOARD_KEY,
  ENV_DASHBOARD_LEDGER,
  ENV_DASHBOARD_PROTOCOL,
  DASHBOARD_PROTOCOL_VERSION,
} from "./dashboard-cli.ts";
import { parseReply, type HerdrExec } from "./herdr-cli.ts";
import { withFileLock } from "./file-lock.ts";

export const DASHBOARD_PLUGIN_ID = "pi-daddy.dashboard";
export const DASHBOARD_PLUGIN_ENTRYPOINT = "dashboard";
export const DASHBOARD_HERDR_TIMEOUT_MS = 3_000;

/** Dashboard control calls are UI operations and must never hang pi session start. */
export const dashboardHerdrExec: HerdrExec = (args) => new Promise((settle) => {
  execFile("herdr", args, { timeout: DASHBOARD_HERDR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    const raw = (error as { code?: unknown } | null)?.code;
    const code = typeof raw === "number" ? raw : error ? 1 : 0;
    const failure = error ? `${typeof raw === "string" ? `${raw}: ` : ""}${error.message}` : "";
    settle({ code, stdout: String(stdout), stderr: String(stderr) || failure });
  });
});

export interface HerdrHost {
  paneId: string;
  tabId: string;
  workspaceId: string;
}

export type HerdrHostResult =
  | { ok: true; host: HerdrHost; diagnostic: string }
  | { ok: false; diagnostic: string; host?: undefined };

function nested(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export async function verifyHerdrHost(options: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  pid?: number;
  exec?: HerdrExec;
} = {}): Promise<HerdrHostResult> {
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;
  const exec = options.exec ?? dashboardHerdrExec;
  const paneId = env.HERDR_PANE_ID?.trim();
  const tabId = env.HERDR_TAB_ID?.trim();
  const workspaceId = env.HERDR_WORKSPACE_ID?.trim();
  if (env.HERDR_ENV !== "1" || !paneId || !tabId || !workspaceId) {
    return {
      ok: false,
      diagnostic:
        "this pi session is not hosted inside Herdr (no complete HERDR pane identity). " +
        "A reachable Herdr server elsewhere is not sufficient.",
    };
  }

  try {
    const current = parseReply(await exec(["pane", "current", "--pane", paneId]));
    if (current.error) return { ok: false, diagnostic: `Herdr could not verify this pane: ${current.error}` };
    const pane = nested(current.result, "pane");
    if (pane?.pane_id !== paneId || pane.tab_id !== tabId || pane.workspace_id !== workspaceId) {
      return { ok: false, diagnostic: "Herdr's pane identity does not match this pi process environment." };
    }

    const processReply = parseReply(await exec(["pane", "process-info", "--pane", paneId]));
    if (processReply.error) return { ok: false, diagnostic: `Herdr could not inspect this pane process: ${processReply.error}` };
    const info = nested(processReply.result, "process_info");
    if (info?.pane_id !== paneId) {
      return { ok: false, diagnostic: "Herdr returned process information for another pane." };
    }
    const processes = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
    const containsPi = processes.some((entry) => {
      const process = entry as { pid?: unknown };
      return process.pid === pid;
    });
    if (!containsPi) {
      return {
        ok: false,
        diagnostic: `Herdr pane ${paneId} does not contain this pi process (${pid}); refusing to target another pane.`,
      };
    }
    return { ok: true, host: { paneId, tabId, workspaceId }, diagnostic: `hosted in Herdr pane ${paneId}` };
  } catch (error) {
    return { ok: false, diagnostic: `Herdr host verification failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type DashboardPluginState = "absent" | "disabled" | "compatible" | "incompatible" | "unavailable";
export interface DashboardPluginStatus {
  state: DashboardPluginState;
  diagnostic: string;
  plugin?: Record<string, unknown>;
}

function protocolMajor(version: unknown): number | null {
  if (typeof version !== "string") return null;
  const match = /^(\d+)\./.exec(version);
  return match ? Number(match[1]) : null;
}

export async function inspectDashboardPlugin(
  exec: HerdrExec = dashboardHerdrExec,
  expectedPluginRoot?: string,
): Promise<DashboardPluginStatus> {
  try {
    const parsed = parseReply(await exec(["plugin", "list", "--json"]));
    if (parsed.error) return { state: "unavailable", diagnostic: `Herdr plugin registry unavailable: ${parsed.error}` };
    const plugins = Array.isArray(parsed.result?.plugins) ? parsed.result.plugins as Record<string, unknown>[] : [];
    const plugin = plugins.find((candidate) => candidate.plugin_id === DASHBOARD_PLUGIN_ID);
    if (!plugin) return { state: "absent", diagnostic: `Herdr plugin ${DASHBOARD_PLUGIN_ID} is not installed.` };
    // Provenance and protocol precede enabled state. Suggesting `plugin enable` for a same-id plugin from
    // another package would ask the operator to activate software this package explicitly refuses to invoke.
    if (expectedPluginRoot && (typeof plugin.plugin_root !== "string" || resolve(plugin.plugin_root) !== resolve(expectedPluginRoot))) {
      return {
        state: "incompatible",
        diagnostic: `Herdr plugin ${DASHBOARD_PLUGIN_ID} is linked from a different package; relink the bundled copy.`,
        plugin,
      };
    }
    const major = protocolMajor(plugin.version);
    if (major !== DASHBOARD_PROTOCOL_VERSION) {
      return {
        state: "incompatible",
        diagnostic:
          `Herdr plugin ${DASHBOARD_PLUGIN_ID} uses protocol ${major ?? "unknown"}; ` +
          `this pi-daddy core requires ${DASHBOARD_PROTOCOL_VERSION}. Relink both from the same package.`,
        plugin,
      };
    }
    if (plugin.enabled !== true) {
      return { state: "disabled", diagnostic: `Herdr plugin ${DASHBOARD_PLUGIN_ID} is installed but disabled.`, plugin };
    }
    const warnings = Array.isArray(plugin.warnings) ? plugin.warnings.filter((value) => typeof value === "string") : [];
    return {
      state: "compatible",
      diagnostic: warnings.length > 0
        ? `Herdr plugin ${DASHBOARD_PLUGIN_ID} is installed with warnings: ${warnings.join("; ")}`
        : `Herdr plugin ${DASHBOARD_PLUGIN_ID} is ready.`,
      plugin,
    };
  } catch (error) {
    return { state: "unavailable", diagnostic: `Herdr plugin discovery failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function linkDashboardPlugin(pluginRoot: string, exec: HerdrExec = dashboardHerdrExec): Promise<void> {
  const parsed = parseReply(await exec(["plugin", "link", resolve(pluginRoot), "--enabled"]));
  if (parsed.error) throw new Error(`Herdr could not link the bundled dashboard plugin: ${parsed.error}`);
}

interface StoredPane {
  paneId: string;
  terminalId: string;
  tabId: string;
  workspaceId: string;
  ledgerPath: string;
  updatedAt: string;
}
interface PaneStore { version: 1; panes: Record<string, StoredPane> }

function isStoredPane(value: unknown): value is StoredPane {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pane = value as Record<string, unknown>;
  return Object.keys(pane).every((key) => [
    "paneId", "terminalId", "tabId", "workspaceId", "ledgerPath", "updatedAt",
  ].includes(key)) &&
    ["paneId", "terminalId", "tabId", "workspaceId", "updatedAt"].every(
      (field) => typeof pane[field] === "string" && pane[field] !== "",
    ) && typeof pane.ledgerPath === "string" && Number.isFinite(Date.parse(String(pane.updatedAt)));
}

function isPaneStore(value: unknown): value is PaneStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const store = value as Record<string, unknown>;
  if (store.version !== 1 || !store.panes || typeof store.panes !== "object" || Array.isArray(store.panes)) return false;
  return Object.keys(store).every((key) => ["version", "panes"].includes(key)) &&
    Object.entries(store.panes as Record<string, unknown>).every(
      ([key, pane]) => /^[a-f0-9]{64}$/.test(key) && isStoredPane(pane),
    );
}

async function loadStore(path: string): Promise<PaneStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isPaneStore(parsed)) throw new Error("unsupported dashboard pane store shape");
    return parsed;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { version: 1, panes: {} };
    throw new Error(`dashboard pane state ${path} is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function saveStore(path: string, store: PaneStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function paneFrom(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return nested(result, "pane") ?? nested(nested(result, "plugin_pane"), "pane");
}

async function locateStoredPane(stored: StoredPane, exec: HerdrExec): Promise<Record<string, unknown> | undefined> {
  const direct = parseReply(await exec(["pane", "get", stored.paneId]));
  const pane = direct.error ? undefined : paneFrom(direct.result);
  if (pane?.terminal_id === stored.terminalId) return pane;
  // A moved pane receives a new public id, possibly in another workspace; terminal_id is the stable handle.
  const listed = parseReply(await exec(["pane", "list"]));
  if (listed.error || !Array.isArray(listed.result?.panes)) return undefined;
  return (listed.result.panes as Record<string, unknown>[]).find((candidate) => candidate.terminal_id === stored.terminalId);
}

async function dashboardProcessIsLive(paneId: string, exec: HerdrExec): Promise<boolean> {
  const parsed = parseReply(await exec(["pane", "process-info", "--pane", paneId]));
  if (parsed.error) throw new Error(`could not verify existing dashboard process: ${parsed.error}`);
  const info = nested(parsed.result, "process_info");
  if (info?.pane_id !== paneId) throw new Error("Herdr returned process information for another dashboard pane");
  const processes = Array.isArray(info.foreground_processes) ? info.foreground_processes as Record<string, unknown>[] : [];
  return processes.some((process) => {
    const argv = Array.isArray(process.argv) ? process.argv.filter((value) => typeof value === "string").join(" ") : "";
    return String(process.name ?? "").startsWith("pi-daddy-dashboard") ||
      String(process.cmdline ?? "").includes("dashboard-cli.js") || argv.includes("dashboard-cli.js");
  });
}

async function closeUntrackedPane(paneId: string, exec: HerdrExec): Promise<string | undefined> {
  const closed = await exec(["plugin", "pane", "close", paneId]).catch(() => undefined);
  return closed ? parseReply(closed).error : "Herdr close command failed";
}

export interface DashboardOpenInput {
  exec?: HerdrExec;
  host: HerdrHost;
  ledgerPath: string;
  cwd: string;
  statePath: string;
  /** Expected bundled root; same-id plugins from another package are not invoked. */
  pluginRoot?: string;
  /** Installation handshake may open an explanatory pane before a ledger exists. */
  allowInactive?: boolean;
}
export interface DashboardOpenResult {
  kind: "opened" | "reused";
  paneId: string;
  tabId: string;
  workspaceId: string;
  visibleBesideCaller: boolean;
}

export async function openOrReuseDashboard(input: DashboardOpenInput): Promise<DashboardOpenResult> {
  if (!input.ledgerPath.trim() && !input.allowInactive) {
    throw new Error("no pi-daddy ledger is configured; set PI_GRANTS_LEDGER first");
  }
  const exec = input.exec ?? dashboardHerdrExec;
  const ledgerPath = input.ledgerPath.trim() ? resolve(input.cwd, input.ledgerPath) : "";
  const cwd = resolve(input.cwd);
  const key = createHash("sha256")
    .update(`${input.host.workspaceId}\0${input.host.tabId}\0${ledgerPath}`, "utf8")
    .digest("hex");
  await mkdir(dirname(input.statePath), { recursive: true });

  return withFileLock(input.statePath, "pi-daddy dashboard pane state", async () => {
    const plugin = await inspectDashboardPlugin(exec, input.pluginRoot);
    if (plugin.state !== "compatible") throw new Error(plugin.diagnostic);
    const store = await loadStore(input.statePath);
    const stored = store.panes[key];
    if (stored) {
      if (stored.workspaceId !== input.host.workspaceId || stored.tabId !== input.host.tabId ||
          stored.ledgerPath !== ledgerPath) {
        throw new Error(
          `dashboard pane state ${input.statePath} is corrupt: stored workspace/tab/ledger identity mismatch`,
        );
      }
      const pane = await locateStoredPane(stored, exec);
      if (pane && typeof pane.pane_id === "string" && pane.tab_id === input.host.tabId &&
          pane.workspace_id === input.host.workspaceId && await dashboardProcessIsLive(pane.pane_id, exec)) {
        stored.paneId = pane.pane_id;
        stored.tabId = pane.tab_id;
        stored.workspaceId = pane.workspace_id;
        stored.updatedAt = new Date().toISOString();
        await saveStore(input.statePath, store);
        return {
          kind: "reused",
          paneId: stored.paneId,
          tabId: stored.tabId,
          workspaceId: stored.workspaceId,
          visibleBesideCaller: stored.tabId === input.host.tabId,
        };
      }
      delete store.panes[key];
    }

    const args = [
      "plugin", "pane", "open", "--plugin", DASHBOARD_PLUGIN_ID,
      "--entrypoint", DASHBOARD_PLUGIN_ENTRYPOINT, "--placement", "split",
      "--target-pane", input.host.paneId,
      "--direction", "right", "--cwd", cwd,
      ...(ledgerPath ? ["--env", `${ENV_DASHBOARD_LEDGER}=${ledgerPath}`] : []),
      "--env", `${ENV_DASHBOARD_PROTOCOL}=${DASHBOARD_PROTOCOL_VERSION}`,
      "--env", `${ENV_DASHBOARD_KEY}=${key}`,
      "--no-focus",
    ];
    const opened = parseReply(await exec(args));
    if (opened.error) throw new Error(`Herdr could not open the pi-daddy dashboard: ${opened.error}`);
    const pane = paneFrom(opened.result);
    if (!pane || typeof pane.pane_id !== "string" || typeof pane.terminal_id !== "string" ||
        typeof pane.tab_id !== "string" || typeof pane.workspace_id !== "string") {
      throw new Error("Herdr opened the plugin but returned no complete pane identity");
    }
    if (pane.workspace_id !== input.host.workspaceId || pane.tab_id !== input.host.tabId) {
      const closeError = await closeUntrackedPane(pane.pane_id, exec);
      throw new Error(
        `Herdr returned the dashboard pane in another workspace or tab; ` +
        (closeError ? `the wrong-host pane also could not be closed (${closeError})` : "the wrong-host pane was closed"),
      );
    }
    store.panes[key] = {
      paneId: pane.pane_id,
      terminalId: pane.terminal_id,
      tabId: pane.tab_id,
      workspaceId: pane.workspace_id,
      ledgerPath,
      updatedAt: new Date().toISOString(),
    };
    try {
      await saveStore(input.statePath, store);
    } catch (error) {
      const closeError = await closeUntrackedPane(pane.pane_id, exec);
      throw new Error(
        `dashboard pane identity could not be persisted (${String(error)}); ` +
        (closeError ? `the new pane also could not be closed (${closeError})` : "the untracked pane was closed"),
      );
    }
    return {
      kind: "opened",
      paneId: pane.pane_id,
      tabId: pane.tab_id,
      workspaceId: pane.workspace_id,
      visibleBesideCaller: pane.tab_id === input.host.tabId,
    };
  });
}

export function dashboardPaneStatePath(agentDir: string): string {
  return resolve(agentDir, "pi-daddy", "dashboard-panes.json");
}
