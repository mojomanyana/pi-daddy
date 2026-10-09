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
import { createInterface, emitKeypressEvents, type Key } from "node:readline";
import { parseDashboardLedger } from "./dashboard-projection.ts";
import { renderDashboard } from "./dashboard-render.ts";
import {
  ActivityTimelineAliases,
  activityTaskKey,
  defaultActivityTimelinePath,
  detailForTimeline,
  parseActivityTimeline,
  renderActivityTimeline,
  resolveActivityTaskSelector,
  type TimelineFilter,
} from "./activity-timeline.ts";
import { createDashboardDisplayControls } from "./dashboard-display-controls.ts";
import {
  createDashboardConnection,
  dashboardSessionRequest,
  type DashboardSessionSnapshot,
} from "./dashboard-session-client.ts";
import { adoptLegacyEnvironment, ENV_LEDGER, legacyEnvironmentWarning } from "../kernel/env-names.ts";
import { projectLedgerPath } from "../kernel/project-paths.ts";
import {
  activityDashboardItems,
  ledgerDashboardItems,
  renderDashboardScreen,
  type DashboardItem,
  type DashboardScreenState,
} from "./dashboard-screen.ts";

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
  height?: number;
  screen?: DashboardScreenState;
  notice?: string;
  pending?: boolean;
  command?: string;
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

function isActivityTimelineText(text: string): boolean {
  try {
    const first = JSON.parse(text.trimStart().split("\n")[0] || "{}");
    return first?.kind === "activity" || first?.version === 1;
  } catch {
    return false;
  }
}

async function compactFrame(options: DashboardFrameOptions): Promise<string> {
  const path = resolve(options.cwd, options.ledgerPath ?? defaultActivityTimelinePath(options.cwd));
  let items: DashboardItem[] = [],
    problem: string | undefined,
    current: string | undefined,
    currentStatus: string | undefined;
  let content: { title: string; text: string } | undefined;
  const aliases = options.activityAliases ?? new ActivityTimelineAliases();
  if (options.protocol !== undefined && options.protocol !== DASHBOARD_PROTOCOL_VERSION)
    return renderDashboardScreen({
      ...options,
      width: options.width ?? 80,
      height: options.height!,
      screen: options.screen!,
      items: [],
      problem: "INCOMPATIBLE dashboard protocol; relink this package.",
    });
  try {
    const text = await readFile(path, "utf8");
    if (!options.ledgerPath || isActivityTimelineText(text)) {
      const timeline = parseActivityTimeline(text);
      items = activityDashboardItems(timeline, aliases, options.now ?? new Date()).map((item) => ({
        ...item,
        timelinePath: path,
      }));
      problem = timeline.refusals[0];
    } else {
      const projection = parseDashboardLedger(text, { now: options.now });
      items = ledgerDashboardItems(projection);
      if (projection.corrupt.length) problem = `Ledger unavailable: ${projection.corrupt.length} corrupt line(s)`;
    }
  } catch (error) {
    problem =
      (error as { code?: string }).code === "ENOENT"
        ? "Waiting for local work; open from /grants dashboard."
        : `Evidence unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  // The owner supplies this exact current turn. No sibling timeline or unrelated history is merged.
  const activity = options.session?.activity;
  if (activity) {
    const key = activityTaskKey(activity.rootId, activity.taskId);
    current = `Task ${activity.taskId}`;
    try {
      const timeline = parseActivityTimeline(await readFile(activity.path, "utf8"));
      timeline.tasks = timeline.tasks.filter((task) => activityTaskKey(task.rootId, task.id) === key);
      const item = activityDashboardItems(timeline, aliases, options.now ?? new Date())[0];
      if (item) {
        current = item.label;
        currentStatus = item.status;
        if (!items.some((existing) => existing.key === key)) items.unshift({ ...item, timelinePath: activity.path });
        try {
          current = (await detailForTimeline(activity.path, key, "prompt")).text.slice(0, 600);
        } catch {
          /* Metadata-only/off and unavailable retained content retain the exact task identity. */
        }
      }
    } catch {
      /* The owner identity remains useful when its local timeline is unavailable. */
    }
  }
  if (options.activityDetail) {
    try {
      const requested = aliases.resolve(options.activityDetail.taskKey) ?? options.activityDetail.taskKey;
      const key = items.find((value) => value.taskKey === requested)?.taskKey;
      if (!key) throw Error("unknown task selector");
      options.screen!.selectedKey = key;
      const source = items.find((value) => value.taskKey === key)?.timelinePath;
      if (!source) throw Error("task has no retained activity source");
      content = {
        title: `PRIVATE ${options.activityDetail.field.toUpperCase()}`,
        text: (await detailForTimeline(source, key, options.activityDetail.field)).text,
      };
    } catch (error) {
      problem = `Activity detail unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return renderDashboardScreen({
    ...options,
    width: options.width ?? 80,
    height: options.height!,
    screen: options.screen!,
    items,
    problem,
    content,
    current,
    currentStatus,
  });
}

export async function dashboardFrame(options: DashboardFrameOptions): Promise<string> {
  if (options.screen && options.height !== undefined) return compactFrame(options);
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
  const rendered = isActivityTimelineText(text)
    ? await renderTimelineFile(ledgerPath, text, options)
    : renderDashboard(parseDashboardLedger(text, { now: options.now }), {
        color: options.color,
        width: options.width,
        details: options.details,
        history: options.history,
        modelRows: options.session?.rows,
        episodeCost: options.session ? { cost: options.session.cost } : undefined,
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
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !cli.once;
  const connection = createDashboardConnection(
    sessionSocket && sessionToken
      ? (action) => dashboardSessionRequest(sessionSocket, sessionToken, action)
      : undefined,
  );
  let previous = "",
    notice = "",
    command: string | undefined;
  let input: ReturnType<typeof createInterface> | null = null;
  let stopped = false,
    drawing = false;
  const draw = async (clear: boolean): Promise<void> => {
    await connection.refresh();
    if (stopped) return;
    const view = await dashboardFrame({
      cwd,
      ledgerPath,
      protocol,
      color: cli.color,
      width: process.stdout.columns || 80,
      ...display.state,
      activityAliases: display.aliases,
      session: connection.state.snapshot,
      ...(interactive
        ? {
            height: process.stdout.rows || 24,
            screen: display.screen,
            notice: connection.state.error || notice,
            pending: connection.state.pending,
            command,
          }
        : {}),
    });
    if (stopped) return; // A read may complete after q/SIGTERM restored the parent terminal.
    const frame = interactive
      ? view
      : `${connection.state.error || notice ? `${connection.state.error || notice}\n\n` : ""}${view}`;
    const prompt = display.prompt(),
      draft = input?.line ?? "";
    const rendered = `${frame}${!interactive && input ? `\n\n${prompt}${draft}` : ""}`;
    if (rendered === previous) return;
    previous = rendered;
    process.stdout.write(
      interactive
        ? // Erase every row: clearing only below the final cursor leaves old suffixes on shorter rows.
          `\u001b[H\u001b[2K${frame.replace(/\n/g, "\r\n\u001b[2K")}\u001b[J`
        : clear
          ? `\u001b]0;PI-DADDY\u0007\u001b[2J\u001b[H${rendered}`
          : `${rendered}\n`,
    );
    input?.setPrompt(prompt);
  };
  if (cli.once) {
    await draw(false);
    return;
  }
  const redraw = (): void => {
    if (drawing || stopped) return;
    drawing = true;
    void draw(true)
      .catch((error) => {
        notice = `Dashboard unavailable: ${String(error)}`;
      })
      .finally(() => {
        drawing = false;
      });
  };
  const runCommand = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed.startsWith("m ")) {
      notice = (await connection.change({ action: "set", edits: trimmed.slice(2).trim() }))
        ? "Session models updated"
        : connection.state.error || "Session controls unavailable";
    } else if (trimmed.startsWith("limit ")) {
      const edit = /^limit (wall|idle) ([0-9]+)$/.exec(trimmed);
      if (!edit) notice = "Use limit wall <seconds> or limit idle <seconds>; 0 restores default";
      else
        notice = (await connection.change({
          action: "set-limit",
          key: edit[1] as "wall" | "idle",
          seconds: Number(edit[2]),
        }))
          ? "Session limit updated for future children; running children unchanged"
          : connection.state.error || "Settings unavailable";
    } else notice = display.input(line) ? "" : `Unknown command: ${trimmed}. Press ? for help.`;
    redraw();
  };
  let stop: () => void = () => {};
  const keypress = (text: string | undefined, key: Key): void => {
    if (key.ctrl && key.name === "c") {
      stop();
      return;
    }
    if (command !== undefined) {
      if (key.name === "escape") command = undefined;
      else if (key.name === "return") {
        const line = command;
        command = undefined;
        void runCommand(line);
      } else if (key.name === "backspace") command = [...command].slice(0, -1).join("");
      else if (text && !key.ctrl && !key.meta && !/[\p{Cc}\p{Cf}]/u.test(text) && command.length < 2048)
        command += text;
      redraw();
      return;
    }
    let action = display.key(
      key.name === "return"
        ? "return"
        : ["up", "down", "escape", "tab"].includes(key.name || "")
          ? key.name!
          : text || "",
    );
    if (action === "quit") {
      stop();
      return;
    }
    if (action === "command") command = "";
    if (action === "setting") {
      const selected = display.screen.settingKey ?? "auto";
      const settings = connection.state.snapshot?.settings;
      if (!settings?.editable) notice = "Settings can only be changed in the connected owning parent";
      else if (selected === "auto") action = "auto";
      else if (selected === "wall" || selected === "idle") command = `limit ${selected} `;
      else if (selected === "descendants") notice = "Startup only: set PI_DADDY_FANOUT before restarting Pi";
      else if (selected === "depth") notice = "Startup only: set PI_DADDY_MAX_DEPTH before restarting Pi";
      else if (selected === "perCall") notice = "Children per call is a fixed safety bound";
      else if (!settings.jev.available)
        notice = "JEV controls unavailable; load skill-harness in the parent Pi session";
      else {
        void connection
          .change({ action: "set-jev", enabled: !(settings.jev.enabled || settings.jev.pending) })
          .then((changed) => {
            const jev = connection.state.snapshot?.settings?.jev;
            notice = !changed
              ? connection.state.error || "JEV change already pending"
              : jev?.pending
                ? "Complete JEV paid-call and LoRA-storage choices in the parent Pi session"
                : jev?.error ||
                  `JEV ${jev?.enabled ? "enabled" : "disabled"}; ${jev?.availability ?? "status unknown"}`;
            redraw();
          });
      }
    }
    if (action === "auto") {
      const snapshot = connection.state.snapshot;
      if (!snapshot) notice = "Daddy permission controls unavailable";
      else {
        const enabled = !snapshot.auto.enabled;
        void connection.change({ action: "set-auto", enabled }).then((changed) => {
          notice = changed
            ? `Daddy permission Auto ${enabled ? "ON" : "OFF"}; ${enabled ? "future prompts auto-approved" : "admitted work continues"}`
            : connection.state.error || "Permission change already pending";
          redraw();
        });
      }
    }
    redraw();
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  const oldRaw = process.stdin.isRaw;
  try {
    if (interactive) {
      emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdout.write("\u001b[?1049h\u001b[?25l");
    } else {
      input = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      input.on("line", (line) => {
        void runCommand(line);
      });
    }
    await new Promise<void>((settle) => {
      stop = () => {
        stopped = true;
        settle();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      if (interactive) process.stdin.on("keypress", keypress);
      process.on("SIGWINCH", redraw);
      timer = setInterval(redraw, DASHBOARD_REFRESH_MS);
      redraw();
    });
  } finally {
    stopped = true;
    if (timer) clearInterval(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGWINCH", redraw);
    input?.close();
    if (interactive) {
      process.stdin.off("keypress", keypress);
      process.stdin.setRawMode(oldRaw || false);
      process.stdin.pause();
      process.stdout.write("\u001b[?25h\u001b[?1049l");
    }
  }
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
