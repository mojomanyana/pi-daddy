export const REFUSAL_CODES = [
  "CAPABILITY_ESCALATION",
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
  "WORKSPACE_NOT_REGISTERED",
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
