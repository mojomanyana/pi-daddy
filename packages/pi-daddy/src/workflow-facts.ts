import { LEDGER_VERSION } from "./ledger.ts";
import { normaliseCorrelation, type CorrelationMetadata } from "./correlation.ts";
import { isWorkflowFactId, isWorkflowIdentifier, workflowFactStateMatches } from "./workflow-fact-id.ts";
import { assertLedgerV3Wire } from "./ledger-v3-validation.ts";

export const WORKFLOW_FACT_PROVENANCE = ["planned", "observed", "controller_validated"] as const;
export type WorkflowFactProvenance = typeof WORKFLOW_FACT_PROVENANCE[number];
export const WORKFLOW_FACT_KINDS = ["workflow_phase", "inline_skill", "transition"] as const;
export type WorkflowFactKind = typeof WORKFLOW_FACT_KINDS[number];
export const WORKFLOW_FACT_STATES = ["pending", "observed", "started", "completed", "blocked"] as const;
export type WorkflowFactState = typeof WORKFLOW_FACT_STATES[number];

export interface WorkflowFactEvent {
  ledgerVersion: typeof LEDGER_VERSION;
  event: "workflow_fact";
  ts: string;
  factId: string;
  /** Package/controller identifier, not free-form display text. */
  source: string;
  provenance: WorkflowFactProvenance;
  kind: WorkflowFactKind;
  /** Phase, skill, or transition identifier. Never task text. */
  subject: string;
  state: WorkflowFactState;
  /** run_id is required by the builder; other values remain non-authoritative labels. */
  correlation: CorrelationMetadata;
}

export function buildWorkflowFactEvent(args: {
  factId: string;
  source: string;
  provenance: WorkflowFactProvenance;
  kind: WorkflowFactKind;
  subject: string;
  state: WorkflowFactState;
  correlation: CorrelationMetadata;
  now: Date;
}): WorkflowFactEvent {
  if (!isWorkflowFactId(args.factId)) throw new TypeError("factId must be a pi-daddy workflow fact id");
  if (!isWorkflowIdentifier(args.source)) throw new TypeError("workflow fact source must be an identifier");
  if (!WORKFLOW_FACT_PROVENANCE.includes(args.provenance)) throw new TypeError("workflow fact provenance is not recognised");
  if (!WORKFLOW_FACT_KINDS.includes(args.kind)) throw new TypeError("workflow fact kind is not recognised");
  if (!isWorkflowIdentifier(args.subject)) throw new TypeError("workflow fact subject must be an identifier, not task text");
  if (!WORKFLOW_FACT_STATES.includes(args.state)) throw new TypeError("workflow fact state is not recognised");
  const correlation = normaliseCorrelation(args.correlation);
  if (!correlation?.run_id) throw new TypeError("workflow facts require correlation.run_id");
  if (!workflowFactStateMatches(args.provenance, args.state)) {
    const expected = args.provenance === "planned" ? "pending" : args.provenance === "observed"
      ? "observed" : "started, completed, or blocked";
    throw new TypeError(`${args.provenance.replaceAll("_", "-")} workflow facts must use ${expected}`);
  }
  const event: WorkflowFactEvent = {
    ledgerVersion: LEDGER_VERSION,
    event: "workflow_fact",
    ts: args.now.toISOString(),
    factId: args.factId,
    source: args.source,
    provenance: args.provenance,
    kind: args.kind,
    subject: args.subject,
    state: args.state,
    correlation,
  };
  return assertLedgerV3Wire(event);
}
