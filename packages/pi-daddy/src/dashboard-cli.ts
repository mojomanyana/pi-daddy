#!/usr/bin/env node
import { connectDashboardHost, isDashboardConnection, ENV_DASHBOARD_HOST_SOCKET, type DashboardConnection } from "./dashboard-host-transport.ts";
import { dashboardHostRequest, type DashboardHostRequest } from "./dashboard-host.ts";
export { ENV_DASHBOARD_HOST_SOCKET } from "./dashboard-host-transport.ts";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDashboardLedger } from "./dashboard-projection.ts";
import { renderDashboard } from "./dashboard-render.ts";
import { ActivityTimelineAliases, defaultActivityTimelinePath, detailForTimeline, parseActivityTimeline, renderActivityTimeline, resolveActivityTaskSelector, type TimelineFilter } from "./activity-timeline.ts";
import { createDashboardDisplayControls } from "./dashboard-display-controls.ts";
import { createDailyViewReader, isDailyViewReader, readDailyView, type DailyViewOptions } from "./daily-view.ts";
import { renderDailyView } from "./daily-view-render.ts";
import { renderDailyPanel, panelLines, learningSummary, type PanelAction, type WorkPresentation } from "./daily-panel.ts";
import { createDashboardMenu } from "./dashboard-menu.ts";
import { projectWorkLedger, type WorkProjectionContext } from "./work-ledger.ts";
import { parseRetentionJson } from "./retention-json.ts";
import { createInterface } from "node:readline";
import { isDebriefPresenter, type DebriefPresenter } from "./debrief.ts";
import { renderDebrief, debriefAction } from "./debrief-render.ts";
import { createFixtureDebrief } from "./debrief-fixture.ts";
export const ENV_DEBRIEF_FIXTURE = "PI_DADDY_DEBRIEF_FIXTURE";
export { debriefAction as dashboardDebriefAction } from "./debrief-render.ts";

export const ENV_DAILY_ARCHIVE = "PI_DADDY_ARCHIVE_PROJECTION";
export const ENV_DAILY_WORK = "PI_DADDY_WORK_LEDGER";
export const ENV_DAILY_SELECTION = "PI_DADDY_WORK_SNAPSHOT";
function dailySelection(text: string | undefined): WorkProjectionContext["selectedSnapshot"] {
  if (!text) return null;
  const selection = parseRetentionJson(text) as WorkProjectionContext["selectedSnapshot"];
  if (projectWorkLedger("", { selectedSnapshot: selection, authority: null }).errors.some(e => e.code === "WORK_CONTEXT_INVALID")) throw new TypeError("invalid P01 snapshot selection");
  return selection;
}

export const DASHBOARD_PROTOCOL_VERSION = 1 as const;
export const ENV_DASHBOARD_LEDGER = "PI_DADDY_LEDGER";
export const ENV_DASHBOARD_PROTOCOL = "PI_DADDY_DASHBOARD_PROTOCOL";
export const ENV_DASHBOARD_KEY = "PI_DADDY_DASHBOARD_KEY";
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
  dailyView?: DailyViewOptions;
  dailyReader?: ReturnType<typeof createDailyViewReader>;
  dailyJson?: boolean;
  debrief?: DebriefPresenter;
  debriefJson?: boolean;
  connected?: DashboardConnection;
  actionMenu?: ReturnType<typeof createDashboardMenu>;
}
export async function dashboardHostAction(host:DashboardConnection,line:string){
  if(!isDashboardConnection(host)||Buffer.byteLength(line)>60000)throw Error("genuine bounded dashboard connection required");
  const command=line.trim();
  if(command.startsWith("{"))return host.action(dashboardHostRequest(parseRetentionJson(command,60000) as DashboardHostRequest));
  if(!/^[a-zA-Z0-9:_-]{1,64}$/.test(command))throw Error("dashboard action must be a listed command key");
  return host.humanAction(command);
}

/** A fulfilled host call is not necessarily an applied native effect; keep those facts distinct in the UI. */
export function dashboardActionFeedback(command:string,outcome:unknown):string{
  const value=outcome&&typeof outcome==="object"?outcome as {state?:unknown;result?:unknown;error?:unknown;reason?:unknown}:{};
  const state=typeof value.state==="string"?value.state:"unrecognised host response";
  if(state==="failed-or-unknown"||state==="readback-only")return `NO ACTION CLAIM: ${command} returned ${state}; inspect/reconcile explicitly.`;
  if(state!=="acknowledged")return `NOT APPLIED: ${command} returned ${state}.${typeof (value.error??value.reason)==="string"?` ${String(value.error??value.reason).slice(0,1024)}`:""}`;
  const result=value.result&&typeof value.result==="object"?value.result as {application?:unknown}:null;
  // A retained records[] snapshot has no outer dashboard request correlation. Never select an old receipt.
  const nativeApplication=typeof result?.application==="string"?result.application:undefined;
  if(nativeApplication==="applied")return `ACKNOWLEDGED: ${command}; native application applied.`;
  if(nativeApplication)return `ACKNOWLEDGED: ${command}; native application ${nativeApplication}, so no applied effect is claimed.`;
  return `ACKNOWLEDGED: ${command}; refreshed state is shown below (no native application claim).`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function setupFrame(cwd: string): string {
  const ledger = resolve(cwd, ".pi", "grants.jsonl");
  return [
    "PI-DADDY",
    "",
    "pi-daddy is missing or its ledger is inactive in this workspace.",
    "Nothing was installed or configured automatically.",
    "",
    "Run exactly:",
    "  pi install npm:pi-daddy",
    `  export PI_GRANTS_LEDGER=${shellQuote(ledger)}`,
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

export async function dashboardFrame(options: DashboardFrameOptions): Promise<string> {
  if (options.protocol !== undefined && options.protocol !== DASHBOARD_PROTOCOL_VERSION) {
    return incompatibleFrame(options.protocol);
  }
  if(options.connected){
    if(!isDashboardConnection(options.connected))throw Error("original dashboard connection required");
    let view:Awaited<ReturnType<DashboardConnection["frame"]>>;
    try{view=await options.connected.frame();}catch(error){options.actionMenu?.clear();return panelLines(["PI-DADDY — Disconnected", "The original host is unavailable. No action was retried.", "Return to Pi: /grants host, then /grants dashboard.", ...(options.details?[String(error)]:[])],options.width);}
    if(options.dailyJson||options.debriefJson)return JSON.stringify(view);
    const source=view.source as {daily?:Parameters<typeof renderDailyView>[0]}|null;
    const actions=(view.actions as PanelAction[]|undefined)??[];
    const menu=(options.actionMenu??createDashboardMenu()).show(view.tip,actions);
    const learning=view.debrief?["Retained review open below"]:learningSummary(view.learning);
    const summary=source?.daily?renderDailyPanel(source.daily,options.width,{details:options.details,connected:true,presentation:view.presentation as WorkPresentation|null,error:view.error,controls:view.controls,control:view.control,actions:menu,learning}):panelLines(["PI-DADDY — Needs you","Work observation unavailable. Capture current work or open Details.",...menu.map(a=>`${a.choice}  ${a.label}`)],options.width);
    return [summary,view.debrief?renderDebrief(view.debrief as Parameters<typeof renderDebrief>[0],options.width):"",options.details?panelLines([`Host control ${view.control}; acknowledgement ${view.acknowledgement}. Attention reserved ${view.attention.attentionUsed}/5. Tip ${view.tip}.`,JSON.stringify(view.controls),JSON.stringify(view.learning),...actions.map(a=>`${a.key} — ${a.label}`)],options.width):""].filter(Boolean).join("\n\n");
  }
  if (options.debrief || options.debriefJson) {
    if (!isDebriefPresenter(options.debrief)) return "PI-DADDY — DEBRIEF UNAVAILABLE: genuine presenter/host missing";
    const view = options.debrief.view(); return options.debriefJson ? JSON.stringify(view) : renderDebrief(view, options.width);
  }
  if (options.dailyView) {
    try {
      if (options.dailyReader !== undefined && !isDailyViewReader(options.dailyReader)) throw new TypeError("untrusted daily reader callback");
      const view = await (options.dailyReader ?? readDailyView)(options.dailyView);
      return options.dailyJson ? JSON.stringify(view) : renderDailyPanel(view, options.width, { details: options.details });
    } catch {
      return "PI-DADDY — DAILY VIEW UNAVAILABLE\nInvalid or unavailable read-only input. No previous acceptance or continuity was substituted.";
    }
  }
  // Timeline is the default local activity surface. Retain the existing setup frame until a real
  // extension-owned timeline exists, so opening a plugin before Pi has run remains explanatory.
  const configuredPath = options.ledgerPath ?? defaultActivityTimelinePath(options.cwd);
  if (!options.ledgerPath) {
    try {
      const activityPath = resolve(options.cwd, configuredPath);
      const activity = await readFile(activityPath, "utf8");
      const timeline = parseActivityTimeline(activity);
      let content: { taskKey: string; field: "prompt" | "final"; text: string } | undefined;
      if (options.activityDetail) try { const taskKey = resolveActivityTaskSelector(timeline, options.activityDetail.taskKey, options.activityAliases); if (!taskKey) throw Error("TIMELINE_DETAIL_INVALID"); content = await detailForTimeline(activityPath, taskKey, options.activityDetail.field); } catch (error) { return `PI-DADDY — ACTIVITY DETAIL UNAVAILABLE\n${error instanceof Error ? error.message : String(error)}`; }
      return renderActivityTimeline(timeline, { details: options.details, history: options.history, filter: options.filter, color: options.color, width: options.width, aliases: options.activityAliases, content });
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

  let timeline: string | undefined;
  if (text.trimStart().startsWith('{"version":1')) {
    const activity = parseActivityTimeline(text);
    let content: { taskKey: string; field: "prompt" | "final"; text: string } | undefined;
    if (options.activityDetail) try { const taskKey = resolveActivityTaskSelector(activity, options.activityDetail.taskKey, options.activityAliases); if (!taskKey) throw Error("TIMELINE_DETAIL_INVALID"); content = await detailForTimeline(ledgerPath, taskKey, options.activityDetail.field); } catch (error) { return `PI-DADDY — ACTIVITY DETAIL UNAVAILABLE\n${error instanceof Error ? error.message : String(error)}`; }
    timeline = renderActivityTimeline(activity, { details: options.details, history: options.history, filter: options.filter, color: options.color, width: options.width, aliases: options.activityAliases, content });
  }
  const rendered = timeline ?? renderDashboard(parseDashboardLedger(text, { now: options.now }), {
    color: options.color,
    width: options.width,
    details: options.details,
    history: options.history,
  });
  return waiting ? `${rendered}\n\nwaiting for ledger ${ledgerPath}` : rendered;
}

interface CliOptions {
  once: boolean;
  details: boolean;
  color: boolean;
  ledgerPath?: string;
  archivePath?: string;
  workPath?: string;
  selection?: string;
  dailyJson: boolean;
  debriefFixture: boolean;
  debriefJson: boolean;
  hostSocket?: string;
}

function parseArgs(argv: string[]): CliOptions {
  let once = false;
  let details = false;
  let color = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
  let ledgerPath: string | undefined, archivePath: string | undefined, workPath: string | undefined, selection: string | undefined;
  let dailyJson = false, debriefFixture = false, debriefJson = false;let hostSocket:string|undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--once") once = true;
    else if (arg === "--details") details = true;
    else if (arg === "--no-color") color = false;
    else if (arg === "--ledger") ledgerPath = argv[++index];
    else if (arg === "--daily-json") dailyJson = true;
    else if (arg === "--debrief-fixture") debriefFixture = true;
    else if (arg === "--debrief-json") debriefJson = true;
    else if(arg === "--host-socket"){hostSocket=argv[++index];if(!hostSocket||hostSocket.startsWith("--"))throw Error("explicit host socket required");}
    else if (["--archive-projection", "--work-ledger", "--work-snapshot"].includes(arg)) {
      const value = argv[++index]; if (!value || value.startsWith("--")) throw new Error("missing daily view argument");
      if (arg === "--archive-projection") archivePath = value;
      else if (arg === "--work-ledger") workPath = value;
      else selection = value;
    }
    else throw new Error(`unknown dashboard argument ${JSON.stringify(arg)}`);
  }
  return { once, details, color, ledgerPath, archivePath, workPath, selection, dailyJson, debriefFixture, debriefJson, hostSocket };
}

export async function runDashboard(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, host: { debrief?: DebriefPresenter; connected?:DashboardConnection } = {}): Promise<void> {
  const cli = parseArgs(argv);
  const cwd = process.cwd();
  const ledgerPath = cli.ledgerPath ?? (env[ENV_DASHBOARD_LEDGER]?.trim() || undefined);
  const rawProtocol = env[ENV_DASHBOARD_PROTOCOL]?.trim();
  const protocol = rawProtocol === undefined || rawProtocol === "" ? undefined : Number(rawProtocol);
  const key = env[ENV_DASHBOARD_KEY]?.trim();
  process.title = `pi-daddy-dashboard${key ? `:${key.slice(0, 12)}` : ""}`;

  const archivePath = cli.archivePath ?? env[ENV_DAILY_ARCHIVE];
  const workPath = cli.workPath ?? env[ENV_DAILY_WORK];
  const selectedSnapshot = dailySelection(cli.selection ?? env[ENV_DAILY_SELECTION]);
  const dailyView = archivePath || workPath || selectedSnapshot || cli.dailyJson ? {
    archiveProjectionPath: archivePath ? resolve(cwd, archivePath) : undefined,
    workLedgerPath: workPath ? resolve(cwd, workPath) : undefined,
    workContext: { selectedSnapshot, authority: null },
  } : undefined;
  const socket=cli.hostSocket??env[ENV_DASHBOARD_HOST_SOCKET];const connected=host.connected??(socket?connectDashboardHost(socket):undefined);
  if(connected&&(host.debrief||cli.debriefFixture||env[ENV_DEBRIEF_FIXTURE]==="1"))throw Error("connected host and separate debrief are exclusive");
  const debrief = host.debrief ?? (cli.debriefFixture || env[ENV_DEBRIEF_FIXTURE] === "1" ? await createFixtureDebrief() : undefined);
  if (debrief) {
    if (!isDebriefPresenter(debrief)) throw new Error("invalid debrief presenter");
    if (!host.debrief) await debrief.open({ mode: "manual", userPresent: true }); // Explicit CLI fixture only; never override a host deferral.
  }
  const dailyReader = createDailyViewReader();
  const actionMenu=createDashboardMenu();
  const display = createDashboardDisplayControls(cli.details, Boolean(!connected && !debrief && !cli.debriefJson && !dailyView));
  let previous = "";
  let feedback = "";
  let input: ReturnType<typeof createInterface> | null = null;
  const draw = async (clear: boolean): Promise<void> => {
    const frame = await dashboardFrame({
      cwd,
      ledgerPath,
      protocol,
      color: cli.color,
      width: process.stdout.columns || 80,
      ...display.state, activityAliases: display.aliases, actionMenu,
      dailyView, dailyReader, dailyJson: cli.dailyJson, debrief, debriefJson: cli.debriefJson, connected,
    });
    const rendered = feedback ? `${panelLines([feedback], process.stdout.columns || 80)}\n\n${frame}` : frame;
    if (rendered === previous && !clear) return;
    previous = rendered;
    const prompt = display.prompt();
    const draft = input?.line ?? "";
    process.stdout.write(clear ? `\u001b]0;PI-DADDY\u0007\u001b[2J\u001b[H${rendered}\n\n${input ? prompt + draft : ""}` : `${rendered}\n`);
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
    void draw(true).finally(() => { drawing = false; });
  };
  let acting = false;
  input?.on("line", line => {
    if (acting) return; // never replay a line typed while the prior exact command is still settling.
    if (display.input(line)) { redraw(); return; }
    acting = true;
    let label=line.trim()||"(empty)";
    const act=async()=>{
      if(connected&&/^\d+$/.test(line.trim())){const selected=actionMenu.select(line.trim());label=selected.label;return connected.humanAction(selected.key,{tip:selected.tip,requestDigest:selected.requestDigest});}
      if(connected)return dashboardHostAction(connected,line);
      if(debrief)return debriefAction(debrief,line);
      throw Error("Read-only snapshot; no controls connected");
    };
    feedback = `Action ${label} — awaiting acknowledgement…`;
    void act().then(outcome => {
      feedback = connected ? dashboardActionFeedback(label, outcome) : `ACKNOWLEDGED: ${label}. Refreshed state is shown below.`;
    }).catch(error => {
      feedback = `REJECTED: ${error instanceof Error ? error.message : String(error)}. No command was retried; inspect the refreshed offered keys.`;
    }).finally(() => { acting = false; redraw(); });
  });
  const timer = setInterval(redraw, DASHBOARD_REFRESH_MS);
  process.on("SIGWINCH", redraw);
  await new Promise<void>((settle) => {
    const stop = () => {
      clearInterval(timer); input?.close();
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
