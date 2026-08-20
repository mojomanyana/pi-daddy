import { DELEGATE_SUBJECT, type InheritableApproval } from "./approval.ts";
import { agentCapability } from "./capabilities.ts";
import {
  approvalBindingsEqual,
  buildApprovalBinding,
  type ApprovalBinding,
  type CorrelationMetadata,
} from "./correlation.ts";
import type { DefinitionDigest, SkillDefinition } from "./definitions.ts";
import { AGENT_WILDCARD, resolve, type Capability, type ResolveResult } from "./resolve.ts";

/**
 * Resolve the approval half of one delegation after its requested capability set is known.
 *
 * Kept as one function because the ordering is security-relevant: compute the unapproved and potential
 * effective sets first, derive the exact binding from those trusted values, then decide which approvals
 * match. An approval must never define the scope against which it is checked.
 */
export function resolveDelegationApproval(input: {
  task: string;
  agent?: string;
  requested: Capability[];
  parentGrant: Capability[];
  gated: Capability[];
  approved?: InheritableApproval[];
  spawned?: SkillDefinition;
  definitionDigest?: DefinitionDigest;
  /**
   * Present iff this call is task-bound. Its VALUES never enter the binding — only its presence selects
   * the exact-bound regime over the legacy subject-scoped one.
   */
  correlation?: CorrelationMetadata;
  /** Trusted: an id that was resolved against the operator registry and leased. Never a caller claim. */
  boundWorkspaceId?: string;
  /** Caller-declared label. Narrows the binding only; asserts nothing about enforcement. */
  boundContextId?: string;
  parentId: string;
}): { result: ResolveResult; approvalBinding?: ApprovalBinding; bindingMismatch: boolean } {
  const subject = input.agent ?? DELEGATE_SUBJECT;
  const unapproved = resolve({
    requested: input.requested,
    parentGrant: input.parentGrant,
    gated: input.gated,
    approved: [],
  });

  // ADR-0024: a definition's authorising id is gated as the PARENT's authority to run it now. It never
  // joins requested/effective, because that would hand the child authority to recursively spawn itself.
  let authorisingCapability: Capability | undefined;
  if (input.spawned) {
    const authorising = agentCapability(input.spawned.name);
    if (input.gated.includes(authorising) || input.gated.includes(AGENT_WILDCARD)) {
      authorisingCapability = authorising;
      unapproved.gatedBlocked = [...unapproved.gatedBlocked, authorising];
    }
  }

  const potential = resolve({
    requested: input.requested,
    parentGrant: input.parentGrant,
    gated: input.gated,
    // If the definition also declares its own authorising `agent:<name>`, the same approval unblocks
    // that requested child capability too; excluding it here would bind a smaller set than we provision.
    approved: unapproved.gatedBlocked,
  });
  const approvalBinding = input.correlation
    ? buildApprovalBinding({
        task: input.task,
        requested: input.requested,
        effective: potential.effective,
        definitionSha256: input.definitionDigest?.sha256,
        parentId: input.parentId,
        workspaceId: input.boundWorkspaceId,
        contextId: input.boundContextId,
      })
    : undefined;

  const forSubject = (input.approved ?? []).filter((approval) => approval.subject === subject);
  const approvedCapabilities = forSubject
    .filter((approval) =>
      approvalBinding
        ? approvalBindingsEqual(approval.binding, approvalBinding)
        : approval.binding === undefined,
    )
    .map((approval) => approval.capability);
  const bindingMismatch = approvalBinding !== undefined && forSubject.some(
    (approval) => approval.binding !== undefined && !approvalBindingsEqual(approval.binding, approvalBinding),
  );
  const result = resolve({
    requested: input.requested,
    parentGrant: input.parentGrant,
    gated: input.gated,
    approved: approvedCapabilities,
  });
  if (authorisingCapability && !approvedCapabilities.includes(authorisingCapability)) {
    result.gatedBlocked = [...result.gatedBlocked, authorisingCapability];
  }
  return { result, ...(approvalBinding ? { approvalBinding } : {}), bindingMismatch };
}
