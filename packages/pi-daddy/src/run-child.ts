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
import { StringDecoder } from "node:string_decoder";
import { parseBound } from "./propagation.ts";

/**
 * The longest prefix of `text` that fits in `budget` BYTES, never splitting a character.
 *
 * Both halves matter. Truncating by `String.prototype.slice` counts UTF-16 code units against a byte budget,
 * which overruns by the encoding width of whatever the child printed. Truncating the *buffer* instead would
 * respect the budget and split a multi-byte character or a surrogate pair, putting a lone `\ud83d` in the
 * result. So the walk is by code POINT (`for…of` iterates code points, keeping surrogate pairs whole) and the
 * budget is checked in bytes before each one is admitted.
 *
 * Exported for the test that feeds it CJK and emoji: an ASCII-only test cannot fail on any of this, which is
 * exactly why the original defect survived a test named for it.
 */
export function takeBytes(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (Buffer.byteLength(text) <= budget) return text;
  let out = "";
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > budget) break;
    out += character;
    used += size;
  }
  return out;
}

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
  /**
   * Called with each chunk as it arrives, for the parent's progress display (ADR-0032).
   *
   * **Display only, and the distinction is load-bearing.** The child's answer is still `text`, assembled here
   * and returned; a caller must never treat what it saw streamed as the result. A partial stream that could be
   * mistaken for a complete answer is R-03's defect — a missing result indistinguishable from an empty one —
   * with a new cause.
   *
   * Bounded by the same `maxOutputBytes` as `text`, so the cap governs the transcript and not merely memory.
   *
   * Exceptions are swallowed: a renderer is not a governance control, and one that throws must not kill a
   * governed child mid-task.
   */
  onOutput?: (chunk: string) => void;
  /** Security hook called immediately after spawn, before output handling (for lease attachment). */
  onSpawn?: (pid: number) => void;
}

export interface ChildRunResult {
  /** Exit code, or `null` when nothing was spawned or the child was killed by a signal. */
  code: number | null;
  text: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** Signal that ended the process, separate from the nullable numeric exit code. */
  signal?: NodeJS.Signals | null;
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
    try {
      if (child.pid !== undefined) request.onSpawn?.(child.pid);
    } catch (error) {
      const failed = { code: null, text: "", truncated: false, timedOut: false, aborted: false, spawnError: String(error) };
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.once("error", () => settle(failed));
      child.once("close", () => settle(failed));
      child.kill("SIGKILL");
      return;
    }

    // One decoder for BOTH streams is deliberate: they are already interleaved into one `text`, and two
    // decoders would each hold their own partial character, so a split byte could surface out of order.
    const decoder = new StringDecoder("utf8");
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

    /** How much of `text` the progress display has already been shown. */
    let emittedUpTo = 0;

    /**
     * Stream whatever `text` has gained since the last call.
     *
     * **Derived from `text` rather than from the incoming chunk**, and that is the whole correctness argument:
     * what gets streamed is then *by construction* a prefix of what gets returned, so the output cap bounds the
     * parent's transcript exactly as it bounds the result. The first version emitted the raw chunk and pushed
     * 1924 bytes through a 1024-byte cap on the truncating write — the cap bounded memory and not the screen
     * it had just been extended to protect. Found by the test, not by reading it.
     *
     * Swallowing is deliberate: `onOutput` renders, and a renderer that throws must not become a way to kill a
     * governed child. Nothing downstream depends on it having run.
     */
    const flush = () => {
      if (!request.onOutput || text.length <= emittedUpTo) return;
      const chunk = text.slice(emittedUpTo);
      emittedUpTo = text.length;
      try {
        request.onOutput(chunk);
      } catch {
        /* display only */
      }
    };

    const capture = (chunk: unknown) => {
      if (truncated) return;
      // **Decoded through a StringDecoder, not `String(chunk)`.** A pipe splits on byte boundaries, not
      // character ones, so a multi-byte character straddling two `data` events was decoded as two invalid
      // halves and became U+FFFD — in the child's ANSWER, not merely the display. Measured: 300,000 bytes of
      // CJK produced **twelve** replacement characters, because 65536 % 3 == 1. Emoji happened to survive
      // (65536 % 4 == 0), which is why width-dependent corruption went unnoticed. The decoder holds the
      // partial bytes until the rest arrives.
      const s = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      if (s.length === 0) return;

      const size = Buffer.byteLength(s);
      if (bytes + size > maxOutputBytes) {
        // Keep what fits, mark it, and stop the child: an unbounded producer must not be able to exhaust the
        // orchestrator's memory just because it was granted a tool that prints.
        //
        // **Trimmed by BYTES, and that is a fix rather than a refinement.** This was
        // `text.slice(0, maxOutputBytes)` — a count of UTF-16 code units against a budget measured in bytes,
        // so any non-ASCII output overran the cap by its own encoding width: 300 bytes of CJK through a
        // 100-byte cap, and a measured **2048 bytes through the real 1024 default**. It is the same defect as
        // the 1924-byte one already fixed here, one layer down: that fix bounded the *unit* count, and the
        // budget was never in units. An odd cap also split a surrogate pair, putting a lone `\ud83d` into
        // both the transcript and the returned answer.
        text += takeBytes(s, maxOutputBytes - bytes);
        bytes = maxOutputBytes;
        truncated = true;
        flush();
        stop();
        return;
      }
      bytes += size;
      text += s;
      flush();
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
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(result);
    };

    child.on("error", (error) =>
      finish({ code: null, text, truncated, timedOut, aborted, spawnError: String(error) }),
    );
    // `close` waits for every inherited pipe, including one retained by a detached grandchild. Once the
    // governed PID exits, allow a short drain and settle anyway so timeout/output bounds remain bounds.
    child.on("exit", (code, signal) => {
      timers.push(setTimeout(() => finish({ code, signal, text, truncated, timedOut, aborted }), 100));
    });
    child.on("close", (code, signal) => finish({ code, signal, text, truncated, timedOut, aborted }));
  });
}
