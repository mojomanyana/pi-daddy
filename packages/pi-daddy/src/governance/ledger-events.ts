/**
 * The v3 runtime-event half of the ledger: workspace leases and child lifecycle, with
 * their builders. Split out of `./ledger.ts` only to stay under the 400-line module ceiling this
 * project enforces mechanically; `./ledger.ts` re-exports everything here, so "the ledger module"
 * remains one import.
 */
import { LEDGER_VERSION, type LedgerEventBase, type GrantRecord } from "./ledger.ts";
import type { ExecutorKind } from "../kernel/delegate-types.ts";
import type { CorrelationMetadata } from "../kernel/correlation.ts";
import type { StructuredRefusal } from "../kernel/refusals.ts";
import { assertExecutionId } from "../kernel/execution-id.ts";
import { assertLedgerV3Wire } from "./ledger-v3-validation.ts";

export const WORKSPACE_ACCESSES = ["read", "write"] as const;
export type WorkspaceAccess = (typeof WORKSPACE_ACCESSES)[number];

export const WORKSPACE_RECOVERY_VALUES = [false, true, "unknown"] as const;
export type WorkspaceRecovery = (typeof WORKSPACE_RECOVERY_VALUES)[number];

export const CHILD_LIFECYCLE_STATES = ["starting", "running", "completed", "failed"] as const;
export type ChildLifecycleState = (typeof CHILD_LIFECYCLE_STATES)[number];

/** The complete Node signal vocabulary accepted by a v3 child-lifecycle event. */
export const CHILD_PROCESS_SIGNALS = [
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGIO",
  "SIGIOT",
  "SIGKILL",
  "SIGPIPE",
  "SIGPOLL",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTKFLT",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGUNUSED",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGBREAK",
  "SIGLOST",
  "SIGINFO",
] as const satisfies readonly NodeJS.Signals[];
export type ChildProcessSignal = (typeof CHILD_PROCESS_SIGNALS)[number];

/**
 * `released` is a handover this owner performed. FOUR members were added by the 0.18.0 review pass, and
 * they were not all previously recorded the same way — `uncontended` was recorded as an *acquisition*, and
 * `lost` was recorded as nothing at all, because the old `release()` threw before the append ran:
 *   `lost`     the kernel lock went away under a live governed writer — NOT the same fact as a user
 *              cancelling, which is what it used to be indistinguishable from (R-103);
 *   `retained` the lease was deliberately kept because a herdr writer tab would not close, so the
 *              successor's `recovered: true` would otherwise blame a healthy path (R-104);
 *   `uncontended` a read lease took no kernel lock at all, so counting it as an acquisition
 *              overstated how many exclusions the kernel actually performed (R-105).
 */
export const WORKSPACE_LEASE_OUTCOMES = [
  "acquired",
  "uncontended",
  "refused",
  "released",
  "released-unrecorded",
  "lost",
  "retained",
  "timeout",
  "recovered",
] as const;
export type WorkspaceLeaseOutcome = (typeof WORKSPACE_LEASE_OUTCOMES)[number];

export interface WorkspaceLeaseEvent extends LedgerEventBase {
  ledgerVersion: typeof LEDGER_VERSION;
  event: "workspace_lease";
  executionId: string;
  parentExecutionId: string | null;
  childId: string;
  workspaceId: string;
  root: string;
  access: WorkspaceAccess;
  outcome: WorkspaceLeaseOutcome;
  /** `"unknown"` when the prior owner's record was unreadable — not evidence of a clean handover. */
  recovered?: WorkspaceRecovery;
  releaseReason?: string;
  refusal?: StructuredRefusal;
}

export interface ChildLifecycleEvent extends LedgerEventBase {
  ledgerVersion: typeof LEDGER_VERSION;
  event: "child_lifecycle";
  executionId: string;
  parentExecutionId: string | null;
  childId: string;
  state: ChildLifecycleState;
  executor: ExecutorKind;
  /** Bound after which a non-terminal start is known to be incomplete. */
  deadlineAt?: string;
  /** Herdr runtime identity is observational and never an enforcement boundary. */
  herdrPaneId?: string;
  herdrAgentName?: string;
  exitCode?: number | null;
  signal?: ChildProcessSignal | null;
  timedOut?: true;
  aborted?: true;
  truncated?: true;
  reason?: string;
  /** The inactivity bound (ms) that governed this child beside the `deadlineAt` ceiling (PR 3e). */
  idleTimeoutMs?: number;
}

export type CapabilityDecisionEvent = GrantRecord & {
  ledgerVersion: typeof LEDGER_VERSION;
  event: "capability_decision";
  executionId: string;
  parentExecutionId: string | null;
  taskDigest: string;
};

export type RuntimeLedgerEvent = CapabilityDecisionEvent | WorkspaceLeaseEvent | ChildLifecycleEvent;

export function buildWorkspaceLeaseEvent(args: {
  executionId: string;
  parentExecutionId: string | null;
  childId: string;
  workspaceId: string;
  root: string;
  access: WorkspaceAccess;
  outcome: WorkspaceLeaseOutcome;
  recovered?: WorkspaceRecovery;
  releaseReason?: string;
  refusal?: StructuredRefusal;
  correlation?: CorrelationMetadata;
  now: Date;
}): WorkspaceLeaseEvent {
  assertEventIdentity(args);
  return assertLedgerV3Wire({
    ledgerVersion: LEDGER_VERSION,
    event: "workspace_lease",
    ts: args.now.toISOString(),
    executionId: args.executionId,
    parentExecutionId: args.parentExecutionId,
    childId: args.childId,
    workspaceId: args.workspaceId,
    root: args.root,
    access: args.access,
    outcome: args.outcome,
    // `!== undefined`, not truthiness. `recovered: false` — a POSITIVE assertion that the predecessor
    // handed over cleanly — was dropped while the truthy `"unknown"` survived, so absence meant both
    // "clean" and "never supplied". R-100's whole argument is that absence of evidence is not evidence,
    // and this was the one line discarding the evidence.
    ...(args.recovered !== undefined ? { recovered: args.recovered } : {}),
    ...(args.releaseReason ? { releaseReason: args.releaseReason } : {}),
    ...(args.refusal ? { refusal: structuredClone(args.refusal) } : {}),
    ...(args.correlation ? { correlation: structuredClone(args.correlation) } : {}),
  });
}

export function buildChildLifecycleEvent(args: {
  executionId: string;
  parentExecutionId: string | null;
  childId: string;
  state: ChildLifecycleState;
  executor: ExecutorKind;
  deadlineAt?: string;
  idleTimeoutMs?: number;
  herdrPaneId?: string;
  herdrAgentName?: string;
  exitCode?: number | null;
  signal?: ChildProcessSignal | null;
  timedOut?: boolean;
  aborted?: boolean;
  truncated?: boolean;
  reason?: string;
  correlation?: CorrelationMetadata;
  now: Date;
}): ChildLifecycleEvent {
  assertEventIdentity(args);
  return assertLedgerV3Wire({
    ledgerVersion: LEDGER_VERSION,
    event: "child_lifecycle",
    ts: args.now.toISOString(),
    executionId: args.executionId,
    parentExecutionId: args.parentExecutionId,
    childId: args.childId,
    state: args.state,
    executor: args.executor,
    ...(args.deadlineAt ? { deadlineAt: args.deadlineAt } : {}),
    ...(args.idleTimeoutMs !== undefined ? { idleTimeoutMs: args.idleTimeoutMs } : {}),
    ...(args.herdrPaneId ? { herdrPaneId: args.herdrPaneId } : {}),
    ...(args.herdrAgentName ? { herdrAgentName: args.herdrAgentName } : {}),
    ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
    ...(args.timedOut ? { timedOut: true } : {}),
    ...(args.aborted ? { aborted: true } : {}),
    ...(args.truncated ? { truncated: true } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.correlation ? { correlation: structuredClone(args.correlation) } : {}),
  });
}

function assertEventIdentity(args: { executionId: string; parentExecutionId: string | null }): void {
  assertExecutionId(args.executionId);
  if (args.parentExecutionId !== null) assertExecutionId(args.parentExecutionId, "parentExecutionId");
  if (args.parentExecutionId === args.executionId) throw new TypeError("an execution cannot be its own parent");
}
