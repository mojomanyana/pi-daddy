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

export const ENV_WORKSPACE_LEASE_DIR = "PI_GRANTS_WORKSPACE_LEASE_DIR";

export function defaultWorkspaceLeaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return env[ENV_WORKSPACE_LEASE_DIR] ?? join(agentDir, "pi-daddy", "workspace-leases");
}

const LEASE_READY = "PI_DADDY_LEASE_READY";
// The lock holder also owns crash cleanup for the governed child. If the parent dies, stdin closes;
// the helper signals the attached process, or closes the herdr tab, before releasing flock. A raw
// descendant deliberately detached by bash remains ADR-0012's OS-containment boundary, not a lease
// guarantee. The process branch SIGTERMs, escalates to SIGKILL at +500ms, and releases at +750ms
// WITHOUT confirming death (R-101). The herdr branch retries `tab close` a BOUNDED number of times
// and then releases anyway, leaving a marker file: an unreleasable lock strands a worktree forever
// with no in-product recovery, which is strictly worse than a recorded failure to close (R-102).
const HELPER_SOURCE = `
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
let clean=false, target=null, buffered="";
process.stdout.write(${JSON.stringify(`${LEASE_READY}:`)}+process.pid+"\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{buffered+=chunk;for(;;){const i=buffered.indexOf("\\n");if(i<0)break;const line=buffered.slice(0,i);buffered=buffered.slice(i+1);try{const value=JSON.parse(line);if(value.release)clean=true;else if(value.process_pid)target={process_pid:value.process_pid};else if(value.herdr_tab)target={herdr_tab:value.herdr_tab};}catch{}}});
process.stdin.on("end",()=>{if(clean||!target)return process.exit(0);if(target.process_pid){try{process.kill(target.process_pid,"SIGTERM")}catch{return process.exit(0)}setTimeout(()=>{try{process.kill(target.process_pid,"SIGKILL")}catch{}},500);return setTimeout(()=>process.exit(0),750);}let left=Number(process.env.PI_DADDY_LEASE_CLOSE_ATTEMPTS||10);const giveUp=()=>{try{if(process.env.PI_DADDY_LEASE_MARKER)writeFileSync(process.env.PI_DADDY_LEASE_MARKER,JSON.stringify({reason:"herdr-close-failed",herdr_tab:target.herdr_tab})+"\\n")}catch{}process.exit(0)};const close=()=>execFile("herdr",["tab","close",target.herdr_tab],error=>{if(!error)return process.exit(0);if(--left<=0)return giveUp();setTimeout(close,1000)});close();});
process.stdin.resume();`;

/**
 * The ledger outcome for a release. ONE definition, exported, because two call sites had their own copies
 * and the check runner's copy asserted `released` unconditionally — reproducing in the evidence path the
 * exact defect this union was added to expose (R-100/R-103).
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

  await mkdir(input.leaseDir, { recursive: true, mode: 0o700 });
  const paths = leasePaths(input.leaseDir, input.workspace.root);
  const { spawn } = await import("node:child_process");
  const holder = spawn(input.flockCommand ?? "flock", [
    "--exclusive", "--nonblock", "--conflict-exit-code", "73", paths.lock,
    process.execPath, "--input-type=module", "-e", HELPER_SOURCE,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_DADDY_LEASE_MARKER: paths.marker, PI_DADDY_LEASE_CLOSE_ATTEMPTS: String(input.herdrCloseAttempts ?? 10) },
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
