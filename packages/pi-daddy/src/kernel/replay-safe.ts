/**
 * Replay-safe children: the kernel half (owner decision of 2026-11-17, "Read-only work, once").
 *
 * A child whose effective capabilities only read cannot change anything, so one failed attempt of it may be run
 * again with the same inputs. Everything else still stops and asks. Two pure questions are answered here, and
 * nowhere else:
 *
 *  - is a capability set replay-safe (`replaySafe`), and is a declared ceiling (`replaySafeCeiling`);
 *  - does a first attempt that failed qualify for its one retry (`replayRetryDecision`), judged only from facts
 *    Daddy settled itself: exit code, timeout and cancellation flags, the captured final and the cleanup receipt;
 *    under a stable operation the same answer only marks the failure replayable for the operation's owner.
 *
 * Nothing here spawns, reserves capacity, plans or reads the environment. Composition supplies the facts and runs
 * the retry through the ordinary delegation path, so the retry is planned, gated, recorded and bounded exactly as a
 * fresh delegation is.
 */
import { isContextCapability } from "./context-handoff.ts";
import { ENV_REPLAY_RETRY } from "./env-names.ts";
import type { Capability } from "./resolve.ts";

/**
 * Native Pi tools that only read. Closed, and widened only by a dated decision in AGENTS.md: `bash`, `write`,
 * `edit`, `edit-diff` and `parallel` are absent, as are `delegate`, every extension tool (a parent-run tool such as
 * `scout_research` has external effects and cost) and every wildcard.
 */
export const REPLAY_SAFE_TOOLS: readonly Capability[] = Object.freeze([
  "tool:find",
  "tool:grep",
  "tool:ls",
  "tool:read",
]);

/**
 * True only when every capability is a read-only native tool or a context handoff mode. Context modes only read:
 * the parent names files, writes a summary, or lends a copy of its session, and the child writes none of them.
 * Any other namespace (`agent:`, `skill:`, `ext:`, `workspace:`) makes the set unsafe. An empty set is safe: a
 * child with no tools can only answer.
 */
export function replaySafe(capabilities: readonly Capability[]): boolean {
  return capabilities.every((capability) => REPLAY_SAFE_TOOLS.includes(capability) || isContextCapability(capability));
}

/**
 * A definition's declared ceiling. An undeclared or pattern ceiling is never replay-safe, whatever its explicit
 * entries say: the planner refuses both, and an empty undeclared list must not read as "no tools".
 */
export function replaySafeCeiling(ceiling: {
  capabilities: readonly Capability[];
  patterns: readonly string[];
  undeclared: boolean;
}): boolean {
  return !ceiling.undeclared && ceiling.patterns.length === 0 && replaySafe(ceiling.capabilities);
}

/**
 * The operator's kill switch for the automatic retry; replay-safe marking is unaffected. Unset or literal `1`
 * leaves it on, literal `0` turns it off, and anything else is malformed and also off.
 */
export function replayRetrySwitch(raw: string | undefined): { enabled: boolean; malformed: boolean } {
  if (raw === undefined || raw === "1") return { enabled: true, malformed: false };
  return { enabled: false, malformed: raw !== "0" };
}

/** Why the first attempt failed, in one fixed phrase. Fixed, so child output never reaches the model through it. */
export type ReplayFailure =
  "process exited without a final" | "spawn failed transiently" | "timed out" | "provider request failed";

/** Resource exhaustion before a worker existed. Anything else a spawn reports is a configuration fault. */
const TRANSIENT_SPAWN = /\b(?:EAGAIN|EMFILE|ENFILE|ENOMEM)\b/;

/** The settlement facts of one finished attempt, as Daddy recorded them. */
export interface ReplayAttempt {
  ok: boolean;
  /** Absent only when nothing ran: the planner, a gate or a preflight refused before launch. */
  work?: string;
  exitCode: number | null;
  timedOut?: boolean;
  aborted?: boolean;
  spawnFailed?: boolean;
  spawnError?: string;
  control?: "failed";
  final?: { state: string; providerError?: true };
  cleanup?: { state: string };
  observation?: { state: string };
}

/** The transient failure this attempt shows, or none. A child that produced a complete final has answered. */
export function replayableFailure(attempt: ReplayAttempt): ReplayFailure | undefined {
  if (attempt.ok || attempt.aborted || attempt.final?.state === "complete") return undefined;
  if (attempt.timedOut) return "timed out";
  if (attempt.spawnFailed)
    return TRANSIENT_SPAWN.test(attempt.spawnError ?? "") ? "spawn failed transiently" : undefined;
  if (attempt.exitCode !== 0) return "process exited without a final";
  return attempt.final?.providerError ? "provider request failed" : undefined;
}

/** Everything the decision reads. Each field is one guard; `replayRetryDecision` names the one that refused. */
export interface ReplayRetryFacts {
  /** `replayRetrySwitch(...).enabled`. */
  enabled: boolean;
  /** The first attempt's effective capabilities, as planned. */
  capabilities: readonly Capability[];
  attempt: ReplayAttempt;
  /**
   * A stable operation claimed one execution identity; its admission record cannot name a second. Checked last:
   * an otherwise eligible failure is then marked replayable for the operation's owner, never retried here.
   */
  operation: boolean;
  /** A Herdr pane is operable by a human, so a stop there cannot be told from a person's. */
  executor: "process" | "herdr";
  /** The parent tool call's own abort signal. */
  parentAborted: boolean;
  /** An upstream controller's veto is an answer, not a fault. */
  criticalAssuranceBlock: boolean;
  /** A gate answered for the first attempt: prompt, store, Auto or a chain's upfront dialog. */
  approvalSpent: boolean;
  /** Time left before the first attempt's wall-clock deadline, and the configured inactivity bound. */
  remainingMs: number;
  idleMs: number;
}

export type ReplayRetryRefusal =
  | "disabled"
  | "not-replay-safe"
  | "stable-operation"
  | "executor"
  | "cancelled"
  | "refused"
  | "assurance-block"
  | "not-transient"
  | "cleanup-unsettled"
  | "approval-spent"
  | "deadline";

/**
 * Retry once, or name the first guard that refuses. All must hold: the plan is replay-safe; the attempt failed
 * without answering (`replayableFailure`); neither the parent's cancellation nor a refusal before launch caused it
 * (a process killed from outside looks like a crash and is retried); the first attempt's cleanup
 * settled (or no worker started) and its observation is complete; no approval was spent on it; and at least one
 * inactivity bound remains before its wall-clock deadline, which the retry inherits.
 *
 * The stable-operation guard is checked last, so its refusal means every other guard held. Daddy does not retry
 * under an operation; it reports the failure as `replayable` and the caller that owns the operation retries it
 * under a new one (owner decision of 2026-11-17, "Principal retries once").
 */
export function replayRetryDecision(
  facts: ReplayRetryFacts,
):
  | { retry: true; cause: ReplayFailure }
  | { retry: false; because: "stable-operation"; replayable: ReplayFailure }
  | { retry: false; because: Exclude<ReplayRetryRefusal, "stable-operation"> } {
  const refuse = (because: Exclude<ReplayRetryRefusal, "stable-operation">) => ({ retry: false as const, because });
  if (!facts.enabled) return refuse("disabled");
  if (!replaySafe(facts.capabilities)) return refuse("not-replay-safe");
  if (facts.executor !== "process") return refuse("executor");
  if (facts.parentAborted || facts.attempt.aborted) return refuse("cancelled");
  if (facts.attempt.work === undefined) return refuse("refused");
  if (facts.criticalAssuranceBlock) return refuse("assurance-block");
  const cause = replayableFailure(facts.attempt);
  if (!cause) return refuse("not-transient");
  const { cleanup, control, observation } = facts.attempt;
  if (
    !(cleanup?.state === "settled" || cleanup?.state === "not-started") ||
    control === "failed" ||
    observation?.state !== "complete"
  )
    return refuse("cleanup-unsettled");
  if (facts.approvalSpent) return refuse("approval-spent");
  if (!(facts.remainingMs >= facts.idleMs)) return refuse("deadline");
  if (facts.operation) return { retry: false, because: "stable-operation", replayable: cause };
  return { retry: true, cause };
}

/**
 * What the operator is told beside the replay-safe mark (startup summary, `/grants`): exactly when this session
 * does not retry. Every case the decision refuses for the whole session is named; per-attempt guards are not.
 */
export function replayRetryNotice(enabled: boolean, executor: "process" | "herdr"): string {
  if (!enabled) return `not retried or marked replayable: switched off by ${ENV_REPLAY_RETRY}`;
  if (executor !== "process") return "not retried or marked replayable under the Herdr executor";
  return "retried once automatically if it fails without answering; with operation_id, marked replayable for the coordinator to retry instead";
}
