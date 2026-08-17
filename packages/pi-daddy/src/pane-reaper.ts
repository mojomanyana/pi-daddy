/**
 * Close herdr panes this process opened but never got to close.
 *
 * `runHerdrPane` closes its pane in a `finally`, which covers a thrown error and a timeout — **not the
 * process being killed**. A pi session interrupted mid-fan-out left one pane per in-flight child, and
 * `docs/probes/g16-herdr` records that an orphaned pane is not trivially closable afterwards.
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
  /** Agent name, so the agent is stopped before its tab goes away. */
  name: string;
  /** Staged system-prompt directory, removed with the pane it belonged to. */
  promptDir?: string;
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
    try {
      syncExec(["agent", "stop", pane.name]);
    } catch {
      /* the agent may already be gone; the tab is what matters */
    }
    try {
      syncExec(["tab", "close", pane.tab]);
      closed.push(pane.tab);
    } catch {
      /* an orphan we could not close: `herdr tab close` is the manual remedy, as documented above */
    }
    if (pane.promptDir) {
      try {
        rmSync(pane.promptDir, { recursive: true, force: true });
      } catch {
        /* /tmp litter, not correctness */
      }
    }
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
  await exec(["agent", "stop", pane.name]).catch(() => undefined);
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
  const excess = open.size - MAX_OPEN_PANES;
  if (excess <= 0) return [];
  const closed: string[] = [];
  for (const pane of [...open.values()].slice(0, excess)) {
    if (await closePane(exec, pane)) closed.push(pane.tab);
  }
  return closed;
}
