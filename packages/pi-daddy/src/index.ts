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
  buildCheckReceiptLedgerEvent,
  buildChildLifecycleEvent,
  buildRecord,
  buildWorkspaceLeaseEvent,
  buildWorkflowFactEvent,
  WORKFLOW_FACT_KINDS,
  WORKFLOW_FACT_PROVENANCE,
  WORKFLOW_FACT_STATES,
  isEscalationAttempt,
  LEDGER_VERSION,
  type CheckReceiptLedgerEvent,
  type ChildLifecycleEvent,
  type GrantRecord,
  type LedgerOptions,
  type RuntimeLedgerEvent,
  type WorkspaceLeaseEvent,
  type WorkspaceLeaseOutcome,
  type WorkflowFactEvent,
  type WorkflowFactKind,
  type WorkflowFactProvenance,
  type WorkflowFactState,
} from "./governance/ledger.ts";

export {
  createDebriefPresenter,
  type DebriefPresenter,
  type DebriefHost,
  type DebriefFrame,
  type DebriefCheckpoint,
  type DebriefPersistence,
} from "./products/debrief.ts";
export {
  ordinaryChildrenFor,
  ordinaryCancellation,
  ordinaryCancellationDigest,
  isOrdinaryChildren,
  type OrdinaryChildren,
  type OrdinaryCancellation,
  type OrdinaryAuthority,
  type OrdinaryTarget,
} from "./products/ordinary-children.ts";
export {
  loadDashboardHarness,
  loadedDashboardHarnessDigest,
  type DashboardHarnessArtifact,
} from "./products/dashboard-harness.ts";
export {
  startDailyDashboardHost,
  discoverDailyIntentActions,
  type DailyDashboardHostInput,
  type DailyIntentAction,
} from "./products/daily-dashboard-host.ts";
export {
  createDashboardHost,
  openDashboardHost,
  dashboardHostDigest,
  dashboardHostRequestDigest,
  dashboardSelectionDigest,
  type DashboardHost,
  type DashboardHostConfig,
  type DashboardHostRequest,
  type DashboardHostAuthority,
  type DashboardHarness,
  type DashboardHostOptions,
} from "./products/dashboard-host.ts";
export {
  serveDashboardHost,
  connectDashboardHost,
  ENV_DASHBOARD_HOST_SOCKET,
  type DashboardConnection,
} from "./products/dashboard-host-transport.ts";
export {
  createRetainedDebrief,
  retainDebriefBlind,
  openDebriefBlindPreview,
  type DebriefHarness,
  type CaseSelection,
  type DurableBlindBinding,
} from "./products/debrief-host.ts";
export { renderDebrief, debriefAction as dashboardDebriefAction } from "./products/debrief-render.ts";
export { type ReviewPort, type ReviewRequest, type BlindPort, type BlindChoice } from "./products/debrief-contract.ts";
export {
  readDailyView,
  createDailyViewReader,
  DAILY_VIEW_VERSION,
  type DailyView,
  type DailyViewOptions,
  type DailyAttempt,
  type DailyObligation,
} from "./products/daily-view.ts";
export { renderDailyView, renderDailyDetails } from "./products/daily-view-render.ts";
export { renderDailyPanel, type PanelOptions, type WorkPresentation } from "./products/daily-panel.ts";
export { parseArchiveProjection, ARCHIVE_PROJECTION_VERSION } from "./products/daily-view-input.ts";
export { bindWorkIntent } from "./products/intent-application.ts";
export {
  intentRequestDigest,
  parseIntentRequest,
  type IntentRequest,
  type IntentSelection,
  type IntentPriority,
  type IntentAdmission,
  type IntentSnapshot,
  type IntentReceipt,
  type WorkIntentBinding,
} from "./products/intent-control.ts";
export {
  dispatchRequestDigest,
  parseDispatchRequest,
  type DispatchRequest,
  type DispatchAuthority,
  type DispatchRecord,
  type DispatchSnapshot,
} from "./products/dispatch-control.ts";
export {
  createFactoryRegistry,
  openFactoryRegistry,
  createFactoryOrder,
  openFactoryOrder,
  migrateFactoryOrder,
  factoryOrderDigest,
  parseFactoryOrder,
  fixedPolicyDigest,
  factoryDecisionDigest,
  activationRequestDigest,
  factoryMigrationDigest,
  type FactoryRegistryBinding,
  type FactoryOrderCharter,
  type FactoryAuthority,
  type FactoryOrderView,
  type FixedPolicy,
  type ActivationRequest,
  type FactoryMigration,
} from "./products/factory-order.ts";
export {
  createExperiment,
  openExperiment,
  experimentCharterDigest,
  experimentBindingDigest,
  experimentCancellationDigest,
  parseExperimentCharter,
  type ExperimentBinding,
  type ExperimentCharter,
  type ExperimentAuthority,
  type ExperimentCancellation,
  type ExperimentRun,
  type ExperimentView,
} from "./products/experiment.ts";
export {
  createResourceBudget,
  createDispatchBudget,
  createIntentBudget,
  createExperimentBudget,
  openResourceBudget,
  resourceBindingDigest,
  ResourceAdmissionError,
  type BudgetBinding,
  type DispatchBudgetBinding,
  type IntentBudgetBinding,
  type ExperimentBudgetBinding,
  type GovernedBudgetBinding,
  type ResourceLimits,
  type AttemptDemand,
  type ResourcePermit,
  type BudgetSnapshot,
} from "./products/resource-budget.ts";
export {
  createProducerIpcHost,
  startProducerIpc,
  producerIpcBinding,
  producerIpcBindingDigest,
  producerIpcDemand,
  PRODUCER_IPC_LIMITS,
  type ProducerIpcBinding,
  type ProducerIpcReferences,
  type ProducerIpcContext,
  type ProducerIpcHost,
  type ProducerIpcSnapshot,
  type ProducerIpcRun,
} from "./products/producer-ipc.ts";
export {
  prepareDigestProfile,
  runDigestProfile,
  DIGEST_PROFILE,
  EffectProfileUnavailableError,
  type DigestProfile,
  type DigestAttempt,
} from "./products/effect-profile.ts";
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

export {
  buildCheckEnvironment,
  runNamedCheck,
  type CheckDefinition,
  type CheckReceipt,
  type CheckRegistry,
} from "./governance/check-runner.ts";

export { isExecutionId, newExecutionId, type ExecutionId } from "./kernel/execution-id.ts";

export {
  parseDashboardLedger,
  type DashboardNode,
  type DashboardProjection,
  type DashboardState,
  type DashboardWorkflow,
  type DashboardWorkflowFact,
} from "./products/dashboard-projection.ts";

export { renderDashboard, type DashboardRenderOptions } from "./products/dashboard-render.ts";
export { declareWork, loadDeclaredWork, type DeclaredWorkState } from "./products/work-command.ts";
export {
  workSetup,
  recordWorkSetup,
  selectRecordedWork,
  loadWorkSetup,
  listWorkSetups,
  workPresentation,
  type WorkSetup,
  type WorkTaskSetup,
  type RecordedWorkSetup,
} from "./products/work-setup.ts";
export {
  runWorkSetup,
  inspectWorkRun,
  type WorkRunResult,
  type WorkRunInitial,
  type WorkPolicyPin,
} from "./products/work-run.ts";
export {
  workPolicy,
  workPolicyDigest,
  policyForSetup,
  createWorkPolicyRegistry,
  openWorkPolicyRegistry,
  workPolicyActivationDigest,
  type WorkPolicy,
  type WorkPolicyRegistry,
  type WorkPolicyActivation,
} from "./products/work-policy-registry.ts";
export {
  learningHarness,
  bindLearningConnection,
  loadLearningConnection,
  bindLearningAdoption,
  learningScopeDigest,
  type LearningConnection,
  type LearningWorkspace,
} from "./products/learning-connection.ts";

export {
  runMeasuredAgentSession,
  piSdkMeasuredSessionHost,
  verifyMeasuredSubscription,
  MeasuredSessionFailure,
  MeasuredSessionUnknownError,
  type MeasuredSessionInput,
  type MeasuredSessionHost,
  type MeasuredSessionHostInput,
  type MeasuredSessionHostResult,
  type ProviderUsage,
} from "./products/measured-session.ts";
export {
  createMeasuredOrder,
  openMeasuredOrder,
  measuredOrderDigest,
  measuredOrderAcknowledgementDigest,
  qualifyMeasuredOutput,
  type MeasuredOrder,
  type MeasuredOrderNode,
  type MeasuredOrderAttempt,
  type MeasuredOutputContract,
  type MeasuredOrderBinding,
  type MeasuredOrderAuthority,
  type MeasuredOrderAcknowledgement,
  type MeasuredOrderNodeView,
} from "./products/measured-order.ts";

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
