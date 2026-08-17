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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildRunResult } from "./run-child.ts";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from "./run-child.ts";
import { MAX_OPEN_PANES, trackPane, trimOpenPanes, untrackPane } from "./pane-reaper.ts";
import { defaultExec, parseReply, type HerdrExec } from "./herdr-cli.ts";
import { POLL_INTERVAL_MS, readPane, waitForSettled } from "./herdr-poll.ts";

/**
 * Re-exported so importers of the executor still reach the protocol at the name they always used.
 *
 * Deliberate rather than lazy: `test/run-herdr.test.ts` imports `HerdrExec` from here and must pass
 * **unmodified** across this extraction — that is the only available proof the move changed no behaviour.
 */
export { type HerdrExec, parseReply } from "./herdr-cli.ts";
/**
 * Re-exported so `test/run-herdr.test.ts` and any importer keep reaching these where they always were.
 *
 * `POLL_INTERVAL_MS` and `newSuffix` moved to `./herdr-poll.ts` under the 400-line ceiling; the names are part
 * of this module's surface and moving a file should not move an export.
 */
export { POLL_INTERVAL_MS, newSuffix, readPane, waitForSettled, type PollTarget } from "./herdr-poll.ts";

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
  /**
   * Pane text as it appears, for the parent's progress display (ADR-0032).
   *
   * **Display only**, exactly as in `runChild`: the child's answer is still the returned `text`. Only the text
   * the pane has GAINED since the last read is passed — see `newSuffix` for why that matters.
   *
   * Exceptions are swallowed; a renderer must not be able to break a governed run.
   */
  onOutput?: (chunk: string) => void;
  /**
   * The pane id, reported as soon as `tab create` returns it.
   *
   * Separate from `onOutput` because it arrives once and arrives *early*: it is what lets the parent print a
   * name a human can switch to **while the child is alive**, which is the whole point of the pane surviving.
   */
  onPane?: (paneId: string) => void;
  /** Poll cadence override. Exists so tests do not wait `POLL_INTERVAL_MS` per state transition. */
  pollIntervalMs?: number;
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

/** How often to retry `agent start` while a freshly created pane is still reaching its shell prompt. */
export const PANE_READY_POLL_MS = 300;

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
  if (tabId && !request.keepPane) {
    trackPane({ tab: tabId, name: request.name, promptDir });
    // ADR-0032: panes now live until `agent_settled`, so they accumulate across one agent run — and a plain
    // blocking `delegate` spends nothing from the fan-out budget, so the count is otherwise unbounded. Trimmed
    // here rather than at settle time so the bound holds DURING a long run, not only after it.
    //
    // Whatever is closed is reported through `onOutput` rather than dropped: an operator whose pane vanished
    // while they were reading it deserves to know why (R-48's rule, applied to a display).
    const dropped = await trimOpenPanes(exec);
    if (dropped.length > 0 && request.onOutput) {
      try {
        request.onOutput(
          `\n[grants] closed ${dropped.length} older pane(s) to stay within the ${MAX_OPEN_PANES}-pane ` +
            `limit: ${dropped.join(", ")}\n`,
        );
      } catch {
        /* display only */
      }
    }
  }

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

  /**
   * Stop the agent and release what belongs to this CALL. **The pane deliberately survives.**
   *
   * ADR-0032. This used to `tab close` in a `finally`, so a pane was destroyed the instant its child settled —
   * and a twenty-second child's pane is gone before anyone can switch to it. The pane was real and
   * unobservable, which is the worst of both. It now belongs to the **agent run**: `agent_settled` sweeps it
   * (`reapOpenPanesAsync`), with the `exit` handler as the backstop it always was.
   *
   * The agent is still stopped here, and that distinction is the point — the pane outliving the tool call must
   * not mean a governed child keeps *working* in it. What survives is a terminal with its scrollback, not a
   * running descendant.
   *
   * The staged system prompt now travels with the pane rather than being removed here, because the pane may
   * still be read; the reaper deletes it when it closes the tab.
   *
   * `keepPane` means "not even at `agent_settled`", so it untracks: an operator who asked to keep a pane for
   * inspection must not have it swept the moment their prompt comes back.
   */
  const cleanup = async () => {
    await exec(["agent", "stop", request.name]).catch(() => undefined);
    // `keepPane` also keeps the staged prompt, for the same reason it keeps the pane.
    if (request.keepPane && tabId) untrackPane(tabId);
  };

  // ADR-0032: the pane exists and has a name, so tell the caller NOW. A pane id that arrives with the result is
  // useless — the point is switching to a child while it is still working. Guarded because a renderer must not
  // be able to strand a pane we have already created.
  if (request.onPane) {
    try {
      request.onPane(paneId);
    } catch {
      /* display only */
    }
  }

  try {
    const started = await startAgent(exec, request.name, paneId, effectiveArgs, deadline);
    if (started.error) return { ...empty, spawnError: `herdr agent start failed: ${started.error}` };

    // The state counter BEFORE prompting is what makes the wait correct — see the R-33 note below.
    const before = seqOf(started.result);

    const prompted = parseReply(await exec(["agent", "prompt", request.name, request.prompt]));
    if (prompted.error) return { ...empty, spawnError: `herdr agent prompt failed: ${prompted.error}` };

    const settled = await waitForSettled(exec, request, before, deadline, maxOutputBytes);
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
