import { createHash } from "node:crypto";
import type { DefinitionDigest } from "./definitions.ts";
import type { Capability } from "./resolve.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Non-authoritative workflow metadata copied onto runtime and ledger events.
 *
 * pi-daddy deliberately does not interpret assurance labels, sources, scope selectors, timestamps or
 * sequence floors. In particular, a digest-looking value here never substitutes for a digest computed by
 * the planner. The snake_case names are the wire vocabulary used by external controllers.
 */
export interface CorrelationMetadata {
  schema_version?: string;
  run_id?: string;
  task_id?: string;
  workspace_id?: string;
  context_id?: string;
  phase?: string;
  assurance?: string;
  assurance_effective?: string;
  policy_label?: string;
  assurance_source?: string;
  assurance_scope?: JsonValue;
  activated_at?: string;
  plan_digest?: string;
  definition_digest?: string;
  task_digest?: string;
  base_sha?: string;
  head_sha?: string;
  tree_sha?: string;
  event_seq?: number;
  last_change_seq?: number;
  last_authority_seq?: number;
  check_receipt_id?: string;
}

const MAX_CORRELATION_BYTES = 32 * 1024;

/** Snapshot bounded JSON metadata so a caller cannot mutate a record after planning. */
export function normaliseCorrelation(input: CorrelationMetadata | undefined): CorrelationMetadata | undefined {
  if (input === undefined) return undefined;
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch (error) {
    throw new Error(`correlation metadata must be JSON serializable (${String(error)})`);
  }
  if (encoded === undefined) throw new Error("correlation metadata must be a JSON object");
  if (Buffer.byteLength(encoded) > MAX_CORRELATION_BYTES) {
    throw new Error(`correlation metadata exceeds ${MAX_CORRELATION_BYTES} bytes`);
  }
  const parsed = JSON.parse(encoded) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("correlation metadata must be a JSON object");
  }
  return parsed as CorrelationMetadata;
}

export function digestTask(task: string): string {
  return createHash("sha256").update(task, "utf8").digest("hex");
}

export function digestCapabilities(capabilities: readonly Capability[]): string {
  const canonical = [...new Set(capabilities)].sort();
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/** Trusted, internally-computed scope of one gated approval. */
export interface ApprovalBinding {
  version: "1";
  task_sha256: string;
  requested_sha256: string;
  effective_sha256: string;
  requested: Capability[];
  effective: Capability[];
  definition_sha256?: string;
  workspace_id?: string;
  context_id?: string;
  parent_id: string;
}

export function buildApprovalBinding(input: {
  task: string;
  requested: readonly Capability[];
  effective: readonly Capability[];
  definitionSha256?: DefinitionDigest["sha256"] | string;
  parentId: string;
  correlation?: CorrelationMetadata;
}): ApprovalBinding {
  const requested = [...new Set(input.requested)].sort();
  const effective = [...new Set(input.effective)].sort();
  return {
    version: "1",
    task_sha256: digestTask(input.task),
    requested_sha256: digestCapabilities(requested),
    effective_sha256: digestCapabilities(effective),
    requested,
    effective,
    ...(input.definitionSha256 ? { definition_sha256: input.definitionSha256 } : {}),
    ...(input.correlation?.workspace_id ? { workspace_id: input.correlation.workspace_id } : {}),
    ...(input.correlation?.context_id ? { context_id: input.correlation.context_id } : {}),
    parent_id: input.parentId,
  };
}

export function approvalBindingDigest(binding: ApprovalBinding): string {
  const ordered = {
    version: binding.version,
    task_sha256: binding.task_sha256,
    requested_sha256: binding.requested_sha256,
    effective_sha256: binding.effective_sha256,
    requested: binding.requested,
    effective: binding.effective,
    definition_sha256: binding.definition_sha256 ?? null,
    workspace_id: binding.workspace_id ?? null,
    context_id: binding.context_id ?? null,
    parent_id: binding.parent_id,
  };
  return createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}

export function isApprovalBinding(value: unknown): value is ApprovalBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Partial<ApprovalBinding>;
  return binding.version === "1" &&
    [binding.task_sha256, binding.requested_sha256, binding.effective_sha256].every(
      (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/i.test(digest),
    ) &&
    Array.isArray(binding.requested) && binding.requested.every((item) => typeof item === "string") &&
    Array.isArray(binding.effective) && binding.effective.every((item) => typeof item === "string") &&
    typeof binding.parent_id === "string";
}

export function approvalBindingsEqual(a: ApprovalBinding | undefined, b: ApprovalBinding | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (!isApprovalBinding(a) || !isApprovalBinding(b)) return false;
  return approvalBindingDigest(a) === approvalBindingDigest(b);
}
