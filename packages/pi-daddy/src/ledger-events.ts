/**
 * The v2 runtime-event half of the ledger: workspace leases, child lifecycle and check receipts, with
 * their builders. Split out of `./ledger.ts` only to stay under the 400-line module ceiling this
 * project enforces mechanically; `./ledger.ts` re-exports everything here, so "the ledger module"
 * remains one import.
 */
import { LEDGER_VERSION, type LedgerEventBase, type GrantRecord } from "./ledger.ts";
import type { ExecutorKind } from "./executor.ts";
import type { CorrelationMetadata } from "./correlation.ts";
import type { StructuredRefusal } from "./refusals.ts";

/**
 * `released` is a handover this owner performed. The three added by the 0.18.0 review pass exist
 * because each was previously recorded as `released`, which made the ledger assert a handover that
 * did not happen:
 *   `lost`     the kernel lock went away under a live governed writer — NOT the same fact as a user
 *              cancelling, which is what it used to be indistinguishable from (R-103);
 *   `retained` the lease was deliberately kept because a herdr writer tab would not close, so the
 *              successor's `recovered: true` would otherwise blame a healthy path (R-104);
 *   `uncontended` a read lease took no kernel lock at all, so counting it as an acquisition
 *              overstated how many exclusions the kernel actually performed (R-105).
 */
export type WorkspaceLeaseOutcome =
  | "acquired"
  | "uncontended"
  | "refused"
  | "released"
  | "released-unrecorded"
  | "lost"
  | "retained"
  | "timeout"
  | "recovered";

export interface WorkspaceLeaseEvent extends LedgerEventBase {
  ledgerVersion: typeof LEDGER_VERSION;
  event: "workspace_lease";
  childId: string;
  workspaceId: string;
  root: string;
  access: "read" | "write";
  outcome: WorkspaceLeaseOutcome;
  /** `"unknown"` when the prior owner's record was unreadable — not evidence of a clean handover. */
  recovered?: boolean | "unknown";
  releaseReason?: string;
  refusal?: StructuredRefusal;
}

export interface ChildLifecycleEvent extends LedgerEventBase {
  ledgerVersion: typeof LEDGER_VERSION;
  event: "child_lifecycle";
  childId: string;
  state: "starting" | "completed" | "failed";
  executor: ExecutorKind;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  aborted?: boolean;
  truncated?: boolean;
  reason?: string;
}

export interface CheckReceiptLedgerEvent extends LedgerEventBase {
  ledgerVersion: typeof LEDGER_VERSION;
  event: "check_receipt";
  childId: string;
  receiptId: string;
  workspaceId: string;
  checkId: string;
  treeSha: string;
}

export type RuntimeLedgerEvent =
  | (GrantRecord & { ledgerVersion: typeof LEDGER_VERSION; event: "capability_decision" })
  | WorkspaceLeaseEvent
  | ChildLifecycleEvent
  | CheckReceiptLedgerEvent;

export function buildWorkspaceLeaseEvent(args: {
  childId: string;
  workspaceId: string;
  root: string;
  access: "read" | "write";
  outcome: WorkspaceLeaseOutcome;
  recovered?: boolean | "unknown";
  releaseReason?: string;
  refusal?: StructuredRefusal;
  correlation?: CorrelationMetadata;
  now: Date;
}): WorkspaceLeaseEvent {
  return {
    ledgerVersion: LEDGER_VERSION,
    event: "workspace_lease",
    ts: args.now.toISOString(),
    childId: args.childId,
    workspaceId: args.workspaceId,
    root: args.root,
    access: args.access,
    outcome: args.outcome,
    ...(args.recovered ? { recovered: args.recovered } : {}),
    ...(args.releaseReason ? { releaseReason: args.releaseReason } : {}),
    ...(args.refusal ? { refusal: structuredClone(args.refusal) } : {}),
    ...(args.correlation ? { correlation: structuredClone(args.correlation) } : {}),
  };
}

export function buildChildLifecycleEvent(args: {
  childId: string;
  state: "starting" | "completed" | "failed";
  executor: ExecutorKind;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  aborted?: boolean;
  truncated?: boolean;
  reason?: string;
  correlation?: CorrelationMetadata;
  now: Date;
}): ChildLifecycleEvent {
  return {
    ledgerVersion: LEDGER_VERSION,
    event: "child_lifecycle",
    ts: args.now.toISOString(),
    childId: args.childId,
    state: args.state,
    executor: args.executor,
    ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
    ...(args.timedOut ? { timedOut: true } : {}),
    ...(args.aborted ? { aborted: true } : {}),
    ...(args.truncated ? { truncated: true } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.correlation ? { correlation: structuredClone(args.correlation) } : {}),
  };
}
