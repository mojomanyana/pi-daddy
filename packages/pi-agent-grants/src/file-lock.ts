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

import { open, rm, stat } from "node:fs/promises";

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
 * Two processes can race to break the same stale lock; whichever wins the subsequent exclusive create
 * proceeds, which is correct because only one can.
 *
 * The timeout is short *on purpose*: work refused because a file was busy is recoverable and loud, while
 * work that hangs waiting for a lock is neither.
 */
export async function withFileLock<T>(path: string, label: string, work: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") throw error;

      // Someone else holds it. Break it only if it is old enough to be abandoned.
      try {
        const held = await stat(lockPath);
        if (Date.now() - held.mtimeMs > STALE_LOCK_MS) await rm(lockPath, { force: true });
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
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
}
