#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDashboardLedger } from "./dashboard-projection.ts";
import { renderDashboard } from "./dashboard-render.ts";

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
  now?: Date;
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
  if (!options.ledgerPath) return setupFrame(options.cwd);

  const ledgerPath = resolve(options.cwd, options.ledgerPath);
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

  const rendered = renderDashboard(parseDashboardLedger(text, { now: options.now }), {
    color: options.color,
    width: options.width,
    details: options.details,
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
  let color = process.stdout.isTTY;
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
  const cli = parseArgs(argv);
  const cwd = process.cwd();
  const ledgerPath = cli.ledgerPath ?? (env[ENV_DASHBOARD_LEDGER]?.trim() || undefined);
  const rawProtocol = env[ENV_DASHBOARD_PROTOCOL]?.trim();
  const protocol = rawProtocol === undefined || rawProtocol === "" ? undefined : Number(rawProtocol);
  const key = env[ENV_DASHBOARD_KEY]?.trim();
  process.title = `pi-daddy-dashboard${key ? `:${key.slice(0, 12)}` : ""}`;

  let previous = "";
  const draw = async (clear: boolean): Promise<void> => {
    const frame = await dashboardFrame({
      cwd,
      ledgerPath,
      protocol,
      color: cli.color,
      width: process.stdout.columns || 80,
      details: cli.details,
    });
    if (frame === previous && !clear) return;
    previous = frame;
    process.stdout.write(clear ? `\u001b]0;PI-DADDY\u0007\u001b[2J\u001b[H${frame}` : `${frame}\n`);
  };

  if (cli.once) {
    await draw(false);
    return;
  }
  await draw(true);
  let drawing = false;
  const redraw = (): void => {
    if (drawing) return;
    drawing = true;
    void draw(true).finally(() => { drawing = false; });
  };
  const timer = setInterval(redraw, DASHBOARD_REFRESH_MS);
  process.on("SIGWINCH", redraw);
  await new Promise<void>((settle) => {
    const stop = () => {
      clearInterval(timer);
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
