import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { userInfo } from "node:os";
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
import { withFileLock } from "../governance/file-lock.ts";
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
    if (parsed?.version !== 1 || !Number.isInteger(parsed.protocol) || !["not-now", "never"].includes(parsed.choice)) {
      throw new Error("unsupported preference shape");
    }
    return parsed;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new Error(
      `dashboard preference ${path} is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  /** Supply an isolated OS account home when testing a shared Herdr registry. */
  registryOwnerHome?: string;
  paneStatePath: string;
  sessionEndpoint?: { socketPath: string; token: string };
  ui: DashboardHandshakeUI;
}

export type DashboardHandshakeOutcome =
  "not-applicable" | "suppressed" | "already-installed" | "installed" | "deferred" | "failed";

export async function offerDashboardHandshake(input: DashboardHandshakeInput): Promise<DashboardHandshakeOutcome> {
  if (input.mode !== "tui") return "not-applicable";
  const exec = input.exec ?? dashboardHerdrExec;
  const host = await verifyHerdrHost({ env: input.env, pid: input.pid, exec });
  if (!host.ok) return "not-applicable";

  try {
    const preference = await loadPreference(input.preferencePath);
    if (preference) return "suppressed";
    const plugin = await inspectDashboardPlugin(exec, input.pluginRoot);
    if (plugin.plugin?.enabled === false) return "suppressed";
    const replacing =
      plugin.state === "incompatible" && plugin.incompatibility === "package-root" && plugin.plugin?.enabled === true;
    if (plugin.state !== "compatible" && plugin.state !== "absent" && !replacing) {
      input.ui.notify(`pi-daddy dashboard: ${plugin.diagnostic}`, "error");
      return "failed";
    }
    if (replacing) {
      const choice = await input.ui.select(
        "The dashboard is linked to another Pi Daddy installation. Use this installation's dashboard instead?",
        ["Relink and open", "Not now", "Keep existing link"],
      );
      if (choice !== "Relink and open") {
        if (choice === "Keep existing link") await savePreference(input.preferencePath, "never");
        input.ui.notify("pi-daddy dashboard: kept the existing dashboard link.", "info");
        return "deferred";
      }
    }
    let outcome: DashboardHandshakeOutcome = "already-installed";
    if (plugin.state !== "compatible") {
      // Herdr plugin links are shared across Pi profiles. Lock once per OS account,
      // independently of Pi settings, environment HOME, and the bundled plugin path.
      const registryLock = resolve(
        input.registryOwnerHome ?? userInfo().homedir,
        ".cache",
        "pi-daddy",
        "herdr-plugin-registry",
      );
      await mkdir(dirname(registryLock), { recursive: true, mode: 0o700 });
      outcome = await withFileLock(registryLock, "dashboard setup", async () => {
        if (await loadPreference(input.preferencePath)) return "suppressed" as const;
        const current = await inspectDashboardPlugin(exec, input.pluginRoot);
        if (current.state === "compatible") return "already-installed" as const;
        if (
          current.state !== plugin.state ||
          current.incompatibility !== plugin.incompatibility ||
          current.plugin?.plugin_root !== plugin.plugin?.plugin_root ||
          current.plugin?.enabled !== plugin.plugin?.enabled
        )
          throw Error("The dashboard installation changed during startup. Reopen the dashboard to inspect it.");
        await linkDashboardPlugin(input.pluginRoot, exec);
        const linked = await inspectDashboardPlugin(exec, input.pluginRoot);
        if (linked.state !== "compatible") throw new Error(linked.diagnostic);
        return "installed" as const;
      });
      if (outcome === "suppressed") return outcome;
    }
    const opened = await openOrReuseDashboard({
      exec,
      host: host.host,
      ledgerPath: input.ledgerPath ?? "",
      cwd: input.cwd,
      statePath: input.paneStatePath,
      pluginRoot: input.pluginRoot,
      allowInactive: true,
      sessionEndpoint: input.sessionEndpoint,
    });
    input.ui.notify(`pi-daddy dashboard ${opened.kind} in pane ${opened.paneId} without changing focus.`, "info");
    return outcome;
  } catch (error) {
    input.ui.notify(
      `pi-daddy dashboard setup failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
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
  sessionEndpoint?: { socketPath: string; token: string };
}

export type DashboardCommandResult =
  DashboardOpenResult | { kind: "fallback"; frame: string; visibleBesideCaller: false };
async function piFallback(cwd: string, reason: string): Promise<Extract<DashboardCommandResult, { kind: "fallback" }>> {
  try {
    return {
      kind: "fallback",
      visibleBesideCaller: false,
      frame: `${reason}\n\n${renderActivityTimeline(parseActivityTimeline(await readFile(defaultActivityTimelinePath(cwd), "utf8")))}`,
    };
  } catch {
    return { kind: "fallback", visibleBesideCaller: false, frame: `${reason}\n\nNo local activity recorded yet.` };
  }
}
export async function openDashboardCommand(input: DashboardCommandInput): Promise<DashboardCommandResult> {
  const exec = input.exec ?? dashboardHerdrExec;
  // A panel can only target this verified process; otherwise /grants dashboard renders the local Pi fallback.
  const host = await verifyHerdrHost({ env: input.env, pid: input.pid, exec });
  if (!host.ok) return piFallback(input.cwd, `Herdr panel unavailable: ${host.diagnostic}`);
  if (!input.ledgerPath?.trim())
    return piFallback(input.cwd, "Herdr panel has no governance ledger; showing the local activity timeline.");
  const plugin = await inspectDashboardPlugin(exec, input.pluginRoot);
  if (plugin.state === "absent")
    return piFallback(
      input.cwd,
      `Herdr panel is not linked. Run: herdr plugin link ${quote(resolve(input.pluginRoot))} --enabled`,
    );
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
    sessionEndpoint: input.sessionEndpoint,
  });
}

export function defaultDashboardPaths(agentDir: string): { preferencePath: string; paneStatePath: string } {
  return {
    preferencePath: dashboardPreferencePath(agentDir),
    paneStatePath: dashboardPaneStatePath(agentDir),
  };
}
