/** Visible-client demand may recheck bounded metadata; no timer starts work on its own. */
import type {
  DashboardSourceRefreshCallback,
  DashboardSourceSnapshot,
  DashboardSourceUpdate,
} from "../src/kernel/dashboard-observation.ts";

export const DASHBOARD_REFRESH_INTERVAL_MS = 30_000;
export const DASHBOARD_REFRESH_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;

export function dashboardSourceRefresh(
  snapshot: DashboardSourceSnapshot,
  refresh: DashboardSourceRefreshCallback,
  active: () => boolean,
  publish: (value: DashboardSourceUpdate) => boolean,
  now: () => number,
) {
  let closed = false,
    failures = 0,
    nextAttempt = 0;
  let lastAttempt: number | undefined;
  let pending:
    | { controller: AbortController; timer: ReturnType<typeof setTimeout>; failed: boolean; attemptedAt: string }
    | undefined;
  snapshot.refresh = { state: "idle" };
  const current = () => !closed && active();
  return {
    observed(replacedInventory: boolean) {
      if (!current()) return;
      if (snapshot.refresh?.state === "failed" && !replacedInventory) return;
      if (pending && !pending.controller.signal.aborted && !replacedInventory) return;
      pending?.controller.abort();
      if (pending) clearTimeout(pending.timer);
      failures = 0;
      nextAttempt = lastAttempt === undefined ? 0 : lastAttempt + DASHBOARD_REFRESH_INTERVAL_MS;
      snapshot.refresh = {
        state: "idle",
        ...(nextAttempt ? { nextAttemptAt: new Date(nextAttempt).toISOString() } : {}),
      };
    },
    request() {
      if (!current()) return false;
      if (pending) return !pending.controller.signal.aborted;
      const time = now();
      if (time < nextAttempt) return false;
      lastAttempt = time;
      const controller = new AbortController(),
        attemptedAt = new Date(time).toISOString();
      const fail = () => {
        if (!current() || pending !== attempt || attempt.failed) return;
        attempt.failed = true;
        failures++;
        nextAttempt = now() + Math.min(DASHBOARD_REFRESH_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
        snapshot.refresh = { state: "failed", attemptedAt, nextAttemptAt: new Date(nextAttempt).toISOString() };
      };
      const timer = setTimeout(() => {
        controller.abort();
        fail();
      }, DASHBOARD_REFRESH_TIMEOUT_MS);
      timer.unref?.();
      const attempt = { controller, timer, failed: false, attemptedAt };
      pending = attempt;
      snapshot.refresh = { state: "checking", attemptedAt };
      void Promise.resolve()
        .then(() => {
          if (current() && !controller.signal.aborted) return refresh({ signal: controller.signal });
        })
        .then((value) => {
          if (!current() || controller.signal.aborted || pending !== attempt) return;
          if (!value || !publish(value)) {
            fail();
            return;
          }
          failures = 0;
          nextAttempt = now() + DASHBOARD_REFRESH_INTERVAL_MS;
          snapshot.refresh = { state: "idle", attemptedAt, nextAttemptAt: new Date(nextAttempt).toISOString() };
        })
        .catch(() => {
          if (!controller.signal.aborted) fail();
        })
        .finally(() => {
          clearTimeout(timer);
          if (pending === attempt) pending = undefined;
        });
      return true;
    },
    close() {
      closed = true;
      pending?.controller.abort();
      if (pending) clearTimeout(pending.timer);
      snapshot.refresh = { ...snapshot.refresh, state: "idle" };
    },
  };
}
