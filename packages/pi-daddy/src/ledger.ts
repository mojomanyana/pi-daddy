/**
 * Append-only grant ledger.
 *
 * Exists because pi-fabric's persisted execution trace records `args: {}` — it captures *that* a child
 * ran, not *what it was authorised to do* (docs/probes/pi-fabric-eval probe 5). Without this record
 * you cannot answer "what was this sub-agent permitted to do?" after the fact, which is the whole
 * point of a governance layer.
 *
 * `denied` is the field that earns the file: an agent repeatedly requesting capabilities it does not
 * hold is an escalation attempt, and it is invisible without a record.
 *
 * PRIVACY: capability ids, counts, and identifiers only. Never prompts, tool arguments, or results.
 *
 * ADR-0018 makes the boundary explicit rather than leaving it to be inferred, because a record now carries
 * something about the child's instructions. **`definitionDigest` is an identifier**: a SHA-256 of an
 * operator-authored file already committed to a repository, which names a version without reproducing it.
 * **The task is not recorded, anywhere, ever** — it is assembled by the model from the parent's context and
 * can carry anything the parent could see, so a ledger holding it would be a secrets sink. That half of
 * "what was this child told to do?" is out of the ledger by decision, not by omission.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { withFileLock } from "./file-lock.ts";
import { dirname } from "node:path";
import type { Capability, ResolveResult } from "./resolve.ts";
import type { ExecutorKind } from "./executor.ts";
import type { DefinitionDigest } from "./definitions.ts";
import { DELEGATE_SUBJECT } from "./approval.ts";
import type { ApprovalScope, ApprovalSource } from "./approval.ts";
import type { PromptOutcomeKind } from "./approval-prompt.ts";

export interface GrantRecord {
  ts: string;
  parentId: string;
  childId: string;
  depth: number;
  agentType?: string;
  requested: Capability[];
  parentGrant: Capability[];
  effective: Capability[];
  denied: Capability[];
  clipped: Capability[];
  gatedBlocked: Capability[];
  /** True when the spawn was refused outright rather than narrowed. */
  blocked: boolean;
  /** Present when the spawn was refused, or when resolution failed. */
  reason?: string;
  /**
   * Gated capabilities satisfied for this spawn.
   *
   * The ledger used to have ONE flavour of no. It now has three, and they call for different responses:
   *  - `denied` non-empty            -> an agent asked for more than it holds. ESCALATION ATTEMPT.
   *  - `humanDenied`                 -> a person was asked and said no. WORKING AS DESIGNED.
   *  - `gatedBlocked` with no source -> nobody was there to ask. A background run hit a gate; the fix is
   *                                     an operator pre-approving it, not an incident.
   */
  approved?: Capability[];
  approvalSource?: ApprovalSource;
  /**
   * WHERE each approved capability's yes came from — one entry per capability (R-46).
   *
   * `approvalSource` above is a single scalar and was written for a set: gate `tool:bash` and `tool:write`,
   * let a persisted entry cover `bash` while a human clicks *Allow once* for `write`, and the record read
   * `approved: ["tool:bash","tool:write"], approvalSource: "prompt"` — **asserting a human was asked about
   * `tool:bash`, which they were not.** The ledger's whole job is answering "did a human authorise this?",
   * so over-claiming in that direction is the worst available failure.
   *
   * The scalar is kept and is now written **only when every approved capability shares one source**, so a
   * reader of old and new lines alike can trust it; when sources differ it is omitted and this map carries
   * the truth. Two fields, one of which is a safe summary of the other — not two competing answers.
   */
  approvalSources?: Record<Capability, ApprovalSource>;
  /**
   * How far each prompted capability's yes reaches (F5). Same shape and same reason as `approvalSources`:
   * `approvalScope` below is a **derived summary**, emitted only when every prompted capability shares one
   * scope. This field decides propagation — `inheritApprovals` drops `once` — so a scalar that described
   * one capability while claiming to describe the set was not merely a reporting defect.
   */
  approvalScopes?: Record<Capability, ApprovalScope>;
  /** Present only when the source was a live prompt, and only when one scope covers the whole set. */
  approvalScope?: ApprovalScope;
  /** A human was asked and declined. Distinct from `denied`, which is an escalation attempt. */
  humanDenied?: boolean;
  /**
   * WHY a gate went unsatisfied, when the answer was not a yes.
   *
   * `PromptOutcomeKind` has five members and this record kept exactly one of them (`humanDenied`, from
   * `declined`). So `no-ui`, `dismissed` (a timeout or an abort) and `error` produced **identical** records
   * — `gatedBlocked` non-empty, no `approvalSource`, `blocked: true` — and the only thing separating them
   * was free-text `reason`, written for a human at the call site. Given a failed run, *"was there an
   * operator who timed out, or was there nobody to ask?"* was not answerable from any field, and the fix
   * for each is different: one is a queue or a longer `PI_GRANTS_APPROVAL_TIMEOUT`, the other is an
   * operator pre-approving.
   *
   * The discriminant was already computed and thrown away. ADR-0026 leans on this vocabulary being able to
   * say *"nobody was there to ask"* and be believed, so it is recorded rather than inferred.
   *
   * **Privacy is unchanged**: this is a fixed five-member enum, not text — nothing model-authored, nothing
   * a task could carry.
   */
  gateOutcome?: PromptOutcomeKind;
  /**
   * WHICH operator-authored instructions this child was given (ADR-0018).
   *
   * Identifies, never reproduces: matching digests prove two children ran the same text, and a digest that
   * no longer matches the file proves the definition changed since. **It says nothing about whether those
   * instructions were correct or whether the child obeyed them** — it identifies text, it does not evaluate
   * it. Absent for a `tools:`-style delegation, which has no definition.
   */
  definitionDigest?: DefinitionDigest;
  /**
   * WHERE this child ran — ADR-0031.
   *
   * **Required rather than optional**, which is unusual in this record and deliberate. Before ADR-0031 the
   * executor was a variable an operator set, so "which one ran?" was answerable from configuration after the
   * fact. It is now decided by a **runtime probe** at session start, so nothing outside the record preserves
   * the answer — and the two paths do not produce the same argv, because the herdr plan withholds `--print`
   * (`delegationContext.interactive`). A trail that cannot say where a child ran cannot be read back
   * reliably, and reading it back is the only reason it exists.
   *
   * Written on refusals too, including the tripwire's: the honest value there is the executor the session
   * *would* have used, because a refused spawn has no executor of its own.
   */
  executor: ExecutorKind;
  /**
   * The child whose OUTPUT composed this child's task — ADR-0033.
   *
   * **Optional, unlike `executor`, and the asymmetry is deliberate.** A non-chained spawn has no prior author, and
   * an empty string would assert one. Present only on chain steps after the first.
   *
   * Why it is recorded at all: a chain makes step N's task the output of a governed child, and ADR-0033's chosen
   * handoff is *framing* rather than enforcement. So "who wrote this instruction?" is exactly the question that
   * decision makes worth asking, and it is unanswerable from any other field — `agentType` names the definition,
   * `definitionDigest` names its instructions, and neither says where the TASK came from.
   */
  taskFrom?: string;
}

export interface LedgerOptions {
  /** Path to the JSONL file. Parent directories are created on demand. */
  path: string;
  /**
   * When true, a ledger write failure throws instead of being swallowed.
   *
   * Default is `true` and that is deliberate: for a security control, an unrecorded grant should fail
   * closed. Set false only where the ledger is advisory.
   */
  strict?: boolean;
}

export function buildRecord(args: {
  parentId: string;
  childId: string;
  depth: number;
  agentType?: string;
  requested: Capability[];
  parentGrant: Capability[];
  result: ResolveResult;
  blocked: boolean;
  reason?: string;
  approved?: Capability[];
  approvalSources?: Record<Capability, ApprovalSource>;
  approvalScopes?: Record<Capability, ApprovalScope>;
  humanDenied?: boolean;
  gateOutcome?: PromptOutcomeKind;
  definitionDigest?: DefinitionDigest;
  /** Where the child ran (ADR-0031). Required: the probe's answer survives nowhere else. */
  executor: ExecutorKind;
  /** The child whose output composed this task (ADR-0033). Absent for anything but a chain step. */
  taskFrom?: string;
  now: Date;
}): GrantRecord {
  // R-46: the scalar is a SUMMARY, emitted only when it cannot mislead. `buildRecord` derives it rather
  // than accepting it, so a call site cannot supply one that disagrees with the map beside it.
  const sources = args.approvalSources ?? {};
  const distinct = [...new Set(Object.values(sources))];
  const scopes = args.approvalScopes ?? {};
  const distinctScopes = [...new Set(Object.values(scopes))];
  return {
    ts: args.now.toISOString(),
    parentId: args.parentId,
    childId: args.childId,
    depth: args.depth,
    agentType: args.agentType,
    executor: args.executor,
    ...(args.taskFrom ? { taskFrom: args.taskFrom } : {}),
    requested: args.requested,
    parentGrant: args.parentGrant,
    effective: args.result.effective,
    denied: args.result.denied,
    clipped: args.result.clipped,
    gatedBlocked: args.result.gatedBlocked,
    blocked: args.blocked,
    reason: args.reason,
    ...(args.approved && args.approved.length > 0 ? { approved: args.approved } : {}),
    ...(distinct.length === 1 ? { approvalSource: distinct[0] } : {}),
    ...(Object.keys(sources).length > 0 ? { approvalSources: sources } : {}),
    ...(distinctScopes.length === 1 ? { approvalScope: distinctScopes[0] } : {}),
    ...(Object.keys(scopes).length > 0 ? { approvalScopes: scopes } : {}),
    ...(args.humanDenied ? { humanDenied: true } : {}),
    // Written whenever a gate was reached and not satisfied by a yes. `granted` is omitted deliberately —
    // an approved spawn already says so through `approvalSources`, and a field that appears on every record
    // stops being a signal.
    ...(args.gateOutcome && args.gateOutcome !== "granted" ? { gateOutcome: args.gateOutcome } : {}),
    ...(args.definitionDigest ? { definitionDigest: args.definitionDigest } : {}),
  };
}

// R-49: the lock moved to `src/file-lock.ts` so the approvals store could use the SAME one rather than
// grow a second copy. Re-exported because `./ledger` is a published subpath and these were part of it.
export { LOCK_TIMEOUT_MS, STALE_LOCK_MS } from "./file-lock.ts";

// The reading half, split out under the file-size guard and re-exported so `./ledger` is unchanged for
// anyone importing it. See `ledger-report.ts` for why the seam is where it is.
export { verifyLedger, type LedgerReport } from "./ledger-report.ts";

/**
 * Serialise appends across processes.
 *
 * **Why the ledger needs it.** For most of this package's life cardinality was bounded to one by `delegate`
 * being blocking, so there was never a second writer. Fan-out removes that: `ENV_LEDGER` propagates to
 * children, so a subtree can have many processes appending to one file.
 *
 * A ledger write that cannot take the lock **fails the delegation closed** — see `appendRecord`'s `strict`
 * — because a child running with granted capabilities and no audit line is what the ledger exists to
 * prevent. That is the opposite of what the approvals store does with the same lock, and deliberately so.
 */
const withLedgerLock = <T>(path: string, write: () => Promise<T>): Promise<T> =>
  withFileLock(path, "grant ledger", write);

export async function appendRecord(options: LedgerOptions, record: GrantRecord): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  try {
    await mkdir(dirname(options.path), { recursive: true });
    // O_APPEND alone is not enough once several processes write to one ledger — see `withLedgerLock`.
    await withLedgerLock(options.path, () => appendFile(options.path, line, { encoding: "utf8", flag: "a" }));
  } catch (error) {
    if (options.strict ?? true) {
      throw new Error(`grant ledger write failed (failing closed): ${String(error)}`);
    }
  }
}

/** True when this record shows an agent asking for more than it holds. */
export function isEscalationAttempt(record: GrantRecord): boolean {
  return record.denied.length > 0;
}
