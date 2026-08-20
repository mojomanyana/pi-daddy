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
  appendLedgerEvent,
  appendRecord,
  buildChildLifecycleEvent,
  buildRecord,
  buildWorkspaceLeaseEvent,
  isEscalationAttempt,
  LEDGER_VERSION,
  type CheckReceiptLedgerEvent,
  type ChildLifecycleEvent,
  type GrantRecord,
  type LedgerOptions,
  type RuntimeLedgerEvent,
  type WorkspaceLeaseEvent,
  type WorkspaceLeaseOutcome,
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
  type SubjectSnapshot,
} from "./approval.ts";

export {
  approvalsPath,
  loadApprovals,
  revokeAll,
  revokeApproval,
  saveApproval,
  type DroppedApproval,
  type SubjectLookup,
} from "./approval-store.ts";

export {
  approvalBindingDigest,
  approvalBindingsEqual,
  buildApprovalBinding,
  digestCapabilities,
  digestTask,
  isApprovalBinding,
  normaliseCorrelation,
  type ApprovalBinding,
  type CorrelationMetadata,
  type JsonValue,
} from "./correlation.ts";

export {
  GovernanceRefusal,
  REFUSAL_CODES,
  refusal,
  type RefusalCode,
  type StructuredRefusal,
} from "./refusals.ts";

export {
  acquireWorkspaceLease,
  defaultWorkspaceLeaseDir,
  loadWorkspaceRegistry,
  resolveWorkspace,
  validateRegisteredWorkspace,
  type ValidatedWorkspace,
  type WorkspaceAccess,
  type WorkspaceLease,
  type WorkspaceRegistryFile,
} from "./workspace.ts";

export {
  buildCheckEnvironment,
  runNamedCheck,
  type CheckDefinition,
  type CheckReceipt,
  type CheckRegistry,
} from "./check-runner.ts";

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
