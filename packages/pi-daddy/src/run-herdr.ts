/**
 * Run a governed child in a herdr pane — ADR-0016 point 6.
 *
 * The second executor for the same plan. `runChild` spawns `pi` directly and captures its stdout;
 * `runHerdrPane` asks herdr to launch it in a visible, attachable terminal pane. `planSpawn` produces the
 * argv either way, so the grant is identical and only the *place it runs* differs.
 *
 * **Why go through herdr's CLI rather than the third-party `pi-herdr` extension.** That extension exposes
 * `agentArgs` and `env` as MODEL-facing tool parameters (R-30), which hands a model an argv array and the
 * environment variable the grant travels on. Here the model chooses a definition and a task; this package
 * builds the argv. Measured facts this relies on (`docs/probes/g16-herdr`):
 *
 *  - `herdr agent start … -- <args>` delivers argv **verbatim**, echoed back in the reply.
 *  - `--tools` is enforced inside a pane exactly as it is for a direct spawn; `--no-tools` yields none.
 *  - `herdr agent start` has **no `--env`**, but `tab create` / `pane split` do, and a pane's environment
 *    reaches the shell that launches the agent — verified by reading `$PI_GRANTS_GRANT` back out of a
 *    pane created with it. That is how the grant, depth and ledger path propagate on this path.
 *
 * **What a pane is not: a boundary.** It is a terminal. `--tools` remains the enforcement point, ADR-0012's
 * `bash` escape is unchanged, and a pane is *attachable by design*, so a human can type into a governed
 * child. Humans are not this project's threat model, but nothing here should be read as containing one.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildRunResult } from "./run-child.ts";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from "./run-child.ts";
import { trackPane, untrackPane } from "./pane-reaper.ts";

/** One herdr CLI invocation. Injectable so every rule below is testable without herdr installed. */
export type HerdrExec = (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface HerdrRunRequest {
  /** `planSpawn` args **without** the prompt — see `prompt`. */
  args: string[];
  /**
   * The task, delivered with `herdr agent prompt` rather than as an argv element.
   *
   * This is strictly safer than the direct-spawn path, which has to defend a model-authored string from
   * pi's argv parser by prefixing a space (`neutralisePrompt`, `docs/probes/g1-argv`). Here the task never
   * reaches argv at all, so there is no parser in front of it.
   */
  prompt: string;
  /** Grant/depth/ledger variables. Set on the PANE, which the agent's shell inherits. */
  env: Record<string, string>;
  cwd: string;
  /** Unique pane and agent name. */
  name: string;
  /** herdr workspace to create the tab in. Omitted lets herdr choose. */
  workspace?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * Leave the pane open after the run so a human can read or resume it.
   *
   * Default **false**: a fan-out that leaks a pane per child fills the operator's workspace, and
   * `docs/probes/g16-herdr` records that panes are not trivially closable once orphaned.
   */
  keepPane?: boolean;
  exec?: HerdrExec;
}

/**
 * Move a multi-line `--append-system-prompt` out of argv, because herdr cannot encode it.
 *
 * **Measured.** `herdr agent start` types the argv into the pane's shell, so a value containing newlines
 * is rejected outright: `invalid_agent_argument — agent arguments cannot be encoded safely for the target
 * shell`. A definition's `SKILL.md` body is always multi-line, so every `delegate({agent})` spawn would
 * fail on this path.
 *
 * pi accepts a **file path** there as readily as literal text (`resolvePromptInput` + `existsSync` in
 * `dist/core/resource-loader.js`), so the fix is to write the body to a temp file and pass its path — one
 * short, shell-safe argument.
 *
 * The split lives here rather than in `planSpawn` because the constraint is **herdr's**, not pi's: the
 * direct executor passes the same text inline with no trouble, and a plan builder that pre-emptively wrote
 * temp files for everybody would be paying one executor's tax on both paths.
 */
export function splitSystemPrompt(args: string[]): { args: string[]; systemPrompt?: string } {
  const at = args.indexOf("--append-system-prompt");
  if (at === -1 || at + 1 >= args.length) return { args };
  return { args: [...args.slice(0, at), ...args.slice(at + 2)], systemPrompt: args[at + 1] };
}

/** Statuses herdr reports for a settled agent. `blocked` counts: it is waiting for a human, not working. */
const TERMINAL = new Set(["idle", "done", "blocked"]);

/** How often to poll `agent get` while waiting for the child to settle. */
export const POLL_INTERVAL_MS = 750;
/** How often to retry `agent start` while a freshly created pane is still reaching its shell prompt. */
export const PANE_READY_POLL_MS = 300;

const defaultExec: HerdrExec = (args) =>
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
function parseReply(reply: { stdout: string; stderr: string }): { result?: Record<string, unknown>; error?: string } {
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

/**
 * Run one governed child in a pane and return its output.
 *
 * Deliberately returns `ChildRunResult` — the same shape as `runChild` — so the extension can choose an
 * executor without knowing which one it got.
 */
export async function runHerdrPane(request: HerdrRunRequest): Promise<ChildRunResult> {
  const exec = request.exec ?? defaultExec;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const deadline = Date.now() + timeoutMs;
  const empty: ChildRunResult = { code: null, text: "", truncated: false, timedOut: false, aborted: false };

  // A-R3's rule, kept on this path too: checked BEFORE anything is created. An `AbortSignal` does not
  // replay, so a check after the first `await` cannot see an abort that already happened — and we would
  // have left a pane behind for a run that was never wanted.
  if (request.signal?.aborted) return { ...empty, aborted: true };

  // `--print` makes pi process the prompt and exit, so it never reaches the interactive readiness that
  // `herdr agent start` waits for — the agent is simply never detected. Found by the first end-to-end run,
  // which failed inside herdr with an empty reply. Caught here instead, naming the flag, because a
  // mismatch between a plan and its executor is a caller bug and should read like one.
  if (request.args.includes("--print") || request.args.includes("-p")) {
    return {
      ...empty,
      spawnError:
        "herdr needs an INTERACTIVE agent, but the plan contains --print, which makes pi exit immediately " +
        "and never be detected. Build the plan with `print: false` for this executor.",
    };
  }

  // A multi-line system prompt becomes a file; see `splitSystemPrompt`. Removed in `cleanup`, so a
  // definition's instructions do not accumulate in /tmp across a fan-out.
  const split = splitSystemPrompt(request.args);
  let promptDir: string | undefined;
  let effectiveArgs = split.args;
  if (split.systemPrompt !== undefined) {
    try {
      promptDir = await mkdtemp(join(tmpdir(), "grants-herdr-"));
      const file = join(promptDir, "system-prompt.md");
      await writeFile(file, split.systemPrompt, "utf8");
      effectiveArgs = [...split.args, "--append-system-prompt", file];
    } catch (error) {
      return { ...empty, spawnError: `could not stage the system prompt for herdr: ${String(error)}` };
    }
  }

  const create = ["tab", "create", "--label", request.name, "--cwd", request.cwd];
  if (request.workspace) create.push("--workspace", request.workspace);
  for (const [key, value] of Object.entries(request.env)) create.push("--env", `${key}=${value}`);

  const created = parseReply(await exec(create));
  if (created.error) return { ...empty, spawnError: `herdr tab create failed: ${created.error}` };

  const rootPane = (created.result?.root_pane ?? {}) as { pane_id?: string; tab_id?: string };
  const paneId = rootPane.pane_id;
  const tabId = rootPane.tab_id;
  // **Tracked BEFORE the pane-id check, not after.** A tab can exist from the moment this reply is parsed,
  // so registering later leaves a window — one herdr round-trip wide — in which a killed process orphans a
  // tab nothing would reap. The normal path had no such window and the error path did, which is backwards:
  // the error path is the one more likely to be taken while something is already going wrong.
  if (tabId && !request.keepPane) trackPane({ tab: tabId, name: request.name, promptDir });

  if (!paneId) {
    // The tab may exist even though the reply carried no pane id, and this return used to be BEFORE
    // `cleanup` was defined — so the one path where herdr half-succeeded was the one that leaked a tab.
    if (tabId && !request.keepPane) {
      const reply = await exec(["tab", "close", tabId]).catch(() => undefined);
      // Same rule as `cleanup`: untrack only what is provably gone, so a close herdr refused stays the
      // reaper's problem rather than being dropped on the assumption that it worked.
      if (reply !== undefined && !parseReply(reply).error) untrackPane(tabId);
    }
    // `keepPane` keeps the staged prompt for the same reason `cleanup` does — a human inspecting the pane
    // may want to see what the child was told. This branch used to remove it unconditionally, which threw
    // that away on the one path where there is no agent in the pane to ask instead.
    if (promptDir && !request.keepPane) await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
    return { ...empty, spawnError: "herdr tab create returned no pane id" };
  }

  /** Close what we opened, whatever happened. A leaked pane per child is how fan-out fills a workspace. */
  const cleanup = async () => {
    await exec(["agent", "stop", request.name]).catch(() => undefined);
    let closed = false;
    if (!request.keepPane && tabId) {
      // **The reply must be PARSED, not merely awaited.** `defaultExec` resolves with `{code: 1}` on
      // failure and never rejects, so the `.catch` here was dead code and a herdr that REFUSED to close the
      // pane looked identical to one that closed it. The pane was then untracked, so the exit reaper — the
      // one thing built for exactly this failure — would not retry it. The single case the reaper exists
      // for was the case that disabled it.
      const reply = await exec(["tab", "close", tabId]).catch(() => undefined);
      closed = reply !== undefined && !parseReply(reply).error;
    }
    // Kept when the pane is kept: a human inspecting the pane may want to see what the child was told.
    if (promptDir && !request.keepPane) await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
    // Untrack only what is genuinely gone. A pane we failed to close stays registered so `exit` tries once
    // more; `openPaneCount()` is what a test asserts to prove the registry does not grow per delegation.
    if (tabId && (closed || request.keepPane)) untrackPane(tabId);
  };

  try {
    const started = await startAgent(exec, request.name, paneId, effectiveArgs, deadline);
    if (started.error) return { ...empty, spawnError: `herdr agent start failed: ${started.error}` };

    // The state counter BEFORE prompting is what makes the wait correct — see the R-33 note below.
    const before = seqOf(started.result);

    const prompted = parseReply(await exec(["agent", "prompt", request.name, request.prompt]));
    if (prompted.error) return { ...empty, spawnError: `herdr agent prompt failed: ${prompted.error}` };

    const settled = await waitForSettled(exec, request, before, deadline);
    if (settled.aborted || settled.timedOut) {
      // Still read: a timed-out child usually produced something, and a partial answer labelled partial is
      // more useful than none. R-03's rule — a missing result must never look like an empty one.
      const partial = await readPane(exec, request.name, maxOutputBytes);
      return { ...empty, ...settled, text: partial.text, truncated: partial.truncated };
    }
    if (settled.spawnError) return { ...empty, spawnError: settled.spawnError };

    const out = await readPane(exec, request.name, maxOutputBytes);
    return {
      code: settled.status === "blocked" ? 1 : 0,
      text:
        settled.status === "blocked"
          ? `${out.text}\n\n[grants] this agent is BLOCKED waiting for a human in pane ${paneId}.`
          : out.text,
      truncated: out.truncated,
      timedOut: false,
      aborted: false,
    };
  } finally {
    await cleanup();
  }
}

/**
 * Start the agent, retrying while the pane is still coming up.
 *
 * **Measured, and only visible once automated.** A pane created by `tab create` is not immediately at a
 * shell prompt, and `herdr agent start` requires one — it fails with
 * `agent_pane_busy: … is not an available shell`. Driving the two commands by hand hid this completely,
 * because the think-time between them was longer than the shell took to start; the first scripted run hit
 * it every time.
 *
 * Retried rather than preceded by a fixed sleep: a sleep long enough for a loaded machine is wasted on
 * every spawn, and a fan-out pays it per child. Only the busy condition is retried — any other error is a
 * real failure and returns immediately.
 */
async function startAgent(
  exec: HerdrExec,
  name: string,
  paneId: string,
  args: string[],
  deadline: number,
): Promise<{ result?: Record<string, unknown>; error?: string }> {
  for (;;) {
    const reply = parseReply(await exec(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--", ...args]));
    if (!reply.error) return reply;
    const busy = /not an available shell|agent_pane_busy/.test(reply.error);
    if (!busy || Date.now() >= deadline) return reply;
    await new Promise((r) => setTimeout(r, PANE_READY_POLL_MS));
  }
}

function seqOf(result: Record<string, unknown> | undefined): number {
  const agent = (result?.agent ?? {}) as { state_change_seq?: number };
  return typeof agent.state_change_seq === "number" ? agent.state_change_seq : -1;
}

/**
 * Wait for the child to settle, without accepting the state it was already in.
 *
 * **R-33, measured.** `herdr agent wait --until idle` called right after `agent prompt` returned
 * *immediately*, matching the agent's **pre-existing** idle state with `state_change_seq` unchanged — a
 * reply indistinguishable from a completed run. For fan-out that is not an inconvenience but a
 * correctness bug: an orchestrator would "collect" N children that never ran and merge N empty results
 * into a confident summary (R-03 with a new cause).
 *
 * So this polls `agent get` and requires **both** that the status is terminal **and** that
 * `state_change_seq` has advanced past the value observed before prompting. `agent wait` is deliberately
 * not used at all: its contract cannot express "settled *after* this point".
 */
async function waitForSettled(
  exec: HerdrExec,
  request: HerdrRunRequest,
  before: number,
  deadline: number,
): Promise<{ status?: string; timedOut?: boolean; aborted?: boolean; spawnError?: string }> {
  for (;;) {
    if (request.signal?.aborted) return { aborted: true };
    if (Date.now() >= deadline) return { timedOut: true };

    const reply = parseReply(await exec(["agent", "get", request.name]));
    if (reply.error) return { spawnError: `herdr agent get failed: ${reply.error}` };

    const agent = (reply.result?.agent ?? reply.result ?? {}) as { agent_status?: string; state_change_seq?: number };
    const status = agent.agent_status;
    const seq = typeof agent.state_change_seq === "number" ? agent.state_change_seq : -1;

    if (status && TERMINAL.has(status) && seq > before) return { status };

    await new Promise((r) => setTimeout(r, Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))));
  }
}

/**
 * Read the pane's contents.
 *
 * `agent read` is the ONE command that does not return herdr's JSON envelope — it writes the terminal's
 * text straight to stdout. Running it through `parseReply` turned every successful read into
 * "unparseable herdr reply", i.e. reported the child's actual answer as a failure to read it. Found by the
 * end-to-end run; the unit fake had been written to the envelope shape and so agreed with the bug.
 *
 * A JSON envelope is still accepted first, because an `error` reply here IS JSON and must not be mistaken
 * for terminal output.
 */
async function readPane(exec: HerdrExec, name: string, maxOutputBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reply = await exec(["agent", "read", name]);
  let text: string;
  try {
    const parsed = JSON.parse(reply.stdout) as { result?: Record<string, unknown>; error?: { message?: string } };
    if (parsed.error) {
      return { text: `[grants] could not read the agent pane: ${parsed.error.message ?? "unknown error"}`, truncated: false };
    }
    const raw = parsed.result?.output ?? parsed.result?.text ?? parsed.result?.content ?? "";
    text = typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    text = reply.stdout;
  }
  if (Buffer.byteLength(text) <= maxOutputBytes) return { text, truncated: false };
  // Keep the TAIL, not the head: a terminal's useful content is its most recent output, and the head is
  // the startup banner. `runChild` keeps the head because it streams and must stop a runaway producer;
  // here the output is already complete, so the choice is free and the tail is the answer.
  return { text: text.slice(-maxOutputBytes), truncated: true };
}
