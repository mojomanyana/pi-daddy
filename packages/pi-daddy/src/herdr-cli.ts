/**
 * Talking to herdr: one command, one JSON envelope, plus the two questions ADR-0031 needs answered.
 *
 * Lifted out of `src/run-herdr.ts`, which was at 357 of the 400-line ceiling and gains output polling under
 * ADR-0032. But the split is not only about lines: **the probe is not an executor concern**. It runs at session
 * start, before any delegation exists, to decide *which* executor a session will use — so leaving it inside the
 * herdr executor would mean the session imported the thing it was deciding whether to use.
 *
 * Every rule here is tested against an injected `exec`, so the suite stays fast, pi-free and herdr-free. The
 * facts the fakes reproduce were measured against real herdr 0.7.5 (`docs/probes/g16-herdr`).
 */

import { execFile } from "node:child_process";

/** One herdr CLI invocation. Injectable so every rule below is testable without herdr installed. */
export type HerdrExec = (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const defaultExec: HerdrExec = (args) =>
  new Promise((settle) => {
    execFile("herdr", args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      settle({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/**
 * Parse herdr's JSON envelope. Every command replies `{id, result}` or `{id, error:{code,message}}`.
 *
 * `stderr` is folded into the message because the first end-to-end run failed with an EMPTY stdout and the
 * real reason on stderr, producing the useless diagnostic "unparseable herdr reply: ". A wrapper that
 * hides the substrate's own error message costs more time than it saves.
 */
export function parseReply(reply: { stdout: string; stderr: string }): { result?: Record<string, unknown>; error?: string } {
  try {
    const parsed = JSON.parse(reply.stdout) as { result?: Record<string, unknown>; error?: { message?: string; code?: string } };
    if (parsed.error) return { error: parsed.error.message ?? parsed.error.code ?? "herdr reported an error" };
    return { result: parsed.result };
  } catch {
    // A non-JSON reply is a herdr-version or PATH problem, not a governance decision. Surfaced as a spawn
    // error so the caller reports "could not start" rather than "the child produced nothing".
    const detail = [reply.stdout.trim(), reply.stderr.trim()].filter((t) => t.length > 0).join(" | ");
    return { error: `unparseable herdr reply: ${detail.slice(0, 300) || "(no output)"}` };
  }
}

/** Bound on the session-start probe. Short: it sits in front of the operator's first prompt. */
export const PROBE_TIMEOUT_MS = 2000;

export interface HerdrProbe {
  ok: boolean;
  /** herdr's own words when it is not reachable. Carried so the disclosure line can name the reason. */
  error?: string;
}

/**
 * Is there a herdr server that will answer right now? — ADR-0031's selection input.
 *
 * **`tab list`, not `which herdr`.** ADR-0031 rejects `PATH` detection as option C by name: a binary on `PATH`
 * with no server behind it would make every delegation fail at `tab create`, on a path the operator never
 * chose, and the diagnostic would arrive at the first delegation rather than at startup. Only a parsed
 * `result` envelope counts as reachable; an `error` envelope, a non-JSON reply, a timeout and a throwing
 * `exec` are all "not reachable" with the reason preserved.
 *
 * **Zero tabs is a successful answer**, deliberately: a fresh herdr with nothing open is reachable.
 *
 * Never throws. A probe that threw out of `session_start` would cancel every control after it, which is
 * R-60's shape exactly — and this one runs *before* the line that discloses what it decided.
 */
export async function probeHerdr(options: { exec?: HerdrExec; timeoutMs?: number } = {}): Promise<HerdrProbe> {
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<HerdrProbe>([
      exec(["tab", "list"]).then((reply) => {
        const parsed = parseReply(reply);
        return parsed.error ? { ok: false, error: parsed.error } : { ok: true };
      }),
      new Promise<HerdrProbe>((settle) => {
        timer = setTimeout(() => settle({ ok: false, error: `probe timed out after ${timeoutMs}ms` }), timeoutMs);
      }),
    ]);
  } catch (error) {
    return { ok: false, error: String(error) };
  } finally {
    // Cleared whichever branch won, so a fast probe does not hold the event loop open for the timeout's
    // remainder — which would add up to two seconds to every `node --test` run of this file.
    if (timer) clearTimeout(timer);
  }
}

/** herdr's own variable, set in every pane it creates. Measured 2026-08-17; documented nowhere. */
export const ENV_PARENT_WORKSPACE = "HERDR_WORKSPACE_ID";

/**
 * Which herdr workspace a governed child's pane belongs in.
 *
 * **Defaults to the parent's own workspace.** herdr tells a pane which workspace it is in
 * (`HERDR_WORKSPACE_ID`, alongside `HERDR_TAB_ID` and `HERDR_PANE_ID`), and a child placed in a *different*
 * workspace from the pi session that spawned it turns "switch between them" into a workspace hop — which is
 * the entire feature ADR-0032 exists to deliver. The previous behaviour was "omitted lets herdr choose",
 * which is that failure by default on any machine with more than one workspace.
 *
 * `PI_GRANTS_HERDR_WORKSPACE` still wins: it is the operator saying so explicitly, and an explicit answer
 * beating an inference is this package's standing rule (ADR-0030 says it about the grant itself).
 *
 * Blank is treated as absent rather than passed through — `--workspace ""` is not a workspace, and it would
 * fail `tab create` on a path nobody chose.
 */
export function resolveWorkspace(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.PI_GRANTS_HERDR_WORKSPACE?.trim();
  if (explicit) return explicit;
  return env[ENV_PARENT_WORKSPACE]?.trim() || undefined;
}
