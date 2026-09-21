const WORKFLOW_FACT_ID_RE = /^fact:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKFLOW_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function isWorkflowFactId(value: unknown): value is string {
  return typeof value === "string" && WORKFLOW_FACT_ID_RE.test(value);
}

export function isWorkflowIdentifier(value: unknown): value is string {
  return typeof value === "string" && WORKFLOW_IDENTIFIER_RE.test(value);
}

export function workflowFactStateMatches(provenance: unknown, state: unknown): boolean {
  return (provenance === "planned" && state === "pending") ||
    (provenance === "observed" && state === "observed") ||
    (provenance === "controller_validated" && ["started", "completed", "blocked"].includes(String(state)));
}
