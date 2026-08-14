/**
 * Run a governed child process under hard limits.
 *
 * G8 (review findings A-R1/B-I5, A-R3). `delegate` used to spawn `pi` with no output cap, no timeout,
 * an abort listener attached too late to observe an already-aborted signal, and a non-zero exit reported
 * to the model as an ordinary result. Each of those is a way for a child to outlive or overwhelm the
 * orchestrator that is supposed to be governing it — which is the whole premise of this package.
 *
 * It lives here, out of `extensions/grants.ts`, so it can be tested against real processes without pi.
 */

import { spawn } from "node:child_process";
import { parseBound } from "./propagation.ts";

/**
 * Operator override for the child wall-clock limit, in seconds.
 *
 * Deliberately NOT in `GRANT_ENV_KEYS`: those are stripped from a child's environment and re-supplied
 * only by the spawn plan, which is right for capability state and wrong for an operator preference. This
 * one should simply inherit, so a bound set at the root applies all the way down.
 */
export const ENV_CHILD_TIMEOUT = "PI_GRANTS_CHILD_TIMEOUT";

/** Read the override, falling back to the default on absent *or* malformed input (G7's rule). */
export function timeoutFromEnv(raw: string | undefined): number {
  const seconds = parseBound(raw);
  // `null` (malformed) and `0` both fall back rather than disabling the limit: a timeout that can be
  // switched off by a typo is the A-S4 defect wearing different clothes.
  return seconds === undefined || seconds === null || seconds === 0 ? DEFAULT_TIMEOUT_MS : seconds * 1000;
}

export interface ChildRunRequest {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal?: AbortSignal;
  /** Hard cap on captured output. Beyond it the child is killed and the result flagged. */
  maxOutputBytes?: number;
  /** Wall-clock cap. On expiry: SIGTERM, then SIGKILL after `killGraceMs`. */
  timeoutMs?: number;
  killGraceMs?: number;
}

export interface ChildRunResult {
  /** Exit code, or `null` when nothing was spawned or the child was killed by a signal. */
  code: number | null;
  text: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process could not be started at all. */
  spawnError?: string;
}

/** 1 MiB. A delegation returns a summary; anything larger is a runaway, not an answer. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** 10 minutes. Long enough for a real sub-agent task, short enough that a hang is not forever. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** Grace between SIGTERM and SIGKILL. A child that ignores SIGTERM must not make the timeout advisory. */
export const DEFAULT_KILL_GRACE_MS = 5000;

export function runChild(request: ChildRunRequest): Promise<ChildRunResult> {
  const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = request.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  // A-R3: checked BEFORE spawning. `AbortSignal` does not replay, so a listener attached after an
  // `await` cannot observe an abort that already happened — and the child would then run to completion
  // outside the cancellation that was supposed to stop it. Nothing is started at all here.
  if (request.signal?.aborted) {
    return Promise.resolve({ code: null, text: "", truncated: false, timedOut: false, aborted: true });
  }

  return new Promise<ChildRunResult>((settle) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.command, request.args, {
        env: request.env,
        cwd: request.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle({ code: null, text: "", truncated: false, timedOut: false, aborted: false, spawnError: String(error) });
      return;
    }

    let text = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let done = false;

    const timers: NodeJS.Timeout[] = [];
    const clearTimers = () => timers.forEach(clearTimeout);

    /** SIGTERM, then SIGKILL if the child is still alive — so a handler cannot ignore its way out. */
    const stop = () => {
      child.kill("SIGTERM");
      timers.push(setTimeout(() => child.kill("SIGKILL"), killGraceMs));
    };

    const capture = (chunk: unknown) => {
      if (truncated) return;
      const s = String(chunk);
      bytes += Buffer.byteLength(s);
      if (bytes > maxOutputBytes) {
        // Keep what fits, mark it, and stop the child: an unbounded producer must not be able to
        // exhaust the orchestrator's memory just because it was granted a tool that prints.
        text += s;
        text = text.slice(0, maxOutputBytes);
        truncated = true;
        stop();
        return;
      }
      text += s;
    };

    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs),
    );

    const onAbort = () => {
      aborted = true;
      stop();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result: ChildRunResult) => {
      if (done) return;
      done = true;
      clearTimers();
      request.signal?.removeEventListener("abort", onAbort);
      settle(result);
    };

    child.on("error", (error) =>
      finish({ code: null, text, truncated, timedOut, aborted, spawnError: String(error) }),
    );
    child.on("close", (code) => finish({ code, text, truncated, timedOut, aborted }));
  });
}
