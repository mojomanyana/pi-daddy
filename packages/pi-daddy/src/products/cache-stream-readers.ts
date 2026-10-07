/** Awaited stream consumers, including late callbacks whose request has detached/acknowledged.
 * Cancellation releases producer waiting, NOT ownership of the pending callback. Admission/teardown
 * must include rows() until callbacks actually settle. One callback per row; no unbounded sink queue.
 * Caller supplies current authorization and rejection; this module does not infer either from bytes. */
import type { RequestRow } from "./cache-scheduler-types.ts";
export class CacheStreamReaders {
  private pending = new Map<RequestRow, Promise<void>>();
  failure?: unknown;
  rows() {
    return this.pending.keys();
  }
  get size() {
    return this.pending.size;
  }
  deliver(
    row: RequestRow,
    bytes: Buffer,
    authorized: () => boolean,
    reject: (reason: string) => void,
  ): Promise<void> | undefined {
    if (this.pending.has(row)) {
      reject("cache stream producer did not await reader");
      return;
    }
    let resolve!: () => void;
    const owned = new Promise<void>((done) => {
      resolve = done;
    });
    // Memoize ownership BEFORE callbacks, including reentrant cancellation/shutdown.
    this.pending.set(row, owned);
    const settle = (error?: unknown, failed = false) => {
      try {
        if (failed) reject(`cache reader failed: ${String(error)}`);
        else if (!authorized()) reject("cache authority changed during stream delivery");
      } catch (fault) {
        this.failure ??= fault;
      } finally {
        this.pending.delete(row);
        resolve();
      }
    };
    let returned: void | Promise<void>;
    try {
      if (!authorized()) {
        reject("cache stream reader is not currently authorized");
        settle();
        return;
      }
      returned = row.onData?.(Buffer.from(bytes));
      if (!returned || typeof returned.then !== "function") {
        settle();
        return;
      }
    } catch (error) {
      settle(error, true);
      return;
    }
    void Promise.resolve(returned).then(
      () => settle(),
      (error) => settle(error, true),
    );
    if (row.controller.signal.aborted) return Promise.resolve();
    return new Promise<void>((done) => {
      const finish = () => {
        row.controller.signal.removeEventListener("abort", finish);
        done();
      };
      row.controller.signal.addEventListener("abort", finish, { once: true });
      void owned.then(finish);
      if (row.controller.signal.aborted) finish();
    });
  }
}
