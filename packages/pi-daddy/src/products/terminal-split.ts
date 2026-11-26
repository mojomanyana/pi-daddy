/**
 * Cross-OS terminal split planner & launcher for `/dashboard split` and `pi-daddy doctor`
 * (Layer 3: products). Supports tmux, WezTerm, Kitty, Ghostty, macOS iTerm2, and Windows Terminal.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export type TerminalSplitKind = "tmux" | "wezterm" | "kitty" | "ghostty" | "iterm2" | "wt";

export interface TerminalSplitPlan {
  readonly kind: TerminalSplitKind;
  readonly command: string;
  readonly args: string[];
  readonly windowsHide?: boolean;
  readonly waitForExit?: boolean;
}

export interface TerminalSplitResult {
  readonly ok: boolean;
  readonly kind?: TerminalSplitKind;
  readonly error?: string;
}

function panelArgs(url?: string): string[] {
  // Packaged extensions are loaded from source, alongside their built CLI.
  const entry = new URL("../../dist/cli.js", import.meta.url);
  return [process.execPath, fileURLToPath(entry), "panel", ...(url ? [url] : [])];
}

export function formatPanelCommand(url?: string, platform: NodeJS.Platform = process.platform): string {
  const args = panelArgs(url);
  if (platform === "win32") {
    return "& " + args.map(quotePowerShell).join(" ");
  }
  return args.map((arg) => "'" + arg.replace(/'/g, "'\\''") + "'").join(" ");
}

function quotePowerShell(arg: string): string {
  return "'" + arg.replace(/'/g, "''") + "'";
}

export function planTerminalSplit(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TerminalSplitPlan | undefined {
  const panel = panelArgs(url);
  if (env.TMUX) {
    return { kind: "tmux", command: "tmux", args: ["split-window", "-h", "-l", "48", ...panel] };
  }
  if (env.WEZTERM_PANE) {
    return {
      kind: "wezterm",
      command: "wezterm",
      args: ["cli", "split-pane", "--right", "--percent", "38", "--", ...panel],
    };
  }
  if (env.KITTY_WINDOW_ID || env.KITTY_LISTEN_ON) {
    const toArgs = env.KITTY_LISTEN_ON ? ["--to", env.KITTY_LISTEN_ON] : [];
    return {
      kind: "kitty",
      command: "kitty",
      args: ["@", ...toArgs, "launch", "--type=window", "--location=vsplit", "--cwd=current", ...panel],
    };
  }
  if (platform === "darwin" && env.TERM_PROGRAM === "iTerm.app") {
    const script = [
      'tell application "iTerm2"',
      "  tell current session of current window",
      `    split vertically with default profile command ${JSON.stringify(formatPanelCommand(url, platform))}`,
      "  end tell",
      "end tell",
    ].join("\n");
    return { kind: "iterm2", command: "osascript", args: ["-e", script] };
  }
  if (env.TERM_PROGRAM === "ghostty" || env.GHOSTTY_RESOURCES_DIR) {
    if (platform === "darwin") {
      return {
        kind: "ghostty",
        command: "open",
        args: ["-na", "Ghostty", "--args", "-e", ...panel],
      };
    }
    return { kind: "ghostty", command: "ghostty", args: ["-e", ...panel] };
  }
  if (platform === "win32" && env.WT_SESSION) {
    return {
      kind: "wt",
      command: "wt",
      args: ["-w", "0", "sp", "-V", "-s", "0.38", ...panel],
      windowsHide: true,
    };
  }
  if (platform === "linux" && env.WT_SESSION && env.WSL_DISTRO_NAME) {
    // WSL cannot execute Windows app aliases directly. Windows PowerShell resolves wt.exe on the host.
    const args = [
      "-w",
      "0",
      "sp",
      "-V",
      "-s",
      "0.38",
      "wsl.exe",
      "--distribution",
      env.WSL_DISTRO_NAME,
      "--exec",
      ...panel,
    ];
    const data = Buffer.from(JSON.stringify({ argv: args }), "utf8").toString("base64");
    const command =
      "$ErrorActionPreference = 'Stop'; " +
      `$terminalArgs = (ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')))).argv; ` +
      "& wt.exe @terminalArgs; exit $LASTEXITCODE";
    return {
      kind: "wt",
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
      waitForExit: true,
    };
  }
  return undefined;
}

/**
 * Launch the planned terminal split safely. Attaches an async `'error'` listener before returning
 * so missing binaries (`ENOENT`) or immediate non-zero launch failures never crash the Pi host.
 */
export function openTerminalSplit(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  settleWindowMs = 200,
): Promise<TerminalSplitResult> {
  const plan = planTerminalSplit(url, env, platform);
  if (!plan) return Promise.resolve({ ok: false });

  return new Promise<TerminalSplitResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: TerminalSplitResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(plan.command, plan.args, {
        detached: true,
        stdio: "ignore",
        env,
        ...(plan.windowsHide ? { windowsHide: true } : {}),
      });
    } catch (error) {
      finish({ ok: false, kind: plan.kind, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    child.once("error", (error) => {
      finish({ ok: false, kind: plan.kind, error: error instanceof Error ? error.message : String(error) });
    });

    child.once("exit", (code, signal) => {
      if (code === 0) finish({ ok: true, kind: plan.kind });
      else finish({ ok: false, kind: plan.kind, error: `${plan.command} exited (${signal ?? code ?? "unknown"})` });
    });

    child.once("spawn", () => {
      if (plan.waitForExit) {
        timer = setTimeout(() => {
          child.kill();
          finish({ ok: false, kind: plan.kind, error: "Windows Terminal launch timed out" });
        }, 5000);
        return;
      }
      child.unref();
      timer = setTimeout(() => finish({ ok: true, kind: plan.kind }), settleWindowMs);
      timer.unref?.();
    });
  });
}

export function detectSupportedSplitters(
  probe: (cmd: string, args: string[]) => boolean,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const splitters: string[] = [];
  if (env.TMUX || probe("tmux", ["-V"])) splitters.push("tmux");
  if (env.WEZTERM_PANE || probe("wezterm", ["--version"])) splitters.push("wezterm");
  if (env.KITTY_WINDOW_ID || env.KITTY_LISTEN_ON || probe("kitty", ["--version"])) splitters.push("kitty");
  if (env.TERM_PROGRAM === "ghostty" || env.GHOSTTY_RESOURCES_DIR || probe("ghostty", ["--version"])) {
    splitters.push("ghostty");
  }
  if (platform === "darwin") splitters.push("iTerm2 (osascript)");
  if (platform === "win32" && probe("where", ["wt"])) splitters.push("Windows Terminal (wt)");
  if (platform === "linux" && env.WSL_DISTRO_NAME && probe("where.exe", ["wt.exe"])) {
    splitters.push("Windows Terminal (WSL)");
  }
  return splitters;
}
