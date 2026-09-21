/**
 * The status block a running delegation renders — ADR-0032, in the shape the operator chose on 2026-08-17.
 *
 * Three properties are load-bearing rather than cosmetic, and each has a test:
 *
 *  - **Bounded height AND bounded width.** Five lines per child — header, up to `TAIL_LINES` of tail, and a
 *    blank separator — so eight children is at most 42 lines, plus `MAX_LINE_CHARS` per line. The width half was
 *    missing and the omission mattered: a line cap is what actually bounds the block, because eight children
 *    each printing one megabyte-long line rendered 25 lines and 8 MiB. "Four lines per child" was also simply
 *    wrong arithmetic — the separator was never counted.
 *  - **No braiding.** Each child's text stays under its own header, which is what a chronological stream of two
 *    concurrent children cannot offer.
 *  - **The pane id is on screen while the child is alive.** That is the entire difference between a pane you can
 *    switch to and one you learn about after it closed.
 *
 * What it gives up is stated rather than implied (R-48): output older than the last `TAIL_LINES` lines is not
 * here. It is in the pane while the pane lives, and in the returned result afterwards. **The block is a display
 * and never the result** — conflating the two is R-03 with a new cause.
 *
 * Pure: no pi, no herdr, and no clock. `now` is a parameter so elapsed time is testable.
 */

/** Lines of context kept per child. Three, because four children of four lines each is already a screenful. */
export const TAIL_LINES = 3;

/**
 * Longest a single displayed line may be.
 *
 * **The line COUNT cap was never a height cap, and this is what makes the module header's claim true.** A child
 * printing a minified bundle, a base64 blob or single-line JSON produces one line of megabytes, so
 * `TAIL_LINES` bounded nothing that matters: eight such children rendered **25 lines and 8 MiB — about 84,000
 * wrapped rows** — and were repainted every `PAINT_INTERVAL_MS`. Measured. The test asserting "fixed height"
 * passed throughout, because 25 ≤ 34.
 *
 * 200 is a little over two rows on a wide terminal: enough to read a long path or a stack frame, short enough
 * that eight children cannot flood the screen.
 */
export const MAX_LINE_CHARS = 200;

/** Trim one display line to `MAX_LINE_CHARS`, saying so rather than cutting silently (R-48). */
function clampLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)}… (+${line.length - MAX_LINE_CHARS} chars)`;
}

export type ChildState = "starting" | "running" | "completed" | "failed";

/**
 * The last few lines a child printed, plus whether the final one is still being written.
 *
 * **`open` is why this is not a bare `string[]`.** A pipe delivers bytes, not lines, so `Read` and
 * `ing file.ts` arrive as two chunks and must render as one line — and knowing whether to join or to start a new
 * line is state that `(lines, chunk)` alone cannot carry. The first draft encoded it as a trailing-space
 * sentinel inside the array, which worked and was unreadable; a named boolean is the same information without
 * the puzzle.
 */
export interface Tail {
  lines: string[];
  /** True when the last element is a partial line awaiting more bytes. */
  open: boolean;
}

export const emptyTail: Tail = { lines: [], open: false };

export interface ChildProgress {
  /** Definition name, or `delegate` for a `tools:` spawn. */
  label: string;
  /** herdr agent name, when this child runs in a pane. */
  agentName?: string;
  paneId?: string;
  state: ChildState;
  startedAt: number;
  /** Set once terminal, so elapsed time freezes instead of counting forever. */
  settledAt?: number;
  tail: Tail;
}

/**
 * Collapse a terminal's carriage returns the way a terminal would: what follows the last `\r` wins.
 *
 * A spinner writes `working \r working \r done`. Splitting on `\r` as if it were a newline would fill the whole
 * three-line tail with one frame per tick and push the child's real output out of the block.
 */
function lastAfterCarriageReturn(line: string): string {
  const at = line.lastIndexOf("\r");
  return at === -1 ? line : line.slice(at + 1);
}

/**
 * Fold a raw chunk into a tail.
 *
 * Blank lines are dropped so a child printing newlines cannot blank the block — at three lines of context, four
 * newlines would erase everything the operator was reading.
 */
export function appendTail(tail: Tail, chunk: string): Tail {
  if (chunk.length === 0) return tail;

  const parts = chunk.split("\n");
  const lines = [...tail.lines];

  // The first part continues the previous line when that line was left open.
  //
  // **Clamped on every write, not only at render.** A child that never emits a newline keeps extending one
  // line, and an unclamped join grew it without bound — measured at 12,692 characters from a pane that never
  // held more than 16. Clamping here also bounds what is retained, not merely what is shown.
  if (tail.open && lines.length > 0) {
    lines[lines.length - 1] = clampLine(lastAfterCarriageReturn(lines[lines.length - 1] + parts[0]));
  } else if (parts[0].trim().length > 0) {
    lines.push(clampLine(lastAfterCarriageReturn(parts[0])));
  }

  for (const part of parts.slice(1)) {
    if (part.trim().length > 0) lines.push(clampLine(lastAfterCarriageReturn(part)));
  }

  return { lines: lines.slice(-TAIL_LINES), open: !chunk.endsWith("\n") };
}

/**
 * Replace a tail wholesale from a pane SNAPSHOT — the herdr path's counterpart to `appendTail`.
 *
 * `agent read` returns a snapshot of a bounded terminal, so the right operation is *replace*, not *append*.
 * Appending snapshots is what fabricated text the child never printed: a pane whose bottom line was
 * `working on step 29` followed by a re-report beginning `line30` rendered `working on step 29line30`.
 * Measured. `open` is always false here, because a snapshot is never mid-line as far as the display is
 * concerned — there is nothing further to join onto.
 */
export function replaceTail(lines: string[]): Tail {
  return { lines: lines.slice(-TAIL_LINES).map(clampLine), open: false };
}

/**
 * A child label is a DIRECTORY name, so it is third-party text on a line this package composes.
 *
 * R-77 and R-78 were both "a name from somewhere else reached a generated artefact"; here a newline forges an
 * entire extra child row in the operator's status block, complete with a plausible agent and pane. Same class,
 * same treatment as `spawn-summary.ts`'s `safeName`: rendered inert rather than trusted.
 */
function safeLabel(label: string): string {
  return /[\n\r\t]/.test(label) ? JSON.stringify(label) : label;
}

/** `m:ss`. A delegation is minutes-scale, and an hour-long one has problems this line will not explain. */
function elapsed(child: ChildProgress, now: number): string {
  const total = Math.floor(Math.max(0, (child.settledAt ?? now) - child.startedAt) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function renderProgress(children: ChildProgress[], executorKind: "herdr" | "process", now: number): string {
  const where = executorKind === "herdr" ? "herdr panes" : "captured subprocesses";
  const lines = [`${children.length} ${children.length === 1 ? "child" : "children"} · ${where}`, ""];

  for (const child of children) {
    const header = [safeLabel(child.label).padEnd(10)];
    if (child.agentName) header.push(`agent ${child.agentName}`);
    if (child.paneId) header.push(`pane ${child.paneId}`);
    header.push(child.state, elapsed(child, now));
    lines.push(header.join("   "));
    // Sliced again here as well as in `appendTail`, so a caller that assembled a `Tail` by hand cannot make the
    // block unbounded. The height guarantee belongs to the renderer, not to its inputs.
    // Clamped again here as well as on write, so a caller that assembled a `Tail` by hand cannot make the block
    // unbounded either. The height guarantee belongs to the renderer, not to its inputs.
    for (const line of child.tail.lines.slice(-TAIL_LINES)) lines.push(`  ${clampLine(line)}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** How often the block is repainted. A child printing fast must not re-render it hundreds of times a second. */
export const PAINT_INTERVAL_MS = 250;

/**
 * Call `fn` at most once per `intervalMs`, and always once more after the last call.
 *
 * The trailing call is the point: without it the final frame — the one showing every child settled — is the one
 * most likely to be dropped, so the block would freeze mid-run and never show completion. `flush` exists so a
 * caller that knows it is finished can paint immediately rather than waiting out the interval.
 */
export function throttle(fn: () => void, intervalMs: number): { call: () => void; flush: () => void } {
  let last = 0;
  let timer: NodeJS.Timeout | undefined;

  const run = (at: number) => {
    last = at;
    timer = undefined;
    fn();
  };

  return {
    call: () => {
      const now = Date.now();
      if (now - last >= intervalMs) return run(now);
      // Already scheduled: the pending call will render whatever state exists when it fires, which is newer
      // than this one. Queueing another would only repaint the same thing twice.
      if (timer) return;
      timer = setTimeout(() => run(Date.now()), intervalMs - (now - last)).unref?.() as never;
    },
    flush: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      last = Date.now();
      fn();
    },
  };
}
