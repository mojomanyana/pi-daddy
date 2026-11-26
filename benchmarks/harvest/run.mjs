import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "--check";
if (!["--check", "--live"].includes(mode) || process.argv.length > 3) throw Error("Use --check or --live");
const file = join(mkdtempSync(join(tmpdir(), "pi-harvest-benchmark-")), "report.json");
const cli = process.env.DADDY_TEST_PI_CLI ? resolve(process.env.DADDY_TEST_PI_CLI) : undefined;
const extension = fileURLToPath(new URL("./probe.mjs", import.meta.url));
const windowsShim = !cli && process.platform === "win32";
const run = (args, options) =>
  spawnSync(cli ? process.execPath : "pi", cli ? [cli, ...args] : args, {
    encoding: "utf8",
    shell: !cli && process.platform === "win32",
    ...options,
  });
const version = run(["--version"], { timeout: 10000 });
if (version.status !== 0) throw Error("The Pi CLI is unavailable");
console.log("Pi " + version.stdout.trim() + ". Report: " + file);
const probe = run(
  [
    "--mode",
    "rpc",
    "--no-session",
    "--no-approve",
    "--no-extensions",
    "-e",
    windowsShim ? '"%PI_HARVEST_BENCH_EXTENSION%"' : extension,
  ],
  {
    timeout: 95 * 60000,
    env: {
      ...process.env,
      PI_HARVEST_BENCH_EXTENSION: extension,
      PI_HARVEST_BENCH_MODE: mode.slice(2),
      PI_HARVEST_BENCH_REPORT: file,
    },
  },
);
if (!existsSync(file))
  throw Error("Pi did not produce a benchmark report. Check the installed Pi version and profile.");
const report = JSON.parse(readFileSync(file, "utf8"));
report.piVersion = version.stdout.trim();
writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
const { rows, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
if (probe.status !== 0 || !["ready", "complete"].includes(report.status)) process.exitCode = 1;
