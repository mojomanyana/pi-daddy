#!/usr/bin/env node
/**
 * `pi-daddy-dashboard` — the view of one ledger or activity timeline plus session model controls.
 *
 * Ledger and cost views are read-only. When the owning pi session supplies its private endpoint, model edits are
 * sent back to that process and use the same in-memory mutation and audit path as `/grants models`.
 */
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { parseDashboardLedger } from "./dashboard-projection.ts";
import { renderDashboard } from "./dashboard-render.ts";
import {
  ActivityTimelineAliases,
  defaultActivityTimelinePath,
  detailForTimeline,
  parseActivityTimeline,
  renderActivityTimeline,
  resolveActivityTaskSelector,
  type TimelineFilter,
} from "./activity-timeline.ts";
import { createDashboardDisplayControls } from "./dashboard-display-controls.ts";
import { dashboardSessionRequest, type DashboardSessionSnapshot } from "./dashboard-session-client.ts";
import { adoptLegacyEnvironment, ENV_LEDGER, legacyEnvironmentWarning } from "../kernel/env-names.ts";
import { projectLedgerPath } from "../kernel/project-paths.ts";

export const DASHBOARD_PROTOCOL_VERSION = 1 as const;
export const ENV_DASHBOARD_LEDGER = ENV_LEDGER; // one ledger path variable for children and the dashboard (ADR-0076 PR 3b)
export const ENV_DASHBOARD_PROTOCOL = "PI_DADDY_DASHBOARD_PROTOCOL";
export const ENV_DASHBOARD_KEY = "PI_DADDY_DASHBOARD_KEY";
export const ENV_DASHBOARD_SESSION_SOCKET = "PI_DADDY_DASHBOARD_SESSION_SOCKET";
export const ENV_DASHBOARD_SESSION_TOKEN = "PI_DADDY_DASHBOARD_SESSION_TOKEN";
export const DASHBOARD_REFRESH_MS = 250;

export interface DashboardFrameOptions {
  cwd: string;
  ledgerPath?: string;
  protocol?: number;
  color?: boolean;
  width?: number;
  details?: boolean;
  history?: boolean;
  filter?: TimelineFilter;
  activityDetail?: { taskKey: string; field: "prompt" | "final" };
  activityAliases?: ActivityTimelineAliases;
  now?: Date;
  session?: DashboardSessionSnapshot;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function setupFrame(cwd: string): string {
  const ledger = projectLedgerPath(cwd);
  return [
    "PI-DADDY",
    "",
    "pi-daddy is missing or its ledger is inactive in this workspace.",
    "Nothing was installed or configured automatically.",
    "",
    "Run exactly:",
    "  pi install npm:pi-daddy",
    `  export PI_DADDY_LEDGER=${shellQuote(ledger)}`,
    "  pi",
    "",
    "Then run /grants dashboard inside that Herdr-hosted pi session.",
  ].join("\n");
}

function incompatibleFrame(protocol: number): string {
  return [
    "PI-DADDY — INCOMPATIBLE DASHBOARD",
    "",
    `dashboard plugin protocol ${DASHBOARD_PROTOCOL_VERSION}; core requested ${protocol}.`,
    "No execution state is rendered because assigning old fields new meaning would be unsafe.",
    "Relink the dashboard from the same installed pi-daddy package, then retry /grants dashboard.",
  ].join("\n");
}

async function renderTimelineFile(path: string, text: string, options: DashboardFrameOptions): Promise<string> {
  const timeline = parseActivityTimeline(text);
  let content: { taskKey: string; field: "prompt" | "final"; text: string } | undefined;
  if (options.activityDetail)
    try {
      const taskKey = resolveActivityTaskSelector(timeline, options.activityDetail.taskKey, options.activityAliases);
      if (!taskKey) throw Error("TIMELINE_DETAIL_INVALID");
      content = await detailForTimeline(path, taskKey, options.activityDetail.field);
    } catch (error) {
      return `PI-DADDY — ACTIVITY DETAIL UNAVAILABLE\n${error instanceof Error ? error.message : String(error)}`;
    }
  return renderActivityTimeline(timeline, {
    details: options.details,
    history: options.history,
    filter: options.filter,
    color: options.color,
    width: options.width,
    aliases: options.activityAliases,
    content,
  });
}

export async function dashboardFrame(options: DashboardFrameOptions): Promise<string> {
  if (options.protocol !== undefined && options.protocol !== DASHBOARD_PROTOCOL_VERSION) {
    return incompatibleFrame(options.protocol);
  }
  // The timeline is the default local surface. With no ledger configured, a missing timeline shows the setup
  // frame so a pane opened before pi has run remains explanatory.
  const configuredPath = options.ledgerPath ?? defaultActivityTimelinePath(options.cwd);
  if (!options.ledgerPath) {
    try {
      const activityPath = resolve(options.cwd, configuredPath);
      return await renderTimelineFile(activityPath, await readFile(activityPath, "utf8"), options);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return setupFrame(options.cwd);
      return "PI-DADDY — ACTIVITY UNAVAILABLE\nTimeline could not be read; no substitute view was shown.";
    }
  }

  const ledgerPath = resolve(options.cwd, configuredPath);
  let text = "";
  let waiting = false;
  try {
    text = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") waiting = true;
    else {
      return [
        "PI-DADDY — LEDGER UNAVAILABLE",
        "",
        `Configured ledger: ${ledgerPath}`,
        `Could not read it: ${error instanceof Error ? error.message : String(error)}`,
        "The dashboard did not substitute an empty tree for this failure.",
      ].join("\n");
    }
  }
  const rendered = text.trimStart().startsWith('{"version":1')
    ? await renderTimelineFile(ledgerPath, text, options)
    : renderDashboard(parseDashboardLedger(text, { now: options.now }), {
        color: options.color,
        width: options.width,
        details: options.details,
        history: options.history,
        modelRows: options.session?.rows,
        episodeCost: options.session ? { cost: options.session.cost, ceiling: options.session.ceiling } : undefined,
      });
  return waiting ? `${rendered}\n\nwaiting for ledger ${ledgerPath}` : rendered;
}

interface CliOptions {
  once: boolean;
  details: boolean;
  color: boolean;
  ledgerPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  let once = false;
  let details = false;
  let color = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
  let ledgerPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--once") once = true;
    else if (arg === "--details") details = true;
    else if (arg === "--no-color") color = false;
    else if (arg === "--ledger") ledgerPath = argv[++index];
    else throw new Error(`unknown dashboard argument ${JSON.stringify(arg)}`);
  }
  return { once, details, color, ledgerPath };
}

export async function runDashboard(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const adoptedLegacy = adoptLegacyEnvironment(env);
  if (adoptedLegacy.length > 0) console.error(legacyEnvironmentWarning(adoptedLegacy));
  const cli = parseArgs(argv);
  const cwd = process.cwd();
  const ledgerPath = cli.ledgerPath ?? (env[ENV_DASHBOARD_LEDGER]?.trim() || undefined);
  const rawProtocol = env[ENV_DASHBOARD_PROTOCOL]?.trim();
  const protocol = rawProtocol === undefined || rawProtocol === "" ? undefined : Number(rawProtocol);
  const key = env[ENV_DASHBOARD_KEY]?.trim();
  const sessionSocket = env[ENV_DASHBOARD_SESSION_SOCKET]?.trim();
  const sessionToken = env[ENV_DASHBOARD_SESSION_TOKEN]?.trim();
  process.title = `pi-daddy-dashboard${key ? `:${key.slice(0, 12)}` : ""}`;

  const display = createDashboardDisplayControls(cli.details, true);
  let previous = "";
  let notice = "";
  let input: ReturnType<typeof createInterface> | null = null;
  const draw = async (clear: boolean): Promise<void> => {
    let session: DashboardSessionSnapshot | undefined;
    if (sessionSocket && sessionToken)
      try {
        session = await dashboardSessionRequest(sessionSocket, sessionToken, { action: "get" });
      } catch (error) {
        notice ||= `session controls unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    const view = await dashboardFrame({
      cwd,
      ledgerPath,
      protocol,
      color: cli.color,
      width: process.stdout.columns || 80,
      ...display.state,
      activityAliases: display.aliases,
      session,
    });
    const frame = notice ? `${notice}\n\n${view}` : view;
    if (frame === previous && !clear) return;
    previous = frame;
    const prompt = display.prompt();
    const draft = input?.line ?? "";
    process.stdout.write(
      clear ? `\u001b]0;PI-DADDY\u0007\u001b[2J\u001b[H${frame}\n\n${input ? prompt + draft : ""}` : `${frame}\n`,
    );
    if (input) input.setPrompt(prompt);
  };

  if (cli.once) {
    await draw(false);
    return;
  }
  input = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  await draw(true);
  let drawing = false;
  const redraw = (): void => {
    if (drawing) return;
    drawing = true;
    void draw(true).finally(() => {
      drawing = false;
    });
  };
  input.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("m ") && sessionSocket && sessionToken) {
      void dashboardSessionRequest(sessionSocket, sessionToken, { action: "set", edits: trimmed.slice(2).trim() })
        .then(() => {
          notice = "session model defaults updated";
        })
        .catch((error) => {
          notice = `model edit refused: ${error instanceof Error ? error.message : String(error)}`;
        })
        .finally(redraw);
      return;
    }
    // Rule 8: a line the display controls do not understand is said so, never swallowed.
    notice = display.input(line) ? "" : `not a display command: ${JSON.stringify(trimmed)}. ${display.prompt()}`;
    redraw();
  });
  const timer = setInterval(redraw, DASHBOARD_REFRESH_MS);
  process.on("SIGWINCH", redraw);
  await new Promise<void>((settle) => {
    const stop = () => {
      clearInterval(timer);
      input?.close();
      process.off("SIGWINCH", redraw);
      settle();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

const invoked = (() => {
  try {
    return process.argv[1] ? import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href : false;
  } catch {
    return false;
  }
})();
if (invoked) {
  runDashboard().catch((error) => {
    process.stderr.write(`pi-daddy dashboard failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
