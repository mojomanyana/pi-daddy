import { Type } from "typebox";

/** The model-facing form of correlation schema 1.0; runtime validation in src/correlation.ts is the backstop. */
export function correlationShape() {
  const assuranceScope = Type.Union([
    Type.Object({
      type: Type.Literal("entire-run"),
      selectors: Type.Array(Type.String({ minLength: 1 }), { maxItems: 0 }),
    }, { additionalProperties: false }),
    Type.Object({
      type: Type.Literal("selectors"),
      selectors: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    }, { additionalProperties: false }),
  ]);
  return Type.Object({
    schema_version: Type.Optional(Type.Literal("1.0")),
    run_id: Type.Optional(Type.String()),
    task_id: Type.Optional(Type.String()),
    workspace_id: Type.Optional(Type.String()),
    context_id: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
    assurance: Type.Optional(Type.String()),
    assurance_effective: Type.Optional(Type.String()),
    policy_label: Type.Optional(Type.String()),
    assurance_source: Type.Optional(Type.String()),
    assurance_scope: Type.Optional(assuranceScope),
    activated_at: Type.Optional(Type.String()),
    plan_digest: Type.Optional(Type.String()),
    definition_digest: Type.Optional(Type.String()),
    task_digest: Type.Optional(Type.String()),
    base_sha: Type.Optional(Type.String()),
    head_sha: Type.Optional(Type.String()),
    tree_sha: Type.Optional(Type.String()),
    event_seq: Type.Optional(Type.Number()),
    last_change_seq: Type.Optional(Type.Number()),
    last_authority_seq: Type.Optional(Type.Number()),
    check_receipt_id: Type.Optional(Type.String()),
  }, { additionalProperties: false });
}
