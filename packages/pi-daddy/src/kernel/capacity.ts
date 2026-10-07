/**
 * Owner-local active descendant capacity. A reservation holds one child plus a disjoint subtree allowance.
 * The allowance excludes this owner session. Conservatively hold all of it until the owned subtree settles;
 * this permits reuse after settlement, but does not promise perfect utilization or a lifetime call limit.
 */
import type { CapturedWorkerCleanup, CapturedWorkerIdentity } from "./captured-worker-contract.ts";

export type CapacityReservationState = "reserved" | "retained" | "released";
export interface CapacityReservation {
  readonly executionId: string;
  readonly childAllowance: number;
  readonly cost: number;
  readonly state: CapacityReservationState;
  /** Bind actual ownership before releasing the worker gate. Throws on replacement or a different execution. */
  bindOwnership(identity: CapturedWorkerIdentity): void;
  /** Only trusted executor facts belong here; model output and ledger projections never authorize release. */
  finalize(cleanup: CapturedWorkerCleanup): CapacityReservationState;
}
export type CapacityReservationResult = { ok: true; reservation: CapacityReservation } | { ok: false; reason: string };
export interface CapacityAllocator {
  readonly total: number;
  readonly available: number;
  readonly reserved: number;
  reserve(executionId: string, childAllowance: number): CapacityReservationResult;
}

const identityKeys = [
  "revision",
  "executionId",
  "nonce",
  "root",
  "rootDevice",
  "rootInode",
  "bootId",
  "pidNamespace",
  "helperPid",
  "helperStartTicks",
  "helperSha256",
  "workerPid",
  "ownershipPath",
  "receiptPath",
] as const;
function sameIdentity(a: CapturedWorkerIdentity, b: CapturedWorkerIdentity): boolean {
  return identityKeys.every((key) => a[key] === b[key]);
}
const validAllowance = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** Synchronous reservations are atomic within the actual session owner, including overlapping tool calls. */
export function createCapacityAllocator(total: number): CapacityAllocator {
  if (!validAllowance(total)) throw new Error("descendant capacity must be a non-negative safe integer");
  let available = total;
  // Keep occurrence tombstones: a stale finalizer must never release a newly reused execution identifier.
  const executions = new Set<string>();
  return Object.freeze({
    total,
    get available() {
      return available;
    },
    get reserved() {
      return total - available;
    },
    reserve(executionId: string, childAllowance: number): CapacityReservationResult {
      if (!executionId || executionId.length > 512 || executions.has(executionId))
        return { ok: false, reason: "capacity reservation requires a fresh bounded execution identifier" };
      if (!validAllowance(childAllowance) || !Number.isSafeInteger(childAllowance + 1))
        return { ok: false, reason: "child allowance must be a non-negative safe integer below the numeric ceiling" };
      const cost = childAllowance + 1;
      if (cost > available)
        return {
          ok: false,
          reason: `active descendant capacity exhausted: ${cost} reserved units requested, ${available} available`,
        };
      available -= cost;
      executions.add(executionId);
      let state: CapacityReservationState = "reserved";
      let identity: CapturedWorkerIdentity | undefined;
      const reservation: CapacityReservation = Object.freeze({
        executionId,
        childAllowance,
        cost,
        get state() {
          return state;
        },
        bindOwnership(actual: CapturedWorkerIdentity): void {
          if (
            state === "released" ||
            actual.executionId !== executionId ||
            (identity && !sameIdentity(identity, actual))
          )
            throw new Error("capacity ownership does not match its reserved execution");
          identity = Object.freeze({ ...actual });
        },
        finalize(cleanup: CapturedWorkerCleanup): CapacityReservationState {
          if (state === "released") return state;
          const provenNotStarted = cleanup.state === "not-started" && !identity && state === "reserved";
          const settled =
            cleanup.state === "settled" &&
            identity !== undefined &&
            sameIdentity(identity, cleanup.identity) &&
            sameIdentity(identity, cleanup.receipt.identity) &&
            cleanup.receipt.state === "settled" &&
            cleanup.receipt.reapedAll === true;
          if (!provenNotStarted && !settled) return (state = "retained");
          available += cost;
          return (state = "released");
        },
      });
      return { ok: true, reservation };
    },
  });
}
