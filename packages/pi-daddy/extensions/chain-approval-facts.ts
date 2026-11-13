import type { InheritableApproval } from "../src/kernel/approval.ts";
import type { Capability } from "../src/kernel/resolve.ts";
import type { ApprovalOutcome } from "./approvals.ts";

/** An upfront Auto answer is provisional until an actual step admission, never consumed approval evidence. */
export function retainedChainApproval(outcome: ApprovalOutcome): ApprovalOutcome | undefined {
  const approved = outcome.approved.filter((capability) => outcome.sources[capability] !== "auto");
  if (!approved.length) return undefined;
  const keep = new Set(approved);
  const filter = <T>(values: Record<Capability, T>): Record<Capability, T> =>
    Object.fromEntries(Object.entries(values).filter(([capability]) => keep.has(capability)));
  return {
    ...outcome,
    approved,
    sources: filter(outcome.sources),
    scopes: filter(outcome.scopes),
    recordedScopes: filter(outcome.recordedScopes),
    bindings: filter(outcome.bindings),
    expiresAt: filter(outcome.expiresAt),
    uses: filter(outcome.uses),
    ...(outcome.banked ? { banked: outcome.banked.filter((entry) => keep.has(entry.capability)) } : {}),
  };
}

export interface ChainApprovalAudit {
  sources: Map<string, ApprovalOutcome["sources"][Capability]>;
  scopes: Map<string, ApprovalOutcome["recordedScopes"][Capability]>;
  expiresAt: Map<string, string>;
  uses: Map<string, { max: number; remaining: number }>;
}

export function newChainApprovalAudit(): ChainApprovalAudit {
  return { sources: new Map(), scopes: new Map(), expiresAt: new Map(), uses: new Map() };
}

export function rememberChainApproval(
  audit: ChainApprovalAudit,
  capability: Capability,
  subject: string,
  outcome: ApprovalOutcome,
): void {
  const key = `${capability}@${subject}`;
  const source = outcome.sources[capability];
  const scope = outcome.recordedScopes[capability];
  if (source) audit.sources.set(key, source);
  if (scope) audit.scopes.set(key, scope);
  const expiresAt = outcome.expiresAt[capability];
  if (expiresAt) audit.expiresAt.set(key, expiresAt);
  const uses = outcome.uses[capability];
  if (uses) audit.uses.set(key, uses);
}

export function chainApprovalFacts(
  audit: ChainApprovalAudit,
  available: InheritableApproval[],
  subject: string,
): Pick<ApprovalOutcome, "approved" | "sources" | "scopes" | "expiresAt" | "uses" | "humanDenied"> {
  const entries = available.filter((approval) => approval.subject === subject);
  const values = <T>(map: Map<string, T>) =>
    Object.fromEntries(
      entries.flatMap((approval) => {
        const value = map.get(`${approval.capability}@${approval.subject}`);
        return value === undefined ? [] : [[approval.capability, value]];
      }),
    );
  return {
    approved: entries.map((approval) => approval.capability),
    sources: values(audit.sources),
    scopes: values(audit.scopes),
    expiresAt: values(audit.expiresAt),
    uses: values(audit.uses),
    humanDenied: false,
  };
}
