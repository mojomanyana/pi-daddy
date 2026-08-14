/**
 * One cross-process file lock, used by both files this package writes.
 *
 * **Extracted rather than copied (R-49).** The ledger has had this lock since fan-out made a second writer
 * possible; the approvals store had an unlocked read-modify-write, so session 1 could load, session 2 could
 * revoke, and session 1's next save would **restore the revoked entry** — falsifying a property
 * `approval-store.ts` documents in so many words. The mitigation already existed twenty lines away. A
 * second implementation is how a fix comes to contain a smaller copy of the bug it fixed, which has happened
 * twice in this package (R-38's preview, ADR-0022's republish path), so there is exactly one of these.
 *
 * **The two callers want opposite failure behaviour, and that is the caller's decision, not this module's.**
 * A ledger write that cannot take the lock must fail the delegation closed — a child running with granted
 * capabilities and no audit line is the thing the ledger exists to prevent. An approvals write that cannot
 * take the lock must NOT fail the work: the human already said yes, and the store is a convenience cache
 * (ADR-0020). So this throws `LockTimeoutError`, distinguishable from every other failure, and each caller
 * decides what that means.
 */

import { open, readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** How long to wait for another writer to finish before giving up. Short: failing closed beats hanging. */
export const LOCK_TIMEOUT_MS = 2000;
/** A lock older than this is treated as abandoned by a killed process and broken. */
export const STALE_LOCK_MS = 10_000;

/**
 * Raised only when the wait ran out. Its own type so a caller can tell "somebody else is writing" from
 * "this filesystem rejected the write", which want different messages and, for the approvals store,
 * different outcomes.
 */
export class LockTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} is locked by another writer (waited ${LOCK_TIMEOUT_MS}ms)`);
    this.name = "LockTimeoutError";
  }
}

/**
 * Run `work` while holding an exclusive lock beside `path`.
 *
 * **Why a lock at all.** `O_APPEND` is atomic for one write to a regular file on a POSIX filesystem, and the
 * guarantee does **not** hold on drvfs (`/mnt/c` under WSL2) or NFS — which is exactly where this project
 * runs. The approvals store never had the guarantee anyway: read-modify-write is not one write.
 *
 * **A lock introduces its own failure mode and it is handled deliberately.** A process killed while holding
 * the lock would otherwise block every future write forever, so a lock older than `STALE_LOCK_MS` is broken.
 * Every delete proves ownership first (`removeIfOurs`) — see the token comment in the loop for the two
 * mutual-exclusion breaks that came from not doing so, both reproduced across real OS processes.
 *
 * **What staleness actually measures, stated because it is not what it sounds like.** `STALE_LOCK_MS`
 * compares the lock's mtime to now; it never checks whether the owner is alive. So *any* 10s stall of the
 * holder hands the lock on — a `SIGSTOP`, a laptop suspend, swap thrash, a debugger breakpoint, a long GC
 * pause. Measured on this project's own filesystems, no realistic `work()` comes near it: one ledger append
 * is 0.1ms on ext4 and 21ms on drvfs, and a 10,000-entry `saveApproval` is 30ms / 97ms. Sixteen-way
 * contention raises *waiters'* time, never the holder's — max hold measured at 49ms. So the threshold is
 * two orders of magnitude clear of normal operation and is not guarded against abnormal suspension.
 *
 * The timeout is short *on purpose*: work refused because a file was busy is recoverable and loud, while
 * work that hangs waiting for a lock is neither.
 */
export async function withFileLock<T>(path: string, label: string, work: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    // **A token, and the reason mutual exclusion depends on it (R-67).** `rm(path)` deletes whatever is at
    // the path *now*, not the lock this process created — so the previous version broke its own invariant
    // two ways, both reproduced across real OS processes:
    //
    //  - the stale-break `stat` and `rm` are two awaits, so a process descheduled between them could delete
    //    a LIVE lock another waiter had just created, and then succeed at its own create: two holders;
    //  - worse, the `finally` removed the lock unconditionally. A holder whose lock had been broken out
    //    from under it still freed the NEW owner's lock on the way out — and the damage then propagated to
    //    processes that raced nothing and observed nothing wrong, which is how one break became a chain.
    //
    // Writing a unique token and re-reading it before every delete makes both inexpressible: this process
    // only ever removes a file it can prove is its own. The docstring used to claim "whichever wins the
    // exclusive create proceeds, which is correct because only one can" — true of the create and false of
    // the delete, which is what made it convincing.
    const token = `${process.pid}:${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${token}\n`, "utf8");
    } catch (error) {
      // The handle may exist even though the WRITE failed (ENOSPC, EDQUOT, EFBIG). The old code jumped
      // straight here and rethrew, so the already-created lock file was left on disk and its descriptor
      // leaked to GC — an orphan that blocks every writer for a full STALE_LOCK_MS and feeds the EMFILE
      // path below. Close and remove before doing anything else; `ours` is safe because we just made it.
      if (handle) {
        await handle.close().catch(() => undefined);
        await removeIfOurs(lockPath, token);
        handle = undefined;
      }
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") throw error;

      // Someone else holds it. Break it only if it is old enough to be abandoned — and only the exact file
      // we judged, so a lock created in the gap survives.
      try {
        const held = await stat(lockPath);
        if (Date.now() - held.mtimeMs > STALE_LOCK_MS) {
          const abandoned = await readFile(lockPath, "utf8").catch(() => undefined);
          if (abandoned !== undefined) await removeIfOurs(lockPath, abandoned.trim());
        }
      } catch {
        /* it vanished between the check and the stat — the next attempt will simply take it */
      }

      if (Date.now() >= deadline) throw new LockTimeoutError(label);
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }

    try {
      return await work();
    } finally {
      await handle.close().catch(() => undefined);
      // Only if it is still OURS. A lock broken out from under us belongs to somebody else now, and
      // deleting it is what turned one lost race into a cascade.
      await removeIfOurs(lockPath, token);
    }
  }
}

/**
 * Delete the lock only if it still holds `token`.
 *
 * Read-then-delete is itself two operations, so this is not atomic either — but it narrows the window from
 * "the whole of `work()`" to "between a read and an unlink", and it removes the *systematic* break entirely:
 * a process can no longer delete a lock it demonstrably never owned.
 */
async function removeIfOurs(lockPath: string, token: string): Promise<void> {
  try {
    const held = await readFile(lockPath, "utf8");
    if (held.trim() !== token) return;
    await rm(lockPath, { force: true });
  } catch {
    /* already gone, or unreadable — either way this process is not the one that should force it */
  }
}
