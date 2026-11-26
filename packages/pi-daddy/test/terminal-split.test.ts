/** Unit tests for Bucket 2B & Issue #4: cross-OS terminal split planning & non-crashing failure handling. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GrantsSession } from "../extensions/session.ts";
import { registerWebDashboard } from "../extensions/web-dashboard.ts";
import {
  detectSupportedSplitters,
  formatPanelCommand,
  openTerminalSplit,
  planTerminalSplit,
} from "../src/products/terminal-split.ts";

const URL = "http://127.0.0.1:45123/?token=abc";
const cli = planTerminalSplit(URL, { TMUX: "1" })!.args[5];
const panel = [process.execPath, cli, "panel", URL];

test("terminal split runs the package CLI with the current Node even if PATH has no Daddy command", () => {
  assert.match(cli, /[\\/]pi-daddy[\\/]dist[\\/]cli\.js$/);
  assert.deepEqual(planTerminalSplit(URL, { PATH: "", TMUX: "1" }, "linux"), {
    kind: "tmux",
    command: "tmux",
    args: ["split-window", "-h", "-l", "48", ...panel],
  });
  assert.ok(formatPanelCommand(URL, "win32").startsWith("& "));
  assert.ok(formatPanelCommand(URL, "linux").includes(" 'panel' "));
});

test("planTerminalSplit selects Kitty vsplit with optional KITTY_LISTEN_ON socket", () => {
  const plain = planTerminalSplit(URL, { KITTY_WINDOW_ID: "42" }, "darwin");
  assert.deepEqual(plain, {
    kind: "kitty",
    command: "kitty",
    args: ["@", "launch", "--type=window", "--location=vsplit", "--cwd=current", ...panel],
  });

  const withSocket = planTerminalSplit(URL, { KITTY_WINDOW_ID: "42", KITTY_LISTEN_ON: "unix:/tmp/mykitty" }, "linux");
  assert.deepEqual(withSocket, {
    kind: "kitty",
    command: "kitty",
    args: ["@", "--to", "unix:/tmp/mykitty", "launch", "--type=window", "--location=vsplit", "--cwd=current", ...panel],
  });
});

test("planTerminalSplit supports Ghostty on macOS and Linux, while preferring tmux when nested", () => {
  assert.deepEqual(planTerminalSplit(URL, { TERM_PROGRAM: "ghostty" }, "darwin"), {
    kind: "ghostty",
    command: "open",
    args: ["-na", "Ghostty", "--args", "-e", ...panel],
  });
  assert.deepEqual(planTerminalSplit(URL, { GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty" }, "linux"), {
    kind: "ghostty",
    command: "ghostty",
    args: ["-e", ...panel],
  });
  assert.equal(
    planTerminalSplit(URL, { TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "ghostty" }, "darwin")?.kind,
    "tmux",
  );
});

test("planTerminalSplit covers WezTerm, macOS iTerm2, Windows Terminal, and returns undefined when unsupported", () => {
  assert.equal(planTerminalSplit(URL, { WEZTERM_PANE: "7" }, "darwin")?.kind, "wezterm");
  assert.equal(planTerminalSplit(URL, { TERM_PROGRAM: "iTerm.app" }, "darwin")?.kind, "iterm2");
  assert.deepEqual(planTerminalSplit(URL, { WT_SESSION: "guid-1" }, "win32"), {
    kind: "wt",
    command: "wt",
    args: ["-w", "0", "sp", "-V", "-s", "0.38", ...panel],
    windowsHide: true,
  });
  const wsl = planTerminalSplit(URL, { WT_SESSION: "guid-1", WSL_DISTRO_NAME: "Test Ubuntu" }, "linux")!;
  assert.equal(wsl.kind, "wt");
  assert.equal(wsl.command, "powershell.exe");
  assert.equal(wsl.waitForExit, true);
  assert.deepEqual(wsl.args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const script = Buffer.from(wsl.args.at(-1)!, "base64").toString("utf16le");
  assert.match(script, /& wt\.exe @terminalArgs; exit \$LASTEXITCODE/);
  const data = script.match(/FromBase64String\('([^']+)'\)/)![1];
  assert.deepEqual(JSON.parse(Buffer.from(data, "base64").toString("utf8")).argv, [
    "-w",
    "0",
    "sp",
    "-V",
    "-s",
    "0.38",
    "wsl.exe",
    "--distribution",
    "Test Ubuntu",
    "--exec",
    ...panel,
  ]);
  assert.equal(planTerminalSplit(URL, {}, "linux"), undefined);
});

test(
  "the Windows PowerShell bridge forwards a flat argv without evaluating it",
  { skip: process.platform !== "win32" },
  () => {
    const distro = "Test Ubuntu’s shell; $literal";
    const plan = planTerminalSplit(URL, { WT_SESSION: "fixture", WSL_DISTRO_NAME: distro }, "linux")!;
    const script = Buffer.from(plan.args.at(-1)!, "base64").toString("utf16le");
    const probe =
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
      "function wt.exe { ConvertTo-Json -Compress -InputObject @($args); $global:LASTEXITCODE = 0 }; ";
    const encoded = Buffer.from(probe + script, "utf16le").toString("base64");
    const systemRoot = process.env.SystemRoot ?? "C:/Windows";
    const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(powershell, [...plan.args.slice(0, -1), encoded], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [
      "-w",
      "0",
      "sp",
      "-V",
      "-s",
      "0.38",
      "wsl.exe",
      "--distribution",
      distro,
      "--exec",
      ...panel,
    ]);
  },
);

test("detectSupportedSplitters reports Kitty and Ghostty alongside tmux, WezTerm, iTerm2, and wt", () => {
  const found = detectSupportedSplitters((cmd) => cmd === "kitty" || cmd === "ghostty" || cmd === "tmux", {}, "darwin");
  assert.deepEqual(found, ["tmux", "kitty", "ghostty", "iTerm2 (osascript)"]);
});

test("Issue #4: Kitty session with no kitty executable on PATH does not crash Pi and /dashboard split shows URL fallback", async (t: TestContext) => {
  const emptyBin = mkdtempSync(join(tmpdir(), "pi-daddy-empty-path-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-daddy-split-agent-"));
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const k of ["PATH", "KITTY_WINDOW_ID", "KITTY_LISTEN_ON", "TMUX", "WEZTERM_PANE", "PI_CODING_AGENT_DIR"]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(emptyBin, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  // 1) Direct openTerminalSplit check with empty PATH and KITTY_WINDOW_ID set
  const direct = await openTerminalSplit(URL, { PATH: emptyBin, KITTY_WINDOW_ID: "42" }, "linux");
  assert.equal(direct.ok, false);
  assert.equal(direct.kind, "kitty");
  assert.ok(direct.error && direct.error.length > 0);

  // 2) Full /dashboard split command check: must survive and notify with fallback URL
  delete process.env.TMUX;
  delete process.env.WEZTERM_PANE;
  process.env.PATH = emptyBin;
  process.env.KITTY_WINDOW_ID = "42";
  process.env.PI_CODING_AGENT_DIR = agentDir;

  let dashboard!: Parameters<ExtensionAPI["registerCommand"]>[1];
  const notifications: string[] = [];
  const pi = {
    on() {},
    events: { on() {}, emit() {} },
    registerCommand(_name: string, cmd: typeof dashboard) {
      dashboard = cmd;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: agentDir,
    hasUI: true,
    ui: {
      notify(msg: string) {
        notifications.push(msg);
      },
      setStatus() {},
    },
  } as unknown as ExtensionCommandContext;

  registerWebDashboard(pi, {
    cwd: agentDir,
    depth: 0,
    episodeId: "ep-split",
    reloadLifecycle: {},
  } as unknown as GrantsSession);
  try {
    await dashboard.handler("split", ctx);
    assert.ok(notifications.length >= 1, "expected fallback notification");
    const last = notifications[notifications.length - 1];
    assert.match(last, /http:\/\/127\.0\.0\.1:\d+\/\?token=/, "must show existing dashboard URL fallback");
    assert.ok(last.includes(formatPanelCommand(last.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)![0])));
    assert.doesNotMatch(last, /Opened terminal side panel/, "must not claim split succeeded when kitty is missing");
    await dashboard.handler("open", ctx);
    assert.match(notifications.at(-1)!, /Browser: http:\/\/127\.0\.0\.1:/);
  } finally {
    await dashboard.handler("stop", ctx);
  }
});
