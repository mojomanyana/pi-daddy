/**
 * The status block ADR-0032 pins, in the shape the operator chose on 2026-08-17.
 *
 * **The production changes that break these:** letting the block grow per chunk instead of holding a fixed
 * tail (that is the interleaved option, which was rejected because at eight children it becomes the thing you
 * scroll past to find your own prompt), or dropping the pane id — which is the entire difference between a pane
 * you can switch to and one you learn about after it closed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAINT_INTERVAL_MS,
  TAIL_LINES,
  appendTail,
  MAX_LINE_CHARS,
  emptyTail,
  renderProgress,
  replaceTail,
  throttle,
  type ChildProgress,
} from "../src/progress.ts";

test("the tail holds the LAST three lines, however many arrive", () => {
  let tail = appendTail(emptyTail, "");
  for (const line of ["a", "b", "c", "d", "e"]) tail = appendTail(tail, `${line}\n`);
  assert.deepEqual(tail.lines, ["c", "d", "e"]);
  assert.equal(tail.lines.length, TAIL_LINES);
});

test("a chunk split mid-line does not become two lines", () => {
  // A pipe delivers bytes, not lines. Rendering "Read" and "ing file.ts" as separate entries would make the
  // block lie about what the child printed, and at three lines of context that is most of the content.
  let tail = appendTail(emptyTail, "Read");
  tail = appendTail(tail, "ing file.ts\n");
  assert.deepEqual(tail.lines, ["Reading file.ts"]);
});

test("a line split across three chunks still joins", () => {
  let tail = appendTail(emptyTail, "Reviewing ");
  tail = appendTail(tail, "packages/auth/");
  tail = appendTail(tail, "session.ts\n");
  assert.deepEqual(tail.lines, ["Reviewing packages/auth/session.ts"]);
});

test("a complete line followed by a partial one keeps both, the partial last", () => {
  let tail = appendTail(emptyTail, "first done\nsecond stil");
  assert.deepEqual(tail.lines, ["first done", "second stil"]);
  tail = appendTail(tail, "l going\n");
  assert.deepEqual(tail.lines, ["first done", "second still going"]);
});

test("blank lines are dropped, so a child printing newlines cannot blank the block", () => {
  let tail = appendTail(emptyTail, "real output\n");
  tail = appendTail(tail, "\n\n\n");
  assert.deepEqual(tail.lines, ["real output"]);
});

test("carriage returns do not smuggle a second line in", () => {
  // A spinner writes \r. Treating it as a newline would fill the tail with one frame per tick and push the
  // child's actual output out of the block.
  const tail = appendTail(emptyTail, "working \r working \r done\n");
  assert.ok(tail.lines.length <= TAIL_LINES);
  assert.ok(tail.lines.every((line) => !line.includes("\r")));
});

const child = (over: Partial<ChildProgress> = {}): ChildProgress => ({
  label: "review",
  agentName: "review-d0.1",
  paneId: "w7:t12",
  state: "running",
  startedAt: 0,
  tail: { lines: ["3 findings so far", "session.ts:88", "Reading test file"], open: false },
  ...over,
});

test("a running child's header carries its agent, pane, state and elapsed time", () => {
  const block = renderProgress([child()], "herdr", 42_000);
  for (const expected of [/review/, /review-d0\.1/, /w7:t12/, /running/, /0:42/]) {
    assert.match(block, expected);
  }
});

test("the block is bounded in height, counted as an operator's screen counts it", () => {
  // **Rewritten twice over, because both halves of the original were wrong.**
  //
  // It asserted `<= 8*4 + 2` AFTER filtering out blank lines — which discarded exactly the blank separator that
  // made the claim false. Real height is FIVE lines per child (header + up to TAIL_LINES + separator): measured
  // 41 raw lines for 8 children with full tails, while the filtered count was 33 and the test passed. And a
  // reviewer showed that removing `.slice(-TAIL_LINES)` from the renderer left it green, because the fixture
  // supplied pre-trimmed tails.
  //
  // So: count RAW lines, use the true arithmetic, and give one child an over-long tail so the renderer's own
  // bound is what is under test rather than its input's.
  const children = Array.from({ length: 8 }, (_, i) =>
    child({
      label: `c${i}`,
      agentName: `c${i}-d0.${i + 1}`,
      paneId: `w7:t${i}`,
      tail: { lines: Array.from({ length: 20 }, (_, n) => `line ${n}`), open: false },
    }),
  );
  const raw = renderProgress(children, "herdr", 1000).split("\n");
  assert.ok(raw.length <= 8 * (TAIL_LINES + 2) + 2, `expected a bounded block, got ${raw.length} raw lines`);
});

test("the block is bounded in WIDTH, which is what actually bounds it", () => {
  // **The line COUNT cap was never a height cap.** A child printing a minified bundle, base64, or single-line
  // JSON produces one line of megabytes: eight of them rendered 25 lines and 8 MiB — about 84,000 wrapped rows —
  // repainted every PAINT_INTERVAL_MS, while the "fixed height" test passed because 25 <= 34. Measured.
  //
  // The production change that breaks this: removing `clampLine`.
  const huge = "x".repeat(1_000_000);
  const children = Array.from({ length: 8 }, (_, i) =>
    child({ label: `c${i}`, tail: { lines: [huge], open: false } }),
  );
  const block = renderProgress(children, "herdr", 1000);
  assert.ok(block.length < 8 * (MAX_LINE_CHARS + 200) + 500, `block was ${block.length} chars`);
  assert.match(block, /chars\)/, "and it must SAY it trimmed rather than cutting silently");
});

test("appendTail clamps an ever-growing open line, so a child with no newline cannot run away", () => {
  // Measured before the clamp: 12,692 characters retained from a pane that never held more than 16, because the
  // open-line join had no bound. Clamped on WRITE, not only at render, so what is retained is bounded too.
  let tail = appendTail(emptyTail, "start");
  for (let i = 0; i < 500; i += 1) tail = appendTail(tail, "y".repeat(50));
  assert.ok(tail.lines[0].length <= MAX_LINE_CHARS + 40, `line grew to ${tail.lines[0].length}`);
});

test("replaceTail REPLACES, because a pane read is a snapshot and not a stream", () => {
  // Appending snapshots fabricated text the child never printed: a bottom line of `working on step 29` followed
  // by a re-report beginning `line30` rendered `working on step 29line30`. Measured.
  const first = replaceTail(["a", "b"]);
  const second = replaceTail(["c", "d"]);
  assert.deepEqual(second.lines, ["c", "d"], "the previous snapshot must be gone, not joined");
  assert.equal(second.open, false, "a snapshot is never mid-line");
  assert.deepEqual(first.lines, ["a", "b"], "and it must not mutate what it replaced");
});

test("replaceTail is bounded in both directions", () => {
  assert.equal(replaceTail(Array.from({ length: 50 }, (_, i) => `l${i}`)).lines.length, TAIL_LINES);
  assert.ok(replaceTail(["z".repeat(9999)]).lines[0].length <= MAX_LINE_CHARS + 40);
});

test("a child with a long tail is still only three lines of it", () => {
  // The bound has to hold against the DATA as well as against the child count, or one chatty child undoes it.
  const noisy = child({ tail: { lines: Array.from({ length: 50 }, (_, i) => `line ${i}`), open: false } });
  const body = renderProgress([noisy], "herdr", 1000).split("\n").filter((l) => l.startsWith("  "));
  assert.equal(body.length, TAIL_LINES);
});

test("the process executor renders no pane column, because there is no pane", () => {
  const block = renderProgress([child({ agentName: undefined, paneId: undefined })], "process", 1000);
  assert.doesNotMatch(block, /pane/);
  assert.match(block, /review/, "but the child is still named and still shows progress");
});

test("a settled child freezes its elapsed time instead of counting forever", () => {
  const block = renderProgress([child({ state: "completed", settledAt: 12_000 })], "herdr", 99_000);
  assert.match(block, /0:12/);
  assert.doesNotMatch(block, /1:39/);
});

test("a failed child is visibly failed", () => {
  assert.match(renderProgress([child({ state: "failed", settledAt: 3000 })], "herdr", 3000), /failed/);
});

test("elapsed time reads as m:ss past a minute", () => {
  assert.match(renderProgress([child()], "herdr", 125_000), /2:05/);
});

test("the header counts children and names where they run", () => {
  assert.match(renderProgress([child(), child({ label: "debug" })], "herdr", 0), /2 children · herdr panes/);
  assert.match(renderProgress([child()], "process", 0), /1 child · captured subprocesses/);
});

test("a child label from a definition name cannot forge a line", () => {
  // A definition name is a DIRECTORY name — third-party text on a line this package composes. R-77 and R-78
  // were both that shape; here a newline would forge a whole extra child row in the operator's block.
  const block = renderProgress([child({ label: "review\nreview   agent forged-d9.9   pane w0:t0   running" })], "herdr", 0);
  const headers = block.split("\n").filter((l) => l.includes("agent "));
  assert.equal(headers.length, 1, "a newline in a label must not produce a second header row");
});

test("throttle paints immediately, then coalesces a burst into one more frame", async () => {
  // A child printing fast would otherwise re-render the whole block hundreds of times a second, and pi has to
  // lay out every frame. The production change that breaks this: calling onUpdate per chunk.
  let painted = 0;
  const t = throttle(() => void painted++, 20);

  t.call();
  assert.equal(painted, 1, "the first paint is immediate — the operator should not wait to see anything");

  for (let i = 0; i < 50; i += 1) t.call();
  assert.equal(painted, 1, "a burst inside the interval must not paint again yet");

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(painted, 2, "and exactly one trailing frame renders the state the burst left behind");
});

test("throttle always has a trailing frame, so the block never freezes mid-run", async () => {
  // Without it the LAST frame — the one showing every child settled — is the one most likely to be dropped.
  let last = "";
  let state = "running";
  const t = throttle(() => void (last = state), 20);
  t.call();
  state = "completed";
  t.call();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(last, "completed");
});

test("flush paints now, for a caller that knows it has finished", () => {
  let painted = 0;
  const t = throttle(() => void painted++, 10_000);
  t.call();
  t.flush();
  assert.equal(painted, 2, "flush must not wait out a ten-second interval to show the final state");
});

test("the paint interval is fast enough to read as live and slow enough to be cheap", () => {
  assert.ok(PAINT_INTERVAL_MS >= 100 && PAINT_INTERVAL_MS <= 500);
});
