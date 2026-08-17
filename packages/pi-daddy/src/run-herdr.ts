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

import { rm } from "node:fs/promises";
import type { ChildRunResult } from "./run-child.ts";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from "./run-child.ts";
import { MAX_OPEN_PANES, markPaneSettled, trackPane, trimOpenPanes, untrackPane } from "./pane-reaper.ts";
import { defaultExec, parseReply, type HerdrExec } from "./herdr-cli.ts";
import { readPane, waitForSettled } from "./herdr-poll.ts";
import { stageSystemPrompt } from "./herdr-stage.ts";

/**
 * Re-exported so importers of the executor still reach the protocol at the name they always used.
 *
 * Deliberate rather than lazy: `test/run-herdr.test.ts` imports `HerdrExec` from here and must pass
 * **unmodified** across this extraction — that is the only available proof the move changed no behaviour.
 */
export { type HerdrExec, parseReply } from "./herdr-cli.ts";
/** Re-exported: `splitSystemPrompt` moved to `./herdr-stage.ts` under the ceiling, its tests import it here. */
export { splitSystemPrompt, stageSystemPrompt } from "./herdr-stage.ts";
/**
 * Re-exported so `test/run-herdr.test.ts` and any importer keep reaching these where they always were.
 *
 * `POLL_INTERVAL_MS` and `newSuffix` moved to `./herdr-poll.ts` under the 400-line ceiling; the names are part
 * of this module's surface and moving a file should not move an export.
 */
export { DEFAULT_SNAPSHOT_LINES, POLL_INTERVAL_MS, readPane, tailLines, waitForSettled, type PollTarget } from "./herdr-poll.ts";

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
   * The pane's last few lines, re-reported every poll — a SNAPSHOT the consumer REPLACES, not appends.
   *
   * **Display only**, exactly as in `runChild`: the child's answer is still the returned `text`. Unlike
   * `runChild`'s `onOutput`, this is not a stream: `agent read` returns a snapshot of a bounded terminal, and
   * the previous append-shaped design produced an 89,000× amplification once a pane scrolled or passed the
   * output cap. See `tailLines` in `./herdr-poll.ts`.
   *
   * Exceptions are swallowed; a renderer must not be able to break a governed run.
   */
  onSnapshot?: (lines: string[]) => void;
  /** How many pane lines to report per poll. Defaults to `DEFAULT_SNAPSHOT_LINES`. */
  snapshotLines?: number;
  /**
   * The pane id, reported as soon as `tab create` returns it.
   *
   * Separate from `onOutput` because it arrives once and arrives *early*: it is what lets the parent print a
   * name a human can switch to **while the child is alive**, which is the whole point of the pane surviving.
   */
  onPane?: (paneId: string, agentName: string) => void;
  /** Poll cadence override. Exists so tests do not wait `POLL_INTERVAL_MS` per state transition. */
  pollIntervalMs?: number;
}


/** How often to retry `agent start` while a freshly created pane is still reaching its shell prompt. */
export const PANE_READY_POLL_MS = 300;

/** Monotonic within this process. See `uniqueAgentName`. */
let spawnSeq = 0;

/**
 * Make a herdr agent name that cannot collide with a live one.
 *
 * **Measured, and a shipping defect without it.** herdr binds an agent name to its **tab**, and only closing
 * the tab frees the name: a second `agent start` with a name still held returns
 * `agent_name_taken: agent <name> is already used; … tab_id=…`. `herdr agent stop` does not exist (see
 * `cleanup`), so nothing else releases it.
 *
 * Callers build a name from the definition and the ledger child id — and for a plain blocking `delegate` that
 * id is **constant** (`d0.1`, index 0 of the session), so every delegation in a session asked for the same
 * name. That was harmless while the pane closed at the end of each call. Once ADR-0032 kept panes alive to
 * `agent_settled`, the **first** delegation of a turn worked and every later one failed with
 * `agent_name_taken`, on the executor ADR-0031 had just made the default.
 *
 * Uniquified HERE rather than at the call site, so no caller can forget: the constraint belongs to herdr, and
 * this module is the only thing that talks to herdr. The suffix is a counter rather than a random token so a
 * pane label stays readable and reproducible within a run.
 */
export function uniqueAgentName(base: string): string {
  spawnSeq += 1;
  return `${base}#${spawnSeq}`;
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

  // A multi-line system prompt becomes a file; see `stageSystemPrompt`. Removed on every path that does not
  // end up tracking a pane, because only a tracked pane's dir is reachable by a sweep.
  const staged = await stageSystemPrompt(request.args);
  if (staged.error) return { ...empty, spawnError: staged.error };
  const promptDir = staged.promptDir;
  const effectiveArgs = staged.args;

  const create = ["tab", "create", "--label", request.name, "--cwd", request.cwd];
  if (request.workspace) create.push("--workspace", request.workspace);
  for (const [key, value] of Object.entries(request.env)) create.push("--env", `${key}=${value}`);

  // The name herdr will actually know this agent by. Every later command in this function uses `agentName`,
  // never `request.name`, which is only a base.
  const agentName = uniqueAgentName(request.name);
  const created = parseReply(await exec(create));
  if (created.error) {
    // **The staged prompt is removed here too.** This path returned without touching it, and nothing tracked it,
    // so neither sweep could ever reach it — a permanent `/tmp/grants-herdr-*` per failed `tab create`. Measured
    // by a reviewer, who also found leftovers from earlier runs already sitting in `/tmp`. It is the most likely
    // failure on a machine where herdr is not running, i.e. the common case.
    if (promptDir) await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
    return { ...empty, spawnError: `herdr tab create failed: ${created.error}` };
  }

  const rootPane = (created.result?.root_pane ?? {}) as { pane_id?: string; tab_id?: string };
  const paneId = rootPane.pane_id;
  const tabId = rootPane.tab_id;
  // **Tracked BEFORE the pane-id check, not after.** A tab can exist from the moment this reply is parsed,
  // so registering later leaves a window — one herdr round-trip wide — in which a killed process orphans a
  // tab nothing would reap. The normal path had no such window and the error path did, which is backwards:
  // the error path is the one more likely to be taken while something is already going wrong.
  if (tabId && request.keepPane && promptDir) {
    // `keepPane` keeps the PANE, and the staged prompt with it — a human inspecting the pane may want to see
    // what the child was told. Registered `settled` so the trim never touches it, but registered nonetheless so
    // the `exit` sweep can remove the temp dir rather than leaving one per kept pane forever. Measured: this
    // path leaked a `/tmp/grants-herdr-*` that neither sweep could reach.
    trackPane({ tab: tabId, name: agentName, promptDir, settled: true, keepTab: true });
  }
  if (tabId && !request.keepPane) {
    trackPane({ tab: tabId, name: agentName, promptDir });
    // ADR-0032: panes now live until `agent_settled`, so they accumulate across one agent run — and a plain
    // blocking `delegate` spends nothing from the fan-out budget, so the count is otherwise unbounded. Trimmed
    // here rather than at settle time so the bound holds DURING a long run, not only after it.
    //
    // Whatever is closed is reported through `onOutput` rather than dropped: an operator whose pane vanished
    // while they were reading it deserves to know why (R-48's rule, applied to a display).
    const dropped = await trimOpenPanes(exec);
    if (dropped.length > 0 && request.onSnapshot) {
      try {
        request.onSnapshot([
          `[grants] closed ${dropped.length} older pane(s) to stay within the ${MAX_OPEN_PANES}-pane limit: ` +
            dropped.join(", "),
        ]);
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
    // There is no agent in this pane to ask, so the staged prompt has no reader — remove it. Kept only under
    // `keepPane`, where the operator asked to inspect whatever exists.
    if (promptDir && !request.keepPane) await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
    return { ...empty, spawnError: "herdr tab create returned no pane id" };
  }

  /**
   * End this call. **A child that did not settle has its tab closed, because that is the only way to stop it.**
   *
   * ADR-0032 keeps a pane alive past its tool call so a human can read it. The original version of that also
   * called `herdr agent stop` and claimed *"the agent is still stopped here… what survives is a terminal, not a
   * running descendant."* **`herdr agent stop` does not exist.** Measured against herdr 0.7.5: the `agent`
   * subcommands are `list get read send-keys prompt rename focus wait attach start explain`, and `agent stop`
   * prints the usage banner and exits 0 — which `defaultExec` reports as a success, so nothing ever noticed.
   * `docs/probes/g16-herdr/README.md` asserted it worked, in a *How to rerun* block that was never run.
   *
   * So there is exactly one kill available: closing the tab. That forces the distinction below.
   *
   *  - **Settled cleanly** (`idle`/`done`/`blocked` with an advanced counter): the child has answered and is
   *    sitting idle. Its pane stays, which is the whole feature, and the `agent_settled` sweep reaps it.
   *  - **Anything else** — a timeout, an abort, a failed start, a failed prompt, an unreadable pane: the child
   *    may still be **working, with its grant**, after its tool call has already returned a result. Leaving
   *    that running is a governance failure, not an untidy workspace, so the tab is closed here and now.
   *
   * `keepPane` is the operator overriding the whole question, and it is honoured either way: nothing is tracked
   * and nothing is closed, which is what "keep this pane for me to inspect" has to mean.
   */
  const cleanup = async (settledCleanly: boolean) => {
    if (request.keepPane) return;
    if (settledCleanly) return;
    if (!tabId) return;
    const reply = await exec(["tab", "close", tabId]).catch(() => undefined);
    // Untracked only if provably closed — R-62's rule. A close herdr refused stays the reaper's problem rather
    // than being dropped on the assumption that it worked.
    if (reply !== undefined && !parseReply(reply).error) {
      untrackPane(tabId);
      if (promptDir) await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  // ADR-0032: the pane exists and has a name, so tell the caller NOW. A pane id that arrives with the result is
  // useless — the point is switching to a child while it is still working. Guarded because a renderer must not
  // be able to strand a pane we have already created.
  if (request.onPane) {
    try {
      request.onPane(paneId, agentName);
    } catch {
      /* display only */
    }
  }

  // Set only on the one path where the child answered and stopped working. Everything else — including an
  // early `return` from a failed start or prompt — leaves it false, so `cleanup` closes the tab.
  let settledCleanly = false;

  try {
    const started = await startAgent(exec, agentName, paneId, effectiveArgs, deadline);
    if (started.error) return { ...empty, spawnError: `herdr agent start failed: ${started.error}` };

    // The state counter BEFORE prompting is what makes the wait correct — see the R-33 note below.
    const before = seqOf(started.result);

    const prompted = parseReply(await exec(["agent", "prompt", agentName, request.prompt]));
    if (prompted.error) return { ...empty, spawnError: `herdr agent prompt failed: ${prompted.error}` };

    const settled = await waitForSettled(exec, { ...request, name: agentName }, before, deadline, maxOutputBytes);
    if (settled.aborted || settled.timedOut) {
      // Still read: a timed-out child usually produced something, and a partial answer labelled partial is
      // more useful than none. R-03's rule — a missing result must never look like an empty one.
      const partial = await readPane(exec, agentName, maxOutputBytes);
      return { ...empty, ...settled, text: partial.readFailed ? "" : partial.text, truncated: partial.truncated };
    }
    if (settled.spawnError) return { ...empty, spawnError: settled.spawnError };

    const out = await readPane(exec, agentName, maxOutputBytes);
    // **A failed read is a failed spawn, not an empty answer.** This branch used to return `readPane`'s own
    // diagnostic as `text` with `code: 0`, so the orchestrator received
    // `[grants] could not read the agent pane: …` **as the sub-agent's report** — R-03 exactly, and measured.
    // The child may well have done its work; what we cannot do is claim to know what it said.
    if (out.readFailed) {
      return {
        ...empty,
        spawnError:
          `the child settled but its pane could not be read (${out.readFailed}), so its answer is unknown. ` +
          `The work may have been done — check pane ${paneId} if it is still open.`,
      };
    }
    settledCleanly = true;
    // The trim may now reclaim this pane if the cap is exceeded. Until this point it must not: closing the tab
    // kills the child, and the child was still working.
    if (tabId) markPaneSettled(tabId);
    return {
      code: settled.status === "blocked" ? 1 : 0,
      // `truncated` is returned in the result too, but it was never SAID on this path, so a model received a
      // tail with no indication that a head existed. The direct executor has always flagged it; a delegation
      // that silently drops the first megabyte of an answer is the same defect wearing the other executor.
      text: [
        out.truncated ? `[grants] this pane exceeded the output cap; only its most recent output is below.\n` : "",
        out.text,
        settled.status === "blocked"
          ? `\n\n[grants] this agent is BLOCKED waiting for a human in pane ${paneId}.`
          : "",
      ].join(""),
      truncated: out.truncated,
      timedOut: false,
      aborted: false,
    };
  } finally {
    await cleanup(settledCleanly);
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
