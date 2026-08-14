/**
 * Integration harness — drives a REAL `pi` process with this extension loaded.
 *
 * G11. `extensions/grants.ts` is the one file with no unit coverage, and three reviewers converged on
 * that independently. It is also where the wiring bugs live: every defect found by the live probes so far
 * (`approval-ux`, `adr-0011-universal`, `g1-argv`, `g5-bash-escape`) was in the extension, not in `src/`.
 * Four probes now hand-drive the same `drive.mjs` script, which is well past the point where it should be
 * a suite.
 *
 * **Why rpc mode.** `ctx.ui.notify` and `ctx.ui.select` are invisible through `--print` (print mode
 * installs a no-op UI context). Under `pi --mode rpc` every `ctx.ui.*` call is emitted on stdout as an
 * `extension_ui_request` JSON line, and a `select` blocks until an `extension_ui_response` is written back
 * on stdin — the same extension-facing call the TUI dialog serves. It does NOT exercise TUI rendering.
 *
 * **Two tiers, deliberately.** `runCommand` drives a slash command and costs no model tokens, so it is
 * deterministic and fast; most assertions here should use it. `runPrompt` needs a model to decide to call
 * a tool, so it is slower, costs money, and can vary — those tests are opt-in via `PI_GRANTS_IT_MODEL=1`.
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../test/tmp.ts";

// Re-exported so an `.it.ts` file registers teardown from the harness it already imports:
// `after(cleanupTempDirs)`. `PI_GRANTS_KEEP_TMP=1` keeps every fixture for inspection after a failure.
export { cleanupTempDirs, tempDir } from "../test/tmp.ts";

export const EXTENSION = resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "grants.ts");

export interface Notify {
  type: string;
  message: string;
}

export interface Select {
  title: string;
  options: string[];
}

export interface RunResult {
  notifies: Notify[];
  selects: Select[];
  /** `message_end` events with role `toolResult`, as pi emitted them. */
  toolResults: Record<string, unknown>[];
  /** Tool calls the model made, by name. */
  toolCalls: { name: string; arguments: unknown }[];
  exitCode: number | null;
  timedOut: boolean;
  /** Every raw line, for diagnosing a test that fails for an unexpected reason. */
  raw: string[];
}

export interface RunOptions {
  cwd: string;
  message: string;
  env?: Record<string, string>;
  /** Answers for successive `select` dialogs. The last is reused if more arrive. */
  answers?: string[];
  /** Cancel every dialog instead of answering. */
  cancel?: boolean;
  timeoutMs?: number;
  /** Load the extension. Off for control runs that need pi WITHOUT governance. */
  extension?: boolean;
  /**
   * End the run this long after the last `notify`, rather than waiting for `agent_settled`.
   *
   * A slash-command handler runs to completion and then the agent has nothing to do, so `agent_settled`
   * never arrives and the run would otherwise burn its whole timeout. Settling on quiet turns a 15s
   * command test into roughly 1s, which is the difference between a suite anyone runs and one nobody does.
   */
  settleAfterQuietMs?: number;
}

/** Is `pi` on PATH? Integration tests skip rather than fail when it is not. */
export function piAvailable(): boolean {
  try {
    execFileSync("pi", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** True when model-driven tests are enabled. They cost money and are non-deterministic. */
export const modelTestsEnabled = process.env.PI_GRANTS_IT_MODEL === "1";

export function runPi(options: RunOptions): Promise<RunResult> {
  const args = ["--no-session", "--no-extensions"];
  if (options.extension !== false) args.push("-e", EXTENSION);
  args.push("--mode", "rpc");

  return new Promise<RunResult>((settle) => {
    const child = spawn("pi", args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // The harness must control governance entirely: a stray PI_GRANTS_* in the developer's own shell
      // would silently change what is under test, and the failure would look like a code defect.
      env: sanitisedEnv(options.env),
    });

    const result: RunResult = {
      notifies: [],
      selects: [],
      toolResults: [],
      toolCalls: [],
      exitCode: null,
      timedOut: false,
      raw: [],
    };

    let answerIndex = 0;
    let buffer = "";
    let done = false;
    let quietTimer: NodeJS.Timeout | undefined;

    /** Restart the quiet clock; the run ends when it expires with no further output. */
    const nudgeQuiet = () => {
      if (!options.settleAfterQuietMs) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(false), options.settleAfterQuietMs);
    };

    const finish = (timedOut: boolean) => {
      if (done) return;
      done = true;
      result.timedOut = timedOut;
      clearTimeout(timer);
      clearTimeout(quietTimer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      // A short grace so pi can flush before the test reads the result.
      setTimeout(() => settle(result), 150);
    };

    const timer = setTimeout(() => finish(true), options.timeoutMs ?? 60_000);

    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        result.raw.push(line);

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (event.type === "extension_ui_request" && event.method === "notify") {
          result.notifies.push({ type: String(event.notifyType ?? "info"), message: String(event.message) });
          nudgeQuiet();
        } else if (event.type === "extension_ui_request" && event.method === "select") {
          result.selects.push({
            title: String(event.title ?? ""),
            options: (event.options as string[]) ?? [],
          });
          const response = options.cancel
            ? { type: "extension_ui_response", id: event.id, cancelled: true }
            : {
                type: "extension_ui_response",
                id: event.id,
                value: options.answers?.[answerIndex++] ?? options.answers?.at(-1) ?? "Deny",
              };
          child.stdin.write(`${JSON.stringify(response)}\n`);
        } else if (event.type === "message_end") {
          const message = event.message as { role?: string; content?: { type: string; name?: string; arguments?: unknown }[] };
          if (message?.role === "toolResult") result.toolResults.push(message as Record<string, unknown>);
          if (message?.role === "assistant") {
            for (const part of message.content ?? []) {
              if (part.type === "toolCall") result.toolCalls.push({ name: String(part.name), arguments: part.arguments });
            }
          }
        } else if (event.type === "agent_settled") {
          finish(false);
        }
      }
    });

    child.on("error", () => finish(false));
    child.on("close", (code) => {
      result.exitCode = code;
      finish(false);
    });

    child.stdin.write(`${JSON.stringify({ type: "prompt", id: "1", message: options.message })}\n`);
  });
}

/**
 * Drive a slash command. **No model tokens**, so this is the tier to prefer.
 *
 * A command handler runs to completion and then the agent has nothing to do, so `agent_settled` may never
 * arrive — the run ends on the timeout instead. That is why the default here is short.
 */
export async function runCommand(options: Omit<RunOptions, "message"> & { command: string }): Promise<RunResult> {
  return runPi({
    ...options,
    message: options.command,
    timeoutMs: options.timeoutMs ?? 20_000,
    // A command emits its notifies and stops. 1.2s of silence after the last one means it is done; the
    // timeout above stays as the backstop for a run that produces nothing at all.
    settleAfterQuietMs: options.settleAfterQuietMs ?? 1200,
  });
}

/** Drive a real prompt, which needs a model to decide to call a tool. Opt-in; see `modelTestsEnabled`. */
export async function runPrompt(options: RunOptions): Promise<RunResult> {
  return runPi({ ...options, timeoutMs: options.timeoutMs ?? 150_000 });
}

/**
 * Every `PI_GRANTS_*` variable removed, then the test's own applied.
 *
 * Without this the developer's shell leaks in: a `PI_GRANTS_GRANT` exported for manual testing would make
 * an "ungoverned session" test silently govern, and the failure would read as a bug in `childEnv`.
 */
function sanitisedEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("PI_GRANTS_")) env[key] = value;
  }
  return { ...env, ...overrides };
}

/**
 * A throwaway project with `SKILL.md` definitions on disk, outside the repo.
 *
 * ADR-0016 moved definitions from `.pi/agents/<name>.md` (pi-subagents' layout) to
 * `.pi/skills/<name>/SKILL.md` (the Agent Skills standard), so this writes the latter. Each key is the
 * DIRECTORY name, which is also the definition's identity — the spec requires `name` to match it, and
 * this package reads identity from the path rather than the frontmatter for exactly that reason.
 */
export async function fixture(definitions: Record<string, string> = {}): Promise<string> {
  const dir = await tempDir("grants-it-");
  for (const [name, content] of Object.entries(definitions)) {
    await mkdir(join(dir, ".pi", "skills", name), { recursive: true });
    await writeFile(join(dir, ".pi", "skills", name, "SKILL.md"), content, "utf8");
  }
  return dir;
}

/** The `/grants` verdict line for one agent type, e.g. `BLOCK  docs-writer — …`. */
export function verdictFor(result: RunResult, typeName: string): string | undefined {
  for (const notify of result.notifies) {
    for (const line of notify.message.split("\n")) {
      if (line.trim().startsWith("allow ") || line.trim().startsWith("BLOCK ")) {
        const trimmed = line.trim();
        if (trimmed.slice(6).trim().startsWith(typeName)) return trimmed;
      }
    }
  }
  return undefined;
}
