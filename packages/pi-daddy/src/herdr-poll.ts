/**
 * Waiting for a herdr agent to settle, and reading what it printed on the way.
 *
 * Split out of `src/run-herdr.ts` when that file hit **404 of the 400-line ceiling** adding ADR-0032's output
 * polling. The seam was named in the plan before it was needed, and it is a real one: this module is about
 * *observing* an agent, `run-herdr.ts` is about *starting and cleaning up after* one. Nothing here creates or
 * destroys anything.
 *
 * The two facts it is built on were measured against real herdr 0.7.5 (`docs/probes/g16-herdr`) and both are
 * counter-intuitive enough to be worth the module comment: `agent wait --until idle` matches the state the
 * agent was **already** in, and `agent read` is the one command that does **not** return a JSON envelope.
 */

import { parseReply, type HerdrExec } from "./herdr-cli.ts";

/**
 * What `waitForSettled` needs from a run request.
 *
 * Declared here rather than importing `HerdrRunRequest`, which would make the two modules mutually dependent
 * for no benefit. `HerdrRunRequest` satisfies it structurally, so the call site needs no adapter.
 */
export interface PollTarget {
  /** herdr agent name. */
  name: string;
  signal?: AbortSignal;
  /** Pane text as it appears, for the parent's progress display (ADR-0032). Display only. */
  onOutput?: (chunk: string) => void;
  /** Poll cadence override. Exists so tests do not wait `POLL_INTERVAL_MS` per state transition. */
  pollIntervalMs?: number;
}

/** Statuses herdr reports for a settled agent. `blocked` counts: it is waiting for a human, not working. */
const TERMINAL = new Set(["idle", "done", "blocked"]);

/** How often to poll `agent get` while waiting for the child to settle. */
export const POLL_INTERVAL_MS = 750;

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
export async function waitForSettled(
  exec: HerdrExec,
  request: PollTarget,
  before: number,
  deadline: number,
  maxOutputBytes: number,
): Promise<{ status?: string; timedOut?: boolean; aborted?: boolean; spawnError?: string }> {
  const interval = request.pollIntervalMs ?? POLL_INTERVAL_MS;
  // ADR-0032. The pane is read on every poll so the parent can show what the child is doing, rather than the
  // one word `delegate` for up to ten minutes. `reported` is the text already handed to `onOutput`, which is
  // what makes `newSuffix` able to send only what is new.
  let reported = "";

  for (;;) {
    if (request.signal?.aborted) return { aborted: true };
    if (Date.now() >= deadline) return { timedOut: true };

    const reply = parseReply(await exec(["agent", "get", request.name]));
    if (reply.error) return { spawnError: `herdr agent get failed: ${reply.error}` };

    const agent = (reply.result?.agent ?? reply.result ?? {}) as { agent_status?: string; state_change_seq?: number };
    const status = agent.agent_status;
    const seq = typeof agent.state_change_seq === "number" ? agent.state_change_seq : -1;

    if (request.onOutput) {
      // Read BEFORE the terminal check returns, so a child that settles on this iteration still has its last
      // output reported. Failures are ignored: a read that fails is a display problem, and the real result is
      // fetched separately once the child has settled.
      const current = (await readPane(exec, request.name, maxOutputBytes)).text;
      const fresh = newSuffix(reported, current);
      reported = current;
      if (fresh.length > 0) {
        try {
          request.onOutput(fresh);
        } catch {
          /* display only — a renderer must not break a governed run */
        }
      }
    }

    if (status && TERMINAL.has(status) && seq > before) return { status };

    await new Promise((r) => setTimeout(r, Math.min(interval, Math.max(0, deadline - Date.now()))));
  }
}

/**
 * What the pane has GAINED since the last read.
 *
 * `agent read` returns the **whole terminal**, so reporting its reply verbatim on every poll would repeat the
 * entire buffer once per interval — the status block would show the child's first line forever and the parent's
 * transcript would grow quadratically in the child's runtime.
 *
 * A prefix comparison rather than a line count, because a terminal rewrites its own last line (a spinner, a
 * progress bar). When the new text is *not* an extension of the old one the screen was rewritten, and the whole
 * buffer is reported rather than nothing: reporting nothing there would silently stop the stream for the rest of
 * the run, which is the failure that looks exactly like a hung child.
 */
export function newSuffix(previous: string, current: string): string {
  if (previous.length === 0) return current;
  if (current.startsWith(previous)) return current.slice(previous.length);
  return current;
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
export async function readPane(exec: HerdrExec, name: string, maxOutputBytes: number): Promise<{ text: string; truncated: boolean }> {
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
