/** Bounded requester cleanup wait, not a death certificate or an admission policy.
 * The scheduler MUST fault admission on rejection and keep reader/stop owners charged independently.
 * Timing out stops only this wait; original callback/runner ownership remains with the scheduler.
 */
import type { RequestRow } from "./cache-scheduler-types.ts";
export async function settleCacheRequest(
  row: RequestRow,
  readers: () => Iterable<RequestRow>,
  failure: () => unknown,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = async () => {
    const execution = row.retiring;
    if (execution && !execution.interests.size) {
      await execution.task;
      await execution.stopTask;
      if (execution.fault) throw execution.fault;
    }
    const deadline = Date.now() + 1500;
    while ([...readers()].includes(row)) {
      if (Date.now() >= deadline) throw Error("cache request reader cleanup unresolved; retain");
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    const error = failure();
    if (error !== undefined) throw error;
  };
  try {
    await Promise.race([
      drain(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(Error("cache request cleanup unresolved after1500ms; retain")), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
