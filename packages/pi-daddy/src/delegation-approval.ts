import { DELEGATE_SUBJECT, type InheritableApproval } from "./approval.ts";
import { agentCapability, workspaceCapability } from "./capabilities.ts";
import {
  approvalBindingsEqual,
  buildApprovalBinding,
  type ApprovalBinding,
  type CorrelationMetadata,
} from "./correlation.ts";
import type { DefinitionDigest, SkillDefinition } from "./definitions.ts";
import { AGENT_WILDCARD, WORKSPACE_WILDCARD, resolve, type Capability, type ResolveResult } from "./resolve.ts";

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

  /**
   * Authorities the PARENT is spending on this one delegation, gated as such.
   *
   * ADR-0024 established the shape for `agent:<name>`: the id is gated as the parent's authority to run
   * that definition *now*, and never joins requested/effective, because that would hand the child authority
   * to recursively spawn itself. ADR-0035 added a second member of the category — `workspace:<id>`, the
   * authority to route this child somewhere — and shipped without it, so `PI_GRANTS_GATED=workspace:prod`
   * was accepted, recorded, and silently inert: no human was ever asked. The ADR claimed the opposite in
   * three places.
   *
   * A LIST rather than two variables on purpose. This is the third namespace whose authorising id is gated
   * per-delegation rather than granted downward, and the first two were written as one special case each;
   * a fourth should extend an array, not add a third `if` and a third field to thread through.
   */
  const authorisingCapabilities: Capability[] = [];
  const gateAuthority = (authorising: Capability, wildcard: Capability) => {
    if (input.gated.includes(authorising) || input.gated.includes(wildcard)) {
      authorisingCapabilities.push(authorising);
      unapproved.gatedBlocked = [...unapproved.gatedBlocked, authorising];
    }
  };
  if (input.spawned) gateAuthority(agentCapability(input.spawned.name), AGENT_WILDCARD);
  // Trusted: `boundWorkspaceId` is set only from a routing spec resolved against the operator registry,
  // never from a model-supplied `correlation` claim (R-110).
  if (input.boundWorkspaceId) {
    gateAuthority(workspaceCapability(input.boundWorkspaceId), WORKSPACE_WILDCARD);
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
  const stillGated = authorisingCapabilities.filter((c) => !approvedCapabilities.includes(c));
  if (stillGated.length > 0) result.gatedBlocked = [...result.gatedBlocked, ...stillGated];
  return { result, ...(approvalBinding ? { approvalBinding } : {}), bindingMismatch };
}
