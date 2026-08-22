/**
 * **The lock helper: a separate program, and the parent's side of its pipes.**
 *
 * Split out of `workspace-lease.ts` on 2026-08-22 because `test/file-size.test.ts` refused that file at 405
 * lines after PR #14 merged — the same way `delegate.ts` was split at 413 rather than the cap being raised
 * (rule: when a guard fails, obey it). The seam is not arbitrary: everything here is about the process that
 * HOLDS the kernel lock — the source it runs, the readiness token it prints, and the parent-side handles that
 * keep it referenced. `workspace-lease.ts` keeps the lease lifecycle that talks to it.
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
