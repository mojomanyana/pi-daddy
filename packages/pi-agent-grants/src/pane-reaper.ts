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

export interface OpenPane {
  /** herdr tab id — what `tab close` takes. */
  tab: string;
  /** Agent name, so the agent is stopped before its tab goes away. */
  name: string;
  /** Staged system-prompt directory, removed with the pane it belonged to. */
  promptDir?: string;
}

/** Panes opened by THIS process and not yet closed. Keyed by tab id, so a double close is impossible. */
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
