export const REFUSAL_CODES = [
  "CAPABILITY_ESCALATION",
  "GRANT_ID_MALFORMED",
  "DEFINITION_NOT_AUTHORIZED",
  "UNDECLARED_TOOLS",
  "UNKNOWN_TOOL",
  "GATED_UNAPPROVED",
  "APPROVAL_EXPIRED",
  "APPROVAL_SCOPE_MISMATCH",
  "APPROVAL_FLOW_FAILED",
  "DEPTH_EXCEEDED",
  "FANOUT_EXCEEDED",
  "EXECUTOR_UNAVAILABLE",
  // Execution-phase outcomes. Without these, an external controller could distinguish a policy refusal
  // from an internal error but not a lost writer lease from a user pressing stop (R-103).
  "CHILD_TIMED_OUT",
  "CHILD_CANCELLED",
  "CHILD_EXIT_NONZERO",
  // Planner refusals that previously carried a message and no code at all — including the narrowing
  // violation, which is the hardest rule this package enforces (R-109).
  "TASK_MISSING",
  "UNKNOWN_DEFINITION",
  "CEILING_PATTERNS_UNRESOLVED",
  "NARROWING_VIOLATED",
  "DEFINITION_UNREADABLE",
  "CORRELATION_TOO_LARGE",
  "CORRELATION_INVALID",
  "LEDGER_WRITE_FAILED",
  "FANOUT_FAILED",
  "WORKSPACE_NOT_REGISTERED",
  "WORKSPACE_NOT_AUTHORIZED",
  "WORKSPACE_REGISTRY_CHANGED",
  "WORKSPACE_WRITE_CONFLICT",
  "WORKSPACE_LEASE_STALE",
  "CHECK_NOT_CONFIGURED",
  "CHECK_CONFIGURATION_INVALID",
  "CHECK_IDENTITY_UNAVAILABLE",
  "CHECK_IDENTITY_MISMATCH",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface StructuredRefusal {
  code: RefusalCode;
  /** Existing actionable diagnostic. Codes accompany rather than replace it. */
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

export function refusal(
  code: RefusalCode,
  message: string,
  details?: StructuredRefusal["details"],
): StructuredRefusal {
  return { code, message, ...(details && Object.keys(details).length > 0 ? { details: { ...details } } : {}) };
}

/** Error shape for API callers. pi-facing tools still throw, as pi requires, while retaining a stable code. */
export class GovernanceRefusal extends Error {
  readonly code: RefusalCode;
  readonly details?: StructuredRefusal["details"];

  constructor(value: StructuredRefusal) {
    super(value.message);
    this.name = "GovernanceRefusal";
    this.code = value.code;
    this.details = value.details;
  }
}
