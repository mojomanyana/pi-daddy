/** UNTESTED (per request). A product owner joins its own pending reads and retains exact failed handles.
 * Recovery releases physical resources only; it never changes the original read/stop failure or admission.
 */
import { BoundedReadCleanupError, readBoundedBytes, readBoundedTailBytes, type BoundedReadBytes } from "../kernel/bounded-read.ts";
export class CacheProductReadUnavailable extends Error {}
export class CacheProductReaders {
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly failures = new Set<BoundedReadCleanupError>();
  private closed = false;
  private stopping?: Promise<void>;
  private reservedBytes = 0;
  constructor(private readonly maxBytes = 32 * 1024 * 1024, private readonly maxPending = 32) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 32)
      throw Error("cache reader limits malformed");
  }
  private owned<T>(maxBytes: number, operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.failures.size) throw Error("cache product reader admission closed or faulted");
    const charge = maxBytes + 1; // Return the original read allocation, never an uncharged copy.
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || this.tasks.size >= this.maxPending || charge > this.maxBytes - this.reservedBytes)
      throw new CacheProductReadUnavailable("cache product reader allocation bound exceeded");
    this.reservedBytes += charge; // Charge before any asynchronous/file operation.
    const task = Promise.resolve().then(async () => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof BoundedReadCleanupError) this.failures.add(error);
        throw error;
      } finally {
        this.reservedBytes -= charge;
      }
    });
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
  read(path: string, maxBytes: number): Promise<Buffer> {
    return this.owned(maxBytes, async () => {
      const value = await readBoundedBytes(path, { maxBytes, timeoutMs: 3000 });
      if (!value.ok) throw new CacheProductReadUnavailable(`cache product input unavailable: ${value.why}: ${value.detail}`);
      return value.bytes;
    });
  }
  /** Absence remains a typed open result, never a close-error cause or diagnostic string. */
  readTail(path: string, maxBytes: number): Promise<BoundedReadBytes> {
    return this.owned(maxBytes, () => readBoundedTailBytes(path, { maxBytes, timeoutMs: 3000 }));
  }
  /** Join existing reads without closing optional ordinary-history admission after cache disable. */
  async join(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
    if (this.failures.size) throw new AggregateError([...this.failures], "cache product readers unresolved; retain");
  }
  stop(): Promise<void> {
    this.closed = true;
    return (this.stopping ??= Promise.resolve().then(() => this.join()));
  }
  async recover(): Promise<void> {
    if (!this.closed) throw Error("stop cache product before reader recovery");
    await Promise.allSettled([...this.tasks]);
    const results = await Promise.allSettled(
      [...this.failures].map(async (failure) => {
        await failure.cleanup();
        this.failures.delete(failure);
      }),
    );
    const errors = results.flatMap((row) => (row.status === "rejected" ? [row.reason] : []));
    if (errors.length) throw new AggregateError(errors, "cache product reader recovery unresolved; retain");
  }
  stats() {
    return { pending: this.tasks.size, reservedBytes: this.reservedBytes, maxBytes: this.maxBytes, maxPending: this.maxPending, failed: this.failures.size, closed: this.closed };
  }
}
