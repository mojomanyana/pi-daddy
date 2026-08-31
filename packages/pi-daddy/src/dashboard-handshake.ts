import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DASHBOARD_PLUGIN_ID,
  dashboardHerdrExec,
  dashboardPaneStatePath,
  inspectDashboardPlugin,
  linkDashboardPlugin,
  openOrReuseDashboard,
  verifyHerdrHost,
  type DashboardOpenResult,
} from "./dashboard-herdr.ts";
import { DASHBOARD_PROTOCOL_VERSION } from "./dashboard-cli.ts";
import type { HerdrExec } from "./herdr-cli.ts";

export type DashboardPromptChoice = "not-now" | "never";
interface DashboardPreference {
  version: 1;
  protocol: number;
  choice: DashboardPromptChoice;
  recordedAt: string;
}

export function dashboardPreferencePath(agentDir: string): string {
  return resolve(agentDir, "pi-daddy", "dashboard-preference.json");
}

async function loadPreference(path: string): Promise<DashboardPreference | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as DashboardPreference;
    if (parsed?.version !== 1 || !Number.isInteger(parsed.protocol) ||
        !["not-now", "never"].includes(parsed.choice)) {
      throw new Error("unsupported preference shape");
    }
    return parsed;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new Error(`dashboard preference ${path} is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function savePreference(path: string, choice: DashboardPromptChoice): Promise<void> {
  const preference: DashboardPreference = {
    version: 1,
    protocol: DASHBOARD_PROTOCOL_VERSION,
    choice,
    recordedAt: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(preference, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface DashboardHandshakeUI {
  select(title: string, choices: string[]): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface DashboardHandshakeInput {
  mode: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  pid?: number;
  exec?: HerdrExec;
  cwd: string;
  ledgerPath?: string;
  pluginRoot: string;
  preferencePath: string;
  paneStatePath: string;
  ui: DashboardHandshakeUI;
}

export type DashboardHandshakeOutcome = "not-applicable" | "suppressed" | "already-installed" | "installed" | "deferred" | "failed";

export async function offerDashboardHandshake(input: DashboardHandshakeInput): Promise<DashboardHandshakeOutcome> {
  if (input.mode !== "tui") return "not-applicable";
  const exec = input.exec ?? dashboardHerdrExec;
  const host = await verifyHerdrHost({ env: input.env, pid: input.pid, exec });
  if (!host.ok) return "not-applicable";

  try {
    const preference = await loadPreference(input.preferencePath);
    if (preference) return "suppressed";
    const plugin = await inspectDashboardPlugin(exec, input.pluginRoot);
    if (plugin.state === "compatible") return "already-installed";
    if (plugin.state !== "absent") {
      input.ui.notify(`pi-daddy dashboard: ${plugin.diagnostic}`, "error");
      return "failed";
    }

    const choice = await input.ui.select(
      "Herdr detected. Install and open the pi-daddy dashboard?",
      ["Install and open", "Not now", "Never ask"],
    );
    if (choice !== "Install and open" && choice !== "Not now" && choice !== "Never ask") {
      // Escape, timeout and UI teardown return undefined. None is an operator choice, so none may become a
      // durable preference merely because the dialog disappeared.
      input.ui.notify("pi-daddy dashboard: installation prompt dismissed; no preference was stored.", "info");
      return "deferred";
    }
    if (choice !== "Install and open") {
      const recorded = choice === "Never ask" ? "never" : "not-now";
      await savePreference(input.preferencePath, recorded);
      input.ui.notify(
        recorded === "never"
          ? "pi-daddy dashboard: startup installation prompt disabled. /grants dashboard remains available."
          : "pi-daddy dashboard: not installed. /grants dashboard will report the manual setup when requested.",
        "info",
      );
      return "deferred";
    }

    await linkDashboardPlugin(input.pluginRoot, exec);
    const linked = await inspectDashboardPlugin(exec, input.pluginRoot);
    if (linked.state !== "compatible") throw new Error(linked.diagnostic);
    const opened = await openOrReuseDashboard({
      exec,
      host: host.host,
      ledgerPath: input.ledgerPath ?? "",
      cwd: input.cwd,
      statePath: input.paneStatePath,
      pluginRoot: input.pluginRoot,
      allowInactive: true,
    });
    input.ui.notify(
      `pi-daddy dashboard ${opened.kind} in pane ${opened.paneId} without changing focus.`,
      "info",
    );
    return "installed";
  } catch (error) {
    input.ui.notify(`pi-daddy dashboard setup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return "failed";
  }
}

export interface DashboardCommandInput {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  pid?: number;
  exec?: HerdrExec;
  cwd: string;
  ledgerPath?: string;
  pluginRoot: string;
  paneStatePath: string;
}

export async function openDashboardCommand(input: DashboardCommandInput): Promise<DashboardOpenResult> {
  const exec = input.exec ?? dashboardHerdrExec;
  // Order is deliberate: a server elsewhere must not make an outside-pi command look hosted.
  const host = await verifyHerdrHost({ env: input.env, pid: input.pid, exec });
  if (!host.ok) throw new Error(host.diagnostic);
  if (!input.ledgerPath?.trim()) {
    throw new Error("no pi-daddy ledger is configured — set PI_GRANTS_LEDGER, then retry /grants dashboard");
  }
  const plugin = await inspectDashboardPlugin(exec, input.pluginRoot);
  if (plugin.state === "absent") {
    throw new Error(
      `the pi-daddy Herdr plugin is not installed. Nothing was installed automatically. Run: ` +
      `herdr plugin link ${quote(resolve(input.pluginRoot))} --enabled`,
    );
  }
  if (plugin.state === "disabled") {
    throw new Error(`the pi-daddy Herdr plugin is disabled. Run: herdr plugin enable ${DASHBOARD_PLUGIN_ID}`);
  }
  if (plugin.state !== "compatible") throw new Error(plugin.diagnostic);
  return openOrReuseDashboard({
    exec,
    host: host.host,
    ledgerPath: input.ledgerPath,
    cwd: input.cwd,
    statePath: input.paneStatePath,
    pluginRoot: input.pluginRoot,
  });
}

export function defaultDashboardPaths(agentDir: string): { preferencePath: string; paneStatePath: string } {
  return {
    preferencePath: dashboardPreferencePath(agentDir),
    paneStatePath: dashboardPaneStatePath(agentDir),
  };
}
