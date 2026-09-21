export {
  resolve,
  assertNarrowing,
  toPiToolsAllowlist,
  UNIVERSAL_CAPABILITIES,
  type Capability,
  type ResolveInput,
  type ResolveResult,
} from "./kernel/resolve.ts";

export {
  appendLedgerEvent,
  appendRecord,
  buildChildLifecycleEvent,
  buildRecord,
  buildWorkspaceLeaseEvent,
  isEscalationAttempt,
  LEDGER_VERSION,
  type ChildLifecycleEvent,
  type GrantRecord,
  type LedgerOptions,
  type RuntimeLedgerEvent,
  type WorkspaceLeaseEvent,
  type WorkspaceLeaseOutcome,
} from "./governance/ledger.ts";

export { planSpawn, type SpawnPlan, type SpawnPlanInput } from "./kernel/spawn.ts";
export {
  beginExecutionRetention,
  drainExecutionRetention,
  ENV_EXECUTION_ARCHIVE,
  RETENTION_VERSION,
  retentionConfigurationDigest,
  verifyRetainedBytes,
  type ExecutionRetentionManifest,
  type RetainedContent,
  type RetentionIdentity,
  type RetentionStatus,
  type ExecutionRetention,
  buildExecutionRetentionManifest,
  parseExecutionRetentionManifest,
  RETENTION_SCHEMA,
  ENV_NATIVE_SESSION_ROOT,
  readNativeSession,
  parseNativeSessionBytes,
  type NativeSessionObservation,
  type NativeSessionManager,
} from "./governance/execution-retention.ts";

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
} from "./kernel/approval.ts";

export {
  approvalsPath,
  loadApprovals,
  revokeAll,
  revokeApproval,
  saveApproval,
  type DroppedApproval,
  type SubjectLookup,
} from "./governance/approval-store.ts";

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
} from "./kernel/correlation.ts";

export {
  GovernanceRefusal,
  REFUSAL_CODES,
  refusal,
  type RefusalCode,
  type StructuredRefusal,
} from "./kernel/refusals.ts";

export {
  loadWorkspaceRegistry,
  resolveWorkspace,
  validateRegisteredWorkspace,
  type ValidatedWorkspace,
  type WorkspaceAccess,
  type WorkspaceRegistryFile,
} from "./kernel/workspace.ts";

export { acquireWorkspaceLease, defaultWorkspaceLeaseDir, type WorkspaceLease } from "./governance/workspace-lease.ts";

export { isExecutionId, newExecutionId, type ExecutionId } from "./kernel/execution-id.ts";

export {
  parseDashboardLedger,
  type DashboardNode,
  type DashboardProjection,
  type DashboardState,
  type DashboardWorkflow,
} from "./products/dashboard-projection.ts";

export { renderDashboard, type DashboardRenderOptions } from "./products/dashboard-render.ts";

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
} from "./governance/approval-prompt.ts";

// ADR-0076 cleanup: the `pi-daddy/kernel`, `/ledger`, `/approvals`, `/executors` and `/dashboard` subpaths are
// gone; the root is the one public surface. Wildcard re-exports of the layers keep every name reachable.
export * from "./kernel/capabilities.ts";
export * from "./kernel/catalog.ts";
export * from "./kernel/chain.ts";
export * from "./kernel/definitions.ts";
export * from "./kernel/delegate-types.ts";
export * from "./kernel/delegate.ts";
export * from "./kernel/delegation-approval.ts";
export * from "./kernel/env-names.ts";
export * from "./kernel/fanout.ts";
export * from "./kernel/grant-env.ts";
export * from "./kernel/ledger-identifiers.ts";
export * from "./kernel/model-preflight.ts";
export * from "./kernel/pi-tools.ts";
export * from "./kernel/progress.ts";
export * from "./kernel/propagation.ts";
export * from "./kernel/routing-authority.ts";
export * from "./kernel/run-child.ts";
export * from "./kernel/skill-packages.ts";
export * from "./kernel/skill-resources.ts";
export * from "./governance/ledger-events.ts";
export * from "./governance/ledger-report.ts";
export * from "./governance/ledger-v3-validation.ts";
export * from "./governance/record.ts";
export * from "./governance/retention-json.ts";
export * from "./governance/finalization.ts";
export * from "./governance/grant-store.ts";
export * from "./governance/lease-helper.ts";
export * from "./governance/lease-record.ts";
export * from "./governance/file-lock.ts";
export * from "./governance/init.ts";
export * from "./executors/executor.ts";
export * from "./executors/herdr-cli.ts";
export * from "./executors/herdr-name.ts";
export * from "./executors/herdr-pi-lifecycle.ts";
export * from "./executors/herdr-poll.ts";
export * from "./executors/herdr-stage.ts";
export * from "./executors/herdr-start.ts";
export * from "./executors/native-session-target.ts";
export * from "./executors/pane-reaper.ts";
export * from "./executors/run-herdr.ts";
export * from "./products/dashboard-display-controls.ts";
export * from "./products/dashboard-handshake.ts";
export * from "./products/dashboard-herdr.ts";
export * from "./products/activity-timeline.ts";
export { runDashboard, dashboardFrame, DASHBOARD_PROTOCOL_VERSION } from "./products/dashboard-cli.ts";
