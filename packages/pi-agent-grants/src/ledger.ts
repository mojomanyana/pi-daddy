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
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Capability, ResolveResult } from "./resolve.ts";
import type { ApprovalScope, ApprovalSource } from "./approval.ts";

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
  /** Present only when the source was a live prompt. */
  approvalScope?: ApprovalScope;
  /** A human was asked and declined. Distinct from `denied`, which is an escalation attempt. */
  humanDenied?: boolean;
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
  approvalSource?: ApprovalSource;
  approvalScope?: ApprovalScope;
  humanDenied?: boolean;
  now: Date;
}): GrantRecord {
  return {
    ts: args.now.toISOString(),
    parentId: args.parentId,
    childId: args.childId,
    depth: args.depth,
    agentType: args.agentType,
    requested: args.requested,
    parentGrant: args.parentGrant,
    effective: args.result.effective,
    denied: args.result.denied,
    clipped: args.result.clipped,
    gatedBlocked: args.result.gatedBlocked,
    blocked: args.blocked,
    reason: args.reason,
    ...(args.approved && args.approved.length > 0 ? { approved: args.approved } : {}),
    ...(args.approvalSource ? { approvalSource: args.approvalSource } : {}),
    ...(args.approvalScope ? { approvalScope: args.approvalScope } : {}),
    ...(args.humanDenied ? { humanDenied: true } : {}),
  };
}

export async function appendRecord(options: LedgerOptions, record: GrantRecord): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  try {
    await mkdir(dirname(options.path), { recursive: true });
    // O_APPEND keeps concurrent writers from interleaving partial lines.
    await appendFile(options.path, line, { encoding: "utf8", flag: "a" });
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
