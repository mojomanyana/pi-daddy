/**
 * Close herdr panes this process opened but never got to close.
 *
 * **As of ADR-0032 a pane belongs to the AGENT RUN, not to the tool call.** `runHerdrPane` closes a tab only for
 * a child that did *not* settle — closing the tab is the only kill herdr offers, so a child still working must
 * lose its pane. A child that answered keeps its pane so a human can read it, and this module reaps those: at
 * `agent_settled` (async) and at process `exit` (sync backstop).
 *
 * The gap that remains is the one this module was created for. A pi session **killed outright** runs no `exit`
 * handler, so it leaves one pane per tracked child, and `docs/probes/g16-herdr` records that an orphaned pane is
 * not trivially closable afterwards. R-62 was re-rated L×L → M×L when ADR-0031 made panes the default path.
 *
 * **Registered on `exit` only, deliberately — not on SIGINT or SIGTERM.** That is the part worth reading,
 * because the obvious fix is the dangerous one. Adding a signal listener *suppresses Node's default
 * termination*, so a library that adds one takes over an application-level decision it has no standing to
 * make: pi uses SIGINT to interrupt a turn, and a listener here that re-raised would turn "cancel this
 * delegation" into "exit pi". A governance package quietly changing the host's interrupt semantics is a
 * worse defect than the leak it fixes, and it would land on **every** session rather than the opt-in ones.
 *
 * So the coverage is exact and stated rather than implied:
 *
 *  - **Covered:** normal exit, `process.exit()`, an uncaught exception that unwinds to the default handler.
 *  - **NOT covered:** SIGKILL, and SIGTERM/SIGINT where nothing else in the process has installed a
 *    listener. Node terminates without running `exit` handlers in those cases, by design. A pane can still
 *    be orphaned there, and `herdr tab close <id>` is the manual remedy.
 *
 * Everything here is **synchronous**, because an `exit` handler is: a promise scheduled there never runs.
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { MAX_CHILDREN_PER_CALL } from "./fanout.ts";
import { defaultExec, parseReply, type HerdrExec } from "./herdr-cli.ts";

/**
 * How many panes may be open at once — ADR-0032.
 *
 * **Derived from `MAX_CHILDREN_PER_CALL` rather than declared, so the two cannot drift.** The bound is not
 * decoration: `delegate_all` is capped per call and the fan-out budget bounds a subtree, but a plain blocking
 * `delegate` spends **nothing** from that budget by design — so thirty sequential `delegate` calls in one agent
 * run would otherwise hold thirty panes open until it settled.
 */
export const MAX_OPEN_PANES = MAX_CHILDREN_PER_CALL;

export interface OpenPane {
  /** herdr tab id — what `tab close` takes. */
  tab: string;
  /** herdr agent name, for diagnostics. There is no `agent stop`, so nothing acts on it — see `closePane`. */
  name: string;
  /** Staged system-prompt directory, removed with the pane it belonged to. */
  promptDir?: string;
  /**
   * True once the child has answered and stopped working.
   *
   * **The trim may only close a pane with this set**, and that is a correctness rule rather than politeness. pi
   * executes tool calls in **parallel** by default, and a plain `delegate` spends nothing from the fan-out
   * budget — so one assistant message can hold `delegate_all(8)` *and* a `delegate`, and the ninth pane's trim
   * used to close the oldest **live sibling**. Measured: two `delegate_all(8)` in one message killed **8 of 16
   * children mid-work**, each reported as "could not be started" with its partial output discarded, while the
   * ledger recorded all sixteen as provisioned. ADR-0032 argued the cap from *sequential* delegates only.
   */
  settled?: boolean;
  /**
   * The operator asked to keep this tab (`PI_GRANTS_HERDR_KEEP_PANE=1`), so no sweep may close it.
   *
   * It is registered anyway, and only for its `promptDir`: that temp dir was otherwise unreachable by either
   * sweep and leaked one directory per kept pane, forever. So `exit` removes the staged prompt and leaves the
   * tab, which is exactly what the flag promises.
   */
  keepTab?: boolean;
}

/** A run has finished with its pane: the trim may now reclaim it. */
export function markPaneSettled(tab: string): void {
  const pane = open.get(tab);
  if (pane) pane.settled = true;
}

/**
 * Panes opened by THIS process and not yet closed. Keyed by tab id, so a double close is impossible.
 *
 * **That keying rests on tab ids being unique, which was measured rather than assumed** (herdr 0.7.5): ids
 * are `w<workspace>:t<counter>`, allocated by the single server, and **not recycled** — creating a tab,
 * closing it, and creating again yields the next counter value, never the freed one. If that ever changed,
 * concurrent panes would collapse into one entry and an early finisher's `untrackPane` would drop a live
 * sibling. Recorded because the hazard is invisible in the code and the precondition lives in another
 * project.
 */
const open = new Map<string, OpenPane>();
let hookInstalled = false;

/** A run has opened a pane. Idempotent per tab, and installs the exit hook on first use only. */
export function trackPane(pane: OpenPane): void {
  open.set(pane.tab, pane);
  if (hookInstalled) return;
  hookInstalled = true;
  // `once`, and only ever one, so a fan-out of eight children does not install eight handlers and trip
  // Node's MaxListenersExceededWarning — which would be this package printing a warning about itself.
  process.once("exit", () => void reapOpenPanes());
}

/** A run closed its own pane the normal way. */
export function untrackPane(tab: string): void {
  open.delete(tab);
}

/** How many panes are currently outstanding — for tests and for `/grants`. */
export function openPaneCount(): number {
  return open.size;
}

/** Per-command wall clock. `SIGKILL` because `timeout` alone is not a bound — see `TOTAL_BUDGET_MS`. */
const PER_CALL_MS = 2000;

/**
 * Total wall clock the whole sweep may add to process exit.
 *
 * **Measured, and the reason this exists.** With eight panes and a hung herdr, a per-call timeout of 5s
 * across two calls per pane is **80 seconds of silent hang at shutdown** — `stdio: "ignore"`, so the process
 * looks wedged with no output. Worse, `timeout` is not a hard bound at all: `spawnSync` sends `SIGTERM` and
 * then waits for the child to actually die, so a process ignoring `SIGTERM` runs to its own completion
 * (measured: a 3s timeout took 59.8s against `trap '' TERM; sleep 60`). Hence `killSignal: "SIGKILL"` **and**
 * a budget across the whole sweep rather than per call.
 *
 * A pane left open because the budget ran out is the failure this whole module downgrades to, and it is the
 * right one: `herdr tab close <id>` is a five-second manual fix, whereas a shell that will not exit is not.
 */
const TOTAL_BUDGET_MS = 6000;

/** Run one herdr command synchronously, swallowing everything: at exit there is nowhere to report. */
const defaultSyncExec = (args: string[]): void => {
  execFileSync("herdr", args, { stdio: "ignore", timeout: PER_CALL_MS, killSignal: "SIGKILL" });
};

/**
 * Close every outstanding pane and return the tab ids closed.
 *
 * Exported and parameterised so it can be tested without herdr installed: the exit hook is unreachable from
 * a test (registering a real `exit` handler would run during the test runner's own shutdown), so the hook is
 * one line and *this* is where the behaviour lives.
 *
 * Failures are swallowed per pane rather than per call — one pane herdr will not close must not strand the
 * other seven, and nothing at exit has anywhere to report to anyway.
 */
export function reapOpenPanes(syncExec: (args: string[]) => void = defaultSyncExec, now = Date.now): string[] {
  const closed: string[] = [];
  const deadline = now() + TOTAL_BUDGET_MS;
  for (const pane of [...open.values()]) {
    // Checked BEFORE each pane rather than after, so the budget bounds what we start, not what we finish.
    // Panes left behind stay in the map; there is no later sweep, and saying so is the honest position —
    // `openPaneCount()` is non-zero afterwards precisely so a caller could report it if it ever wanted to.
    if (now() >= deadline) break;
    // No `agent stop`: it is not a herdr command (see `closePane`). Closing the tab is the kill.
    //
    // A `keepTab` pane is registered only for its staged prompt: remove that and leave the tab alone, which is
    // the whole of what `PI_GRANTS_HERDR_KEEP_PANE=1` promises.
    let closedThisPane = pane.keepTab === true;
    if (pane.keepTab) {
      if (pane.promptDir) {
        try {
          rmSync(pane.promptDir, { recursive: true, force: true });
        } catch {
          /* /tmp litter, not correctness */
        }
      }
      open.delete(pane.tab);
      continue;
    }
    try {
      syncExec(["tab", "close", pane.tab]);
      closed.push(pane.tab);
      closedThisPane = true;
    } catch {
      /* an orphan we could not close: `herdr tab close` is the manual remedy, as documented above */
    }
    // **The staged prompt is deleted only when the tab is provably gone.** It used to be removed
    // unconditionally, so a pane herdr refused to close lost its `--append-system-prompt` file — and pi treats a
    // missing path there as **literal text, with no warning** (`resource-loader.js`: `existsSync` fails, the
    // input is returned). Re-running that pane's echoed argv would hand the child a pathname as its
    // instructions. Litter is cheaper than silently swapping a definition's body for its filename.
    if (closedThisPane && pane.promptDir) {
      try {
        rmSync(pane.promptDir, { recursive: true, force: true });
      } catch {
        /* /tmp litter, not correctness */
      }
    }
    // Untracked either way, and only here: at `exit` there is no later sweep, so keeping an unclosable pane
    // registered buys nothing. `closePane`'s async path deliberately differs — another sweep may still run.
    open.delete(pane.tab);
  }
  return closed;
}

/**
 * Close one tracked pane. Shared by the async sweep and the trim so they cannot disagree about what "closed"
 * means — which is the whole of R-62's lesson, one layer up.
 *
 * Returns whether the tab is **provably** gone. A close herdr refused leaves the pane tracked, so the `exit`
 * handler retries it; untracking on a failed close is what disabled the one control built for that failure.
 */
async function closePane(exec: HerdrExec, pane: OpenPane): Promise<boolean> {
  // **No `agent stop`.** It is not a herdr command — measured against 0.7.5, where it prints the usage banner
  // and exits 0, which `defaultExec` reports as success. Two call sites here and one in `run-herdr.ts` issued it
  // for nothing, and `docs/probes/g16-herdr` asserted it worked from a block that was never run. Closing the tab
  // is the only kill herdr offers, and it does kill the child.
  const reply = await exec(["tab", "close", pane.tab]).catch(() => undefined);
  const closed = reply !== undefined && !parseReply(reply).error;
  if (!closed) return false;
  if (pane.promptDir) await rm(pane.promptDir, { recursive: true, force: true }).catch(() => undefined);
  open.delete(pane.tab);
  return true;
}

/**
 * Close every outstanding pane — the `agent_settled` path (ADR-0032).
 *
 * **A separate function from `reapOpenPanes` rather than a shared implementation**, and the reason is not
 * style. The sync one is `execFileSync` with a six-second total budget *by necessity*: an `exit` handler cannot
 * await. Running that at `agent_settled` would freeze pi for up to six seconds **every time the operator gets
 * their prompt back** — turning a feature that exists to make work visible into a stall.
 *
 * Both drain the same `Map`, keyed by tab id, so a double close is impossible and a pane herdr refused stays
 * registered for whichever sweep runs next.
 *
 * Sequential rather than concurrent: a fan-out's panes are at most `MAX_OPEN_PANES`, and eight `tab close`
 * calls in parallel against one herdr server buys nothing worth the burst.
 */
export async function reapOpenPanesAsync(exec: HerdrExec = defaultExec): Promise<string[]> {
  const closed: string[] = [];
  for (const pane of [...open.values()]) {
    // `keepTab` panes are registered only so their staged prompt can be reaped at `exit`; the tab itself is the
    // operator's to close.
    if (pane.keepTab) continue;
    if (await closePane(exec, pane)) closed.push(pane.tab);
  }
  return closed;
}

/**
 * Keep at most `MAX_OPEN_PANES` open, closing the oldest first.
 *
 * The `Map`'s insertion order **is** the age order, so no timestamp is needed — and that is why `trackPane`
 * must never re-`set` an existing tab, which would move it to the back of the queue and make an old pane look
 * new.
 *
 * Whatever it closes is returned so the caller can **say so** rather than silently dropping a pane the operator
 * was reading (R-48's rule, applied to a display).
 */
export async function trimOpenPanes(exec: HerdrExec = defaultExec): Promise<string[]> {
  if (open.size <= MAX_OPEN_PANES) return [];
  const closed: string[] = [];

  // **Only SETTLED panes are candidates, oldest first.** A live sibling's pane is its child's only terminal, and
  // closing a tab kills the child — see `OpenPane.settled`. If every open pane is live the cap is exceeded and
  // nothing is closed, which is the right failure: a pane too many costs an operator a keystroke, and a killed
  // child costs them the work.
  //
  // **Walks past what it cannot close**, rather than attempting `excess` panes from the front and calling it
  // done. A pane herdr refuses to close used to sit at the head forever, so the cap silently stopped holding
  // (measured: 30 panes for 30 delegates when every close was refused) and the same corpse was re-attacked on
  // every spawn — O(n²) round-trips.
  for (const pane of [...open.values()]) {
    if (open.size - closed.length <= MAX_OPEN_PANES) break;
    if (!pane.settled || pane.keepTab) continue;
    if (await closePane(exec, pane)) closed.push(pane.tab);
  }
  return closed;
}
