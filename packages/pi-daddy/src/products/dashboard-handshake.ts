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
import type { HerdrExec } from "../executors/herdr-cli.ts";
import { defaultActivityTimelinePath, parseActivityTimeline, renderActivityTimeline } from "./activity-timeline.ts";

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
    // A compatible bundled panel is local software already chosen by the operator. Present it by default;
    // pane identity makes this one panel per caller tab/session and --no-focus avoids focus theft.
    if (plugin.state === "compatible") {
      const opened = await openOrReuseDashboard({ exec, host: host.host, ledgerPath: input.ledgerPath ?? "", cwd: input.cwd, statePath: input.paneStatePath, pluginRoot: input.pluginRoot, allowInactive: true });
      input.ui.notify(`pi-daddy dashboard ${opened.kind} in pane ${opened.paneId} without changing focus.`, "info");
      return "already-installed";
    }
    const replacingDifferentPackage = plugin.state === "incompatible" && plugin.incompatibility === "package-root";
    if (plugin.state !== "absent" && !replacingDifferentPackage) {
      input.ui.notify(`pi-daddy dashboard: ${plugin.diagnostic}`, "error");
      return "failed";
    }

    const affirmative = replacingDifferentPackage ? "Relink and open" : "Install and open";
    const choices = replacingDifferentPackage ? [affirmative, "Not now"] : [affirmative, "Not now", "Never ask"];
    const choice = await input.ui.select(
      replacingDifferentPackage
        ? "The pi-daddy dashboard is linked from a different package. Relink this bundled copy and open it?"
        : "Herdr detected. Install and open the pi-daddy dashboard?",
      choices,
    );
    if (!choices.includes(choice ?? "")) {
      // Escape, timeout and UI teardown return undefined. None is an operator choice, so none may become a
      // durable preference merely because the dialog disappeared.
      input.ui.notify("pi-daddy dashboard: installation prompt dismissed; no preference was stored.", "info");
      return "deferred";
    }
    if (choice !== affirmative) {
      if (replacingDifferentPackage) {
        input.ui.notify("pi-daddy dashboard: existing link unchanged; no preference was stored.", "info");
        return "deferred";
      }
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

export type DashboardCommandResult = DashboardOpenResult | { kind: "fallback"; frame: string; visibleBesideCaller: false };
async function piFallback(cwd: string, reason: string): Promise<Extract<DashboardCommandResult, { kind: "fallback" }>> {
  try { return { kind: "fallback", visibleBesideCaller: false, frame: `${reason}\n\n${renderActivityTimeline(parseActivityTimeline(await readFile(defaultActivityTimelinePath(cwd), "utf8")))}` }; }
  catch { return { kind: "fallback", visibleBesideCaller: false, frame: `${reason}\n\nNo local activity recorded yet.` }; }
}
export async function openDashboardCommand(input: DashboardCommandInput): Promise<DashboardCommandResult> {
  const exec = input.exec ?? dashboardHerdrExec;
  // A panel can only target this verified process; otherwise /grants dashboard renders the local Pi fallback.
  const host = await verifyHerdrHost({ env: input.env, pid: input.pid, exec });
  if (!host.ok) return piFallback(input.cwd, `Herdr panel unavailable: ${host.diagnostic}`);
  if (!input.ledgerPath?.trim()) return piFallback(input.cwd, "Herdr panel has no governance ledger; showing the local activity timeline.");
  const plugin = await inspectDashboardPlugin(exec, input.pluginRoot);
  if (plugin.state === "absent") return piFallback(input.cwd, `Herdr panel is not linked. Run: herdr plugin link ${quote(resolve(input.pluginRoot))} --enabled`);
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
