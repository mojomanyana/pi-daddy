/**
 * **The lock helper: a separate program, and the parent's side of its pipes.**
 *
 * Split out of `workspace-lease.ts` because `test/file-size.test.ts` refused that file — at 405 lines on the
 * ADR-0035 branch when PR #14 merged into it, and at 435 here once R-152's guards landed. Both branches take
 * the same seam so they converge rather than diverge, and the cap has never been raised: `delegate.ts` was
 * split at 413 the same way (rule: when a guard fails, obey it).
 *
 * The seam is not arbitrary. Everything here concerns the process that HOLDS the kernel lock — the source it
 * runs, the readiness token it prints, and the parent-side handles that keep it referenced.
 * `workspace-lease.ts` keeps the lease lifecycle that talks to it.
 */

export const LEASE_READY = "PI_DADDY_LEASE_READY";
// The lock holder also owns crash cleanup for the governed child. If the parent dies, stdin closes;
// the helper signals the attached process, or closes the herdr tab, before releasing flock. A raw
// descendant deliberately detached by bash remains ADR-0012's OS-containment boundary, not a lease
// guarantee. The process branch SIGTERMs, escalates to SIGKILL at +500ms, and releases at +750ms
// WITHOUT confirming death (R-101). The herdr branch retries `tab close` a BOUNDED number of times
// and then releases anyway, leaving a marker file: an unreleasable lock strands a worktree forever
// with no in-product recovery, which is strictly worse than a recorded failure to close (R-102).
//
// **Each attempt is bounded in WALL CLOCK, not just in count (R-146).** `execFile` with no `timeout`
// never calls back if `herdr` accepts the close and does not answer, so the retry counter never
// decrements, `giveUp` never runs and no marker is written — the lock is held forever. That was masked
// while the parent could not exit, because the operator saw a hung `pi` instead; measured with a `herdr`
// that sleeps, the parent then exited in 82ms and left a silent strand, which is R-102's rejected outcome
// reached quietly. A bound on retries is not a bound on time.
export const HELPER_SOURCE = `
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
let clean=false, target=null, buffered="";
process.stdout.write(${JSON.stringify(`${LEASE_READY}:`)}+process.pid+"\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{buffered+=chunk;for(;;){const i=buffered.indexOf("\\n");if(i<0)break;const line=buffered.slice(0,i);buffered=buffered.slice(i+1);try{const value=JSON.parse(line);if(value.release)clean=true;else if(value.process_pid)target={process_pid:value.process_pid};else if(value.herdr_tab)target={herdr_tab:value.herdr_tab};}catch{}}});
process.stdin.on("end",()=>{if(clean||!target)return process.exit(0);if(target.process_pid){try{process.kill(target.process_pid,"SIGTERM")}catch{return process.exit(0)}setTimeout(()=>{try{process.kill(target.process_pid,"SIGKILL")}catch{}},500);return setTimeout(()=>process.exit(0),750);}let left=Number(process.env.PI_DADDY_LEASE_CLOSE_ATTEMPTS||10);const giveUp=last=>{try{if(process.env.PI_DADDY_LEASE_MARKER)writeFileSync(process.env.PI_DADDY_LEASE_MARKER,JSON.stringify({reason:last&&(last.killed||last.signal==="SIGKILL")?"herdr-close-timeout":"herdr-close-failed",herdr_tab:target.herdr_tab})+"\\n")}catch{}process.exit(0)};const close=()=>execFile("herdr",["tab","close",target.herdr_tab],{timeout:Number(process.env.PI_DADDY_LEASE_CLOSE_TIMEOUT_MS||15000),killSignal:"SIGKILL"},error=>{if(!error)return process.exit(0);if(--left<=0)return giveUp(error);setTimeout(close,1000)});close();});
process.stdin.resume();`;

/**
 * `unref` the parent's end of one of the helper's pipes.
 *
 * A spawned pipe is a `net.Socket`, which has `unref`; `ChildProcess.stdin` is typed `Writable`, which does
 * not. Hence the narrow cast. The optional call is **defensive, not load-bearing** — the holder is spawned at
 * exactly one site with three pipes, so none of these is ever `null`, and an earlier version of this comment
 * claimed otherwise by citing a `stdio: "ignore"` caller that does not exist.
 *
 * Only `stdout` and `stderr` are unref'ed. `stdin` was too, until a line-by-line reversion showed the suite
 * stayed green without it — an unforced line inside the fix that exists to be forced, which is exactly the
 * shape R-122 was about.
 */
export const unrefStream = (stream: unknown): void => {
  (stream as { unref?: () => void } | null)?.unref?.();
};

/**
 * The bounds on the helper's `herdr tab close` attempts live here, with the attempts they bound — moved out of
 * `workspace-lease.ts` when the line ceiling refused it at 402 lines, once both this branch's ADR-0035 work and
 * `main`'s R-152 guards had landed in it. Third time that guard has fired on this file and third time the
 * answer was a seam rather than a bigger cap.
 */
/**
 * **A bound that is not a bound throws, and it throws a `RangeError` (R-146, R-152).**
 *
 * Both ends fail, in opposite directions and both silently:
 *
 *  - `0` reads as "no limit" and Node agrees — `execFile` treats `timeout: 0` as *no* timeout (measured: the
 *    callback for a 3s sleep arrives at 3004ms with no error), reinstating the unbounded hang the bound exists
 *    to prevent. Negatives behave identically.
 *  - anything above `2^31 - 1` truncates: `setTimeout` warns `TimeoutOverflowWarning … set to 1`, so
 *    `Number.MAX_SAFE_INTEGER` — the plausible "effectively no limit" sentinel, given the argument about `0`
 *    — SIGKILLs every `herdr tab close` after 1ms, before herdr can act. Measured: callback at 3ms.
 *
 * **Not a `GovernanceRefusal`.** It was one, carrying `WORKSPACE_LEASE_STALE`, which everywhere else in this
 * package means *the lease went stale or was lost* — so an ADR-0034 controller switching on codes (the reason
 * codes exist, R-103) would classify a permanent caller bug as transient and retry a call that can never
 * succeed. A refusal is a governance outcome that gets ledgered; a bad argument is neither.
 *
 * Checked for read leases too, which the first version did not: it sat below the read-lease early return, so a
 * controller smoke-testing its configuration against a read lease got a false all-clear.
 */
export const assertCloseBounds = (input: { herdrCloseTimeoutMs?: number; herdrCloseAttempts?: number }): void => {
  const MAX_TIMER = 2_147_483_647;
  for (const [name, value, ceiling] of [
    ["herdrCloseTimeoutMs", input.herdrCloseTimeoutMs, MAX_TIMER],
    ["herdrCloseAttempts", input.herdrCloseAttempts, Number.MAX_SAFE_INTEGER],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1 || value > ceiling) {
      throw new RangeError(
        `${name} must be a whole number between 1 and ${ceiling}, not ${String(value)}. Zero and negatives ` +
          `are not "no limit" but no bound at all, a value past ${MAX_TIMER} truncates to 1ms, and a ` +
          `fractional count is not a count — this bound exists so a hung herdr cannot hold the writer lock ` +
          `forever (R-146).`,
      );
    }
  }
};
