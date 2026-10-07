/** Bounded owned-result finalization. Process exit is a separate proof supplied by the owned adapter. */
export type CacheReport<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };
export function observeCacheReport<T>(promise: Promise<T>): Promise<CacheReport<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}
export function waitCacheReport<T>(
  report: Promise<CacheReport<T>>,
  signal: AbortSignal,
  completionMs: number,
): Promise<CacheReport<T> | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: CacheReport<T> | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => finish(undefined);
    const timer = setTimeout(
      () =>
        finish({
          status: "rejected",
          reason: new Error(`cache outcome completion exceeded ${completionMs}ms after verified exit`),
        }),
      completionMs,
    );
    signal.addEventListener("abort", abort, { once: true });
    report.then(finish);
    if (signal.aborted) abort();
  });
}
