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
  /**
   * The pane's last few lines, re-reported on every poll — a SNAPSHOT, not a stream (ADR-0032).
   *
   * The consumer must **replace** what it holds rather than append. `agent read` returns a snapshot of a
   * bounded terminal, and treating it as append-only is what produced an 89,000× amplification; see
   * `tailLines`.
   */
  onSnapshot?: (lines: string[]) => void;
  /** How many lines the display wants. Bounds the per-poll cost regardless of how big the pane is. */
  snapshotLines?: number;
  /** Poll cadence override. Exists so tests do not wait `POLL_INTERVAL_MS` per state transition. */
  pollIntervalMs?: number;
}

/** Statuses herdr reports for a settled agent. `blocked` counts: it is waiting for a human, not working. */
const TERMINAL = new Set(["idle", "done", "blocked"]);

/** How often to poll `agent get` while waiting for the child to settle. */
export const POLL_INTERVAL_MS = 750;
/** Lines of pane tail reported per poll. Matches the status block's own tail, so nothing is fetched unused. */
export const DEFAULT_SNAPSHOT_LINES = 3;

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
  // one word `delegate` for up to ten minutes.
  //
  // No cross-poll state is kept, deliberately: the previous design remembered what it had reported so it could
  // send a diff, and that is what broke — see `tailLines`. A snapshot needs no memory.
  const keep = request.snapshotLines ?? DEFAULT_SNAPSHOT_LINES;

  for (;;) {
    if (request.signal?.aborted) return { aborted: true };
    if (Date.now() >= deadline) return { timedOut: true };

    const reply = parseReply(await exec(["agent", "get", request.name]));
    if (reply.error) return { spawnError: `herdr agent get failed: ${reply.error}` };

    const agent = (reply.result?.agent ?? reply.result ?? {}) as { agent_status?: string; state_change_seq?: number };
    const status = agent.agent_status;
    const seq = typeof agent.state_change_seq === "number" ? agent.state_change_seq : -1;

    if (request.onSnapshot) {
      // Read BEFORE the terminal check returns, so a child that settles on this iteration still has its last
      // output shown. `readFailed` is passed so a failed read renders as such instead of silently freezing the
      // block on the previous frame — and, crucially, is never mistaken for the child's output.
      const read = await readPane(exec, request.name, maxOutputBytes);
      try {
        request.onSnapshot(read.readFailed ? ["[pane could not be read]"] : tailLines(read.text, keep));
      } catch {
        /* display only — a renderer must not break a governed run */
      }
    }

    if (status && TERMINAL.has(status) && seq > before) return { status };

    await new Promise((r) => setTimeout(r, Math.min(interval, Math.max(0, deadline - Date.now()))));
  }
}

/**
 * The last `keep` non-blank lines of a pane snapshot — what the display actually needs.
 *
 * **This replaces a `newSuffix` diff, and the replacement is a correction rather than a tune-up.** The old
 * design treated `agent read` as a *stream* and tried to report only what was new, by testing whether the new
 * text extended the old. That is wrong about the substrate: `agent read` returns a **snapshot of a bounded
 * terminal**, and a snapshot is not an append-only log. Two ordinary things break the prefix test forever —
 * the pane **scrolling** (its top lines are gone, so the new text is not an extension of the old) and
 * `readPane` **truncating to the tail** past `maxOutputBytes` (each read is a different window of a growing
 * buffer). Once either happens, every poll reported the whole buffer.
 *
 * Measured before the fix: **51 MiB streamed for ~600 bytes of real output — 89,000× amplification** in 37
 * seconds, per child, with a scrolling pane also delivering the same real lines three times each. The old
 * docstring named that exact failure as the thing it prevented.
 *
 * So the herdr path now reports a **bounded snapshot** and the consumer *replaces* rather than appends. There
 * is no diff to get wrong, the per-poll cost is `keep` lines regardless of buffer size, and a scrolling pane
 * simply shows its current tail — which is what a human looking at that pane would see.
 */
export function tailLines(snapshot: string, keep: number): string[] {
  if (keep <= 0) return [];
  const lines: string[] = [];
  // Walked from the END, so a 1 MiB buffer costs the last few lines rather than a full split.
  let end = snapshot.length;
  while (end > 0 && lines.length < keep) {
    const start = snapshot.lastIndexOf("\n", end - 1);
    const line = snapshot.slice(start + 1, end).replace(/\r/g, "").trimEnd();
    if (line.length > 0) lines.unshift(line);
    if (start === -1) break;
    end = start;
  }
  return lines;
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
 *
 * **`readFailed` is separate from `text`, and that separation is the fix for an R-03 defect.** A failed read
 * used to return its own diagnostic *as* `text` — so `runHerdrPane` returned
 * `[grants] could not read the agent pane: pane is gone` **as the child's answer, with `code: 0`**, and the
 * orchestrator read a failure message as a completed sub-agent's report. Measured. It mattered little when this
 * ran once per child; ADR-0032 made it run on every poll, up to 800 times for a ten-minute child, so a
 * transient failure went from unlikely to expected. The caller must now decide, and it cannot do so by
 * inspecting a string.
 */
export async function readPane(
  exec: HerdrExec,
  name: string,
  maxOutputBytes: number,
): Promise<{ text: string; truncated: boolean; readFailed?: string }> {
  const reply = await exec(["agent", "read", name]);
  let text: string;
  try {
    const parsed = JSON.parse(reply.stdout) as { result?: Record<string, unknown>; error?: { message?: string } };
    if (parsed.error) {
      return { text: "", truncated: false, readFailed: parsed.error.message ?? "unknown error" };
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
  //
  // Sliced by BYTES via a Buffer round trip rather than by code units, for `takeBytes`'s reason in
  // `run-child.ts`: `slice(-maxOutputBytes)` on a CJK pane overran the cap by three times. `toString` repairs
  // a character split at the cut by replacing it, which is the right trade for a tail — one replacement
  // character at the boundary, versus a cap that does not hold.
  return { text: Buffer.from(text, "utf8").subarray(-maxOutputBytes).toString("utf8"), truncated: true };
}
