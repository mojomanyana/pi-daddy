import { createHash, randomUUID } from "node:crypto";
import {
  atomicMetadata,
  leasePaths,
  readMetadata,
  type LeaseMetadata,
  type LeaseReleaseOutcome,
  type WorkspaceLease,
} from "./lease-record.ts";
export type { LeaseReleaseOutcome, WorkspaceLease } from "./lease-record.ts";
import { once } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GovernanceRefusal, refusal } from "./refusals.ts";
import type { ValidatedWorkspace, WorkspaceAccess } from "./workspace.ts";
import { HELPER_SOURCE, LEASE_READY, unrefStream } from "./lease-helper.ts";

export const ENV_WORKSPACE_LEASE_DIR = "PI_GRANTS_WORKSPACE_LEASE_DIR";

export function defaultWorkspaceLeaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return env[ENV_WORKSPACE_LEASE_DIR] ?? join(agentDir, "pi-daddy", "workspace-leases");
}


/**
 * The ledger outcome for a release. Exported because call sites had their own copies and the check runner's
 * asserted `released` unconditionally — reproducing in the evidence path the exact defect this union was
 * added to expose (R-100/R-103).
 *
 * **It is NOT the only definition, and saying so here was wrong.** `extensions/workspace-runtime.ts` keeps a
 * private copy with no `not-held` arm, and it is the one the whole delegation path uses — so releasing a
 * *read* lease on a delegated child is still recorded `released`, a handover the kernel never performed.
 * Measured; open as R-141; the sentence claiming a single definition survived two review passes because
 * `test/workspace.test.ts` pins the `not-held` arm on THIS function, which no delegation path calls.
 */
export function leaseReleaseLedgerOutcome(
  outcome: LeaseReleaseOutcome | "retained",
  reason: string,
): "timeout" | "released" | "released-unrecorded" | "lost" | "retained" | "uncontended" {
  if (outcome === "retained") return "retained";
  if (outcome === "lost") return "lost";
  if (outcome === "released-unrecorded") return "released-unrecorded";
  if (outcome === "not-held") return "uncontended";
  // `released-superseded` is a clean handover as far as the ledger is concerned: the lock went back and the
  // record is correct — it just belongs to somebody else now.
  return reason === "timeout" ? "timeout" : "released";
}

/**
 * `acquired` must mean the kernel actually excluded somebody. A read lease takes no lock (R-105), and an
 * unreadable predecessor record is not proof of a crash (R-100) — so neither may be reported as one.
 */
export function leaseAcquisitionOutcome(
  access: "read" | "write",
  recovered: boolean | "unknown",
): "acquired" | "uncontended" | "recovered" {
  if (access === "read") return "uncontended";
  return recovered === true ? "recovered" : "acquired";
}

export async function acquireWorkspaceLease(input: {
  workspace: ValidatedWorkspace;
  access: WorkspaceAccess;
  leaseDir: string;
  ownerId: string;
  signal?: AbortSignal;
  flockCommand?: string;
  acquisitionTimeoutMs?: number;
  /**
   * Bound on how long ONE `herdr tab close` attempt may take before it counts as failed (R-146). A hung
   * herdr is not a failed herdr: without this the attempt never returns and the retry bound below is
   * unreachable.
   */
  herdrCloseTimeoutMs?: number;
  /** Bound on the helper's `herdr tab close` retries before it releases the lock anyway (R-102). */
  herdrCloseAttempts?: number;
}): Promise<WorkspaceLease> {
  if (input.access === "read") {
    return {
      workspace: input.workspace,
      access: "read",
      ownerId: input.ownerId,
      recovered: false,
      attachProcess: () => {},
      attachHerdrTab: () => {},
      markRetained: async () => {},
      readCloseFailure: async () => null,
      lost: new Promise(() => {}),
      // No kernel lock was ever taken, so there is no handover to claim (R-105, release side).
      release: async () => "not-held",
    };
  }
  if (input.signal?.aborted) {
    throw new GovernanceRefusal(refusal("WORKSPACE_WRITE_CONFLICT", `writer lease for ${input.workspace.workspaceId} was cancelled before acquisition`));
  }

  /**
   * **A bound that is not a bound is refused rather than accepted (R-146, rule 8).** `herdrCloseTimeoutMs: 0`
   * reads as "no limit" and Node agrees — `execFile` treats `timeout: 0` as *no timeout* (measured: the
   * callback arrives only when the child finishes, 3004ms for a 3s sleep), which silently reinstates the
   * unbounded hang this bound exists to prevent. Negatives behave identically. `herdrCloseAttempts: 0` is
   * milder and equally not what a caller means by it. Both refusals name the parameter, because the callers
   * are ADR-0034 external controllers passing values this package never chose.
   */
  for (const [name, value] of [
    ["herdrCloseTimeoutMs", input.herdrCloseTimeoutMs],
    ["herdrCloseAttempts", input.herdrCloseAttempts],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 1) {
      throw new GovernanceRefusal(refusal(
        "WORKSPACE_LEASE_STALE",
        `${name} must be a finite number of at least 1, not ${String(value)} — a zero or negative bound is ` +
          `not "no limit", it is no bound, and this one exists so a hung herdr cannot hold the writer lock ` +
          `forever (R-146)`,
        { workspace_id: input.workspace.workspaceId, root: input.workspace.root },
      ));
    }
  }

  await mkdir(input.leaseDir, { recursive: true, mode: 0o700 });
  const paths = leasePaths(input.leaseDir, input.workspace.root);
  const { spawn } = await import("node:child_process");
  const holder = spawn(input.flockCommand ?? "flock", [
    "--exclusive", "--nonblock", "--conflict-exit-code", "73", paths.lock,
    process.execPath, "--input-type=module", "-e", HELPER_SOURCE,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_DADDY_LEASE_MARKER: paths.marker,
      PI_DADDY_LEASE_CLOSE_ATTEMPTS: String(input.herdrCloseAttempts ?? 10),
      PI_DADDY_LEASE_CLOSE_TIMEOUT_MS: String(input.herdrCloseTimeoutMs ?? 15_000),
    },
    // Own process group, for two reasons. It lets teardown kill `flock` AND the helper holding the lock
    // file descriptor as one unit even before the helper has reported its pid (R-99), and it stops a
    // stray group signal — a terminal Ctrl-C, a closed window — from releasing a live writer's lock as
    // a side effect.
    detached: true,
  });

  const timeoutMs = input.acquisitionTimeoutMs ?? 2000;
  let ready = false;
  let helperPid: number | undefined;
  let stderr = "";
  /**
   * Kill the whole holder GROUP — one signal, no ordering. (The pid-by-pid fallback below is the
   * only path that kills in sequence, and only when the group is already reaped.) `flock` does not pass `--close`, so the helper inherits
   * the lock file descriptor and holds the lock in its own right — killing only `flock` leaves the
   * lock HELD by an orphan, and every later acquisition then reports WORKSPACE_WRITE_CONFLICT, which
   * is the one message an operator would use to conclude another agent is writing. Measured in
   * `docs/probes/g35-flock-fd-inheritance` (R-99).
   */
  const hardKill = () => {
    // The GROUP, so this works on the readiness-timeout path too — there `helperPid` is usually still
    // unknown, and killing only the wrapper leaves a half-booted helper free to inherit the lock file
    // descriptor and hold it forever. Fall back to individual pids if the group is already reaped.
    if (holder.pid !== undefined) {
      try { process.kill(-holder.pid, "SIGKILL"); return; } catch { /* group gone */ }
    }
    if (Number.isInteger(helperPid)) {
      try { process.kill(helperPid!, "SIGKILL"); } catch { /* already gone */ }
    }
    holder.kill("SIGKILL");
  };
  holder.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new GovernanceRefusal(refusal(
        "WORKSPACE_LEASE_STALE", `writer lease helper did not become ready within ${timeoutMs}ms`,
      ))), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => rejectReady(new GovernanceRefusal(refusal(
        "WORKSPACE_WRITE_CONFLICT", `writer lease for ${input.workspace.workspaceId} was cancelled before acquisition`,
      )));
      input.signal?.addEventListener("abort", onAbort, { once: true });
      holder.once("error", (error) => {
        cleanup();
        rejectReady(new GovernanceRefusal(refusal(
          "WORKSPACE_LEASE_STALE", `workspace writer leases require a working flock command (${String(error)})`,
        )));
      });
      holder.once("close", (code) => {
        if (ready) return;
        cleanup();
        const codeName = code === 73 ? "WORKSPACE_WRITE_CONFLICT" : "WORKSPACE_LEASE_STALE";
        rejectReady(new GovernanceRefusal(refusal(
          codeName,
          code === 73
            ? `workspace ${input.workspace.workspaceId} already has an active pi-daddy-governed writer`
            : `workspace lease helper exited before acquisition${stderr ? ` (${stderr.trim()})` : ""}`,
          { workspace_id: input.workspace.workspaceId, root: input.workspace.root },
        )));
      });
      holder.stdout?.on("data", (chunk) => {
        const output = String(chunk);
        if (!output.includes(LEASE_READY) || ready) return;
        helperPid = Number(output.match(new RegExp(`${LEASE_READY}:(\\d+)`))?.[1]);
        ready = true;
        cleanup();
        resolveReady();
      });
    });
  } catch (error) {
    hardKill();
    throw error;
  }

  const previous = await readMetadata(paths.metadata);
  // "malformed" is not "no prior owner": an unreadable record cannot prove a clean handover (R-100).
  const recovered: boolean | "unknown" = previous === "malformed" ? "unknown" : previous?.state === "active";
  const token = randomUUID();
  const metadata: LeaseMetadata = {
    version: 1,
    state: "active",
    token,
    owner_id: input.ownerId,
    workspace_id: input.workspace.workspaceId,
    root: input.workspace.root,
    pid: Number.isInteger(helperPid) ? helperPid! : (holder.pid ?? process.pid),
    acquired_at: new Date().toISOString(),
  };
  try {
    await atomicMetadata(paths.metadata, metadata);
  } catch (error) {
    holder.stdin?.end();
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_LEASE_STALE", `acquired the kernel writer lock but could not record its owner (${String(error)})`,
      { workspace_id: input.workspace.workspaceId, root: input.workspace.root },
    ));
  }

  // TWO variables, deliberately. `releasing` goes up the instant release begins, because the handshake
  // below closes the helper on purpose — and if `lost` could still fire during it, an intentional release
  // would report itself as a lost lease. `settled` memoizes the ANSWER, so a second call cannot invent a
  // clean handover. Collapsing these into one flag set at the end broke every check-runner test.
  let releasing = false;
  let settled: LeaseReleaseOutcome | undefined;
  let lose!: (error: Error) => void;
  const lost = new Promise<Error>((resolveLost) => { lose = resolveLost; });
  const lostError = () => new Error(`workspace writer lease helper exited for ${input.workspace.workspaceId}`);
  holder.once("close", () => { if (!releasing) lose(lostError()); });
  if (holder.exitCode !== null || holder.signalCode !== null) queueMicrotask(() => lose(lostError()));
  const attach = (value: { process_pid: number } | { herdr_tab: string }) => {
    if (releasing || holder.exitCode !== null || holder.signalCode !== null || !holder.stdin?.writable) {
      throw new GovernanceRefusal(refusal(
        "WORKSPACE_LEASE_STALE", `writer lease for ${input.workspace.workspaceId} was lost before child attachment`,
      ));
    }
    holder.stdin.write(`${JSON.stringify(value)}\n`);
  };
  return {
    workspace: input.workspace,
    access: "write",
    ownerId: input.ownerId,
    recovered,
    attachProcess(pid) { attach({ process_pid: pid }); },
    attachHerdrTab(tabId) { attach({ herdr_tab: tabId }); },
    lost,
    async markRetained(reason = "retained") {
      // Deliberately does NOT touch the kernel lock or the helper: the pane may still be live. It only
      // stops the record from looking like a crash.
      const current = await readMetadata(paths.metadata);
      if (current !== "malformed" && current?.token === token) {
        await atomicMetadata(paths.metadata, {
          ...metadata, state: "released", released_at: new Date().toISOString(), release_reason: `retained:${reason}`,
        }).catch(() => undefined);
      }
      /**
       * **It must, however, let THIS process exit (R-146).** Leaving the helper alone is the decision;
       * leaving the parent's three pipes and the child handle referenced was an accident, and it meant a
       * retained lease wedged its own process forever — measured `exit=124` against `exit=0` for the same
       * sequence ending in `release()`.
       *
       * **Which hosts it actually wedged, corrected after review.** `process.exit()` runs `exit` handlers and
       * ignores pending handles, so this only bites a host that lets the loop drain: pi's **print** mode sets
       * `process.exitCode` and returns (`dist/main.js`), and a library consumer — an ADR-0034 external
       * controller calling this package directly — does the same. pi's interactive and rpc modes call
       * `process.exit()` explicitly (`dist/modes/interactive/interactive-mode.js:3148`), so there the process
       * still leaves and `pane-reaper`'s `process.once("exit")` sweep still runs. An earlier version of this
       * comment claimed the sweep was lost generally and cited `src/cli.ts`, which has one subcommand
       * (`init`) and can neither hold a lease nor open a pane.
       *
       * Unref rather than close, because the lock must outlive this call: when the parent does exit, the
       * helper sees EOF and runs the path it was written for — bounded `herdr tab close` attempts, a marker
       * file, then release anyway (R-102: an unreleasable lock strands a worktree with no in-product
       * recovery, which is strictly worse than a recorded failure to close). Narrowed to this path on
       * purpose: at spawn it would remove the accidental guarantee that a process cannot exit while a lease
       * is still ACTIVE, which is a different decision and not this fix.
       */
      /**
       * **Terminal (R-146).** `releasing` stops a late `holder.close` being reported as a lost lease, and
       * `settled` stops a later `release()` running the clean handshake — which it did: measured, it returned
       * `released`, overwrote `retained:herdr-close-failed` with `completed`, and sent `{release:true}` so the
       * helper exited `clean` and never attempted the close. The pane retention exists to protect was
       * abandoned silently, and the ledger asserted a clean handover for a lease kept *because* a pane would
       * not close. No in-tree caller does this — but `WorkspaceLease` is a public export and
       * `try { … } finally { await lease.release() }` is the obvious shape for the external controllers this
       * whole fix is for.
       */
      releasing = true;
      settled = "retained";
      holder.unref();
      unrefStream(holder.stdout);
      unrefStream(holder.stderr);
    },
    async readCloseFailure() {
      try {
        return JSON.parse(await readFile(paths.marker, "utf8")) as { reason: string; herdr_tab?: string };
      } catch {
        return null;
      }
    },
    async release(reason = "completed"): Promise<LeaseReleaseOutcome> {
      // Memoized, not a boolean. A second call used to answer "released" whatever the first returned, so a
      // retry — or a `finally` after an explicit release — read a clean handover that never happened.
      if (settled) return settled;
      releasing = true;
      // Already gone: this owner never released anything, and saying so is the caller's business to
      // record. Throwing here discarded completed work and masked the real error (R-99).
      if (holder.exitCode !== null || holder.signalCode !== null) return (settled = "lost");

      // Default FALSE: "recorded" must mean this owner actually wrote its own handover. Anything else —
      // an unreadable record, or a successor's token in place of ours — means the lock goes back but the
      // record does not say so, and the NEXT owner will report a recovery that never happened unless the
      // caller ledgers it (R-100). Only the current token may mark the handover, so a stale lease object
      // can never overwrite a live successor.
      // Three outcomes, because they call for three different responses: we wrote our handover; a
      // successor already owns the record and we correctly left it alone; or the record is unreadable or
      // unwritable and somebody has to be told.
      let how: LeaseReleaseOutcome = "released-unrecorded";
      const current = await readMetadata(paths.metadata);
      if (current !== "malformed" && current?.token === token) {
        try {
          await atomicMetadata(paths.metadata, {
            ...metadata,
            state: "released",
            released_at: new Date().toISOString(),
            release_reason: reason,
          });
          how = "released";
        } catch {
          how = "released-unrecorded";
        }
      } else if (current !== "malformed" && current !== null) {
        // A live successor's record. Declining to overwrite it is the token guard working, not a fault.
        how = "released-superseded";
      }

      holder.stdin?.write(`${JSON.stringify({ release: true })}\n`);
      holder.stdin?.end();
      if (holder.exitCode === null && holder.signalCode === null) {
        await Promise.race([once(holder, "close"), new Promise((resolveWait) => setTimeout(resolveWait, 1000))]);
      }
      // The helper holds the lock fd in its own right, so the wrapper alone is not enough (R-99).
      if (holder.exitCode === null && holder.signalCode === null) hardKill();
      return (settled = how);
    },
  };
}
