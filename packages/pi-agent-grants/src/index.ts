export {
  resolve,
  assertNarrowing,
  toPiToolsAllowlist,
  UNIVERSAL_CAPABILITIES,
  type Capability,
  type ResolveInput,
  type ResolveResult,
} from "./resolve.ts";

export {
  appendRecord,
  buildRecord,
  isEscalationAttempt,
  type GrantRecord,
  type LedgerOptions,
} from "./ledger.ts";

export { planSpawn, type SpawnPlan, type SpawnPlanInput } from "./spawn.ts";

export {
  APPROVAL_TTL_DAYS,
  DELEGATE_SUBJECT,
  approvalKey,
  entryVerdict,
  expiryFor,
  inheritApprovals,
  offeredScopes,
  resolveApprovals,
  shouldSeekApproval,
  type ApprovalEntry,
  type ApprovalPath,
  type ApprovalScope,
  type ApprovalSource,
  type EntryVerdict,
} from "./approval.ts";

export {
  approvalsPath,
  loadApprovals,
  revokeAll,
  revokeApproval,
  saveApproval,
  type DroppedApproval,
} from "./approval-store.ts";

export {
  createApprovalGate,
  createApprovalGateProvider,
  timeoutMsFromEnv,
  type ApprovalGate,
  type InFlightApprovals,
  type ApprovalUI,
  type PromptOutcome,
  type PromptOutcomeKind,
  type PromptRequest,
} from "./approval-prompt.ts";
