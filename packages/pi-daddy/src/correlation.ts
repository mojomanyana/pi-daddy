import { createHash } from "node:crypto";
import type { DefinitionDigest } from "./definitions.ts";
import type { Capability } from "./resolve.ts";
import { GovernanceRefusal, refusal } from "./refusals.ts";
import { isLedgerCorrelationIdentifier } from "./ledger-identifiers.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface AssuranceScope {
  type: "entire-run" | "selectors";
  selectors: string[];
}

/**
 * Non-authoritative workflow metadata copied onto runtime and ledger events.
 *
 * pi-daddy interprets only the pinned correlation wire contract: schema version 1.0 and the closed
 * assurance-scope shape. Labels, selector meanings, timestamps and sequence floors remain non-authoritative.
 * In particular, a digest-looking value here never substitutes for a digest computed by the planner. The
 * snake_case names are the wire vocabulary used by external controllers.
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
  assurance_scope?: AssuranceScope;
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
/**
 * Per-field bound on the STRING fields — most are an id, a digest, a label or a timestamp. It does not
 * apply to the three sequence numbers or to `assurance_scope`, which are checked separately; an earlier
 * version of this comment claimed it covered every declared field.
 */
const MAX_CORRELATION_FIELD_CHARS = 512;
/** `assurance_scope` is the one structured field, so it gets its own, larger bound. */
const MAX_CORRELATION_SCOPE_BYTES = 4 * 1024;

/**
 * The exact field set of the pinned schema 1.0 contract. Anything else is refused by name.
 *
 * This is a whitelist rather than a size cap because `correlation` is a MODEL-FACING tool parameter that
 * is copied verbatim onto every append-only ledger event. `src/ledger.ts` states the invariant — capability
 * ids, counts and identifiers only, never prompts, tool arguments or results — and ADR-0034 repeats that the
 * ledger must never carry task text. A 32 KB "bounded JSON object" with no key whitelist and no per-field
 * length bound satisfied neither: `assurance_scope` was declared `Type.Any()`, undeclared keys survived the
 * round trip, and every string was unbounded, so a model could write 32 KB of arbitrary text into the
 * ledger through it (R-111). Refusing an unknown key is also the loud option: if upstream adds a field, the
 * refusal names it, which is an actionable break rather than a silent secrets sink.
 */
const CORRELATION_FIELDS = new Set<keyof CorrelationMetadata>([
  "schema_version", "run_id", "task_id", "workspace_id", "context_id", "phase", "assurance",
  "assurance_effective", "policy_label", "assurance_source", "assurance_scope", "activated_at",
  "plan_digest", "definition_digest", "task_digest", "base_sha", "head_sha", "tree_sha",
  "event_seq", "last_change_seq", "last_authority_seq", "check_receipt_id",
]);

const CORRELATION_NUMERIC = new Set<keyof CorrelationMetadata>([
  "event_seq", "last_change_seq", "last_authority_seq",
]);

// These fields are rendered as labels/identities. Treating arbitrary prose as an "id" let a model copy
// task or output text into the ledger and dashboard through correlation while staying schema-valid.
const CORRELATION_IDENTIFIERS = new Set<keyof CorrelationMetadata>([
  "schema_version", "run_id", "task_id", "workspace_id", "context_id", "phase", "assurance",
  "assurance_effective", "policy_label", "assurance_source",
]);

function correlationRefusal(message: string, details?: Record<string, string | number>): GovernanceRefusal {
  return new GovernanceRefusal(refusal("CORRELATION_INVALID", `correlation metadata: ${message}`, details));
}

/**
 * Size refusals get their own code, because they call for a different response: "you sent too much" is
 * retryable by truncating, "you sent a field we do not recognise" is not. `CORRELATION_TOO_LARGE` was
 * declared in the taxonomy and constructed nowhere, so the union advertised a distinction the code did not
 * make — and the enumeration test kept the dead member green.
 */
function correlationTooLarge(message: string, details?: Record<string, string | number>): GovernanceRefusal {
  return new GovernanceRefusal(refusal("CORRELATION_TOO_LARGE", `correlation metadata: ${message}`, details));
}

function normaliseAssuranceScope(value: unknown): AssuranceScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw correlationRefusal("assurance_scope must be an object with type and selectors");
  }
  const scope = value as Record<string, unknown>;
  const keys = Object.keys(scope).sort();
  if (keys.length !== 2 || keys[0] !== "selectors" || keys[1] !== "type") {
    throw correlationRefusal("assurance_scope must contain only type and selectors");
  }
  if (!Array.isArray(scope.selectors) || !scope.selectors.every((selector) => typeof selector === "string" && selector.length > 0)) {
    throw correlationRefusal("assurance_scope selectors must be non-empty strings");
  }
  if (scope.type === "entire-run") {
    if (scope.selectors.length !== 0) throw correlationRefusal("entire-run assurance_scope requires empty selectors");
    return { type: "entire-run", selectors: [] };
  }
  if (scope.type === "selectors") {
    if (scope.selectors.length === 0) throw correlationRefusal("selectors scope requires at least one selector");
    return { type: "selectors", selectors: [...scope.selectors] };
  }
  throw correlationRefusal("assurance_scope type must be entire-run or selectors");
}

/**
 * Snapshot bounded JSON metadata so a caller cannot mutate a record after planning, and so nothing
 * unbounded or undeclared can reach the ledger through it.
 *
 * Refuses with a stable code rather than a bare `Error`: this is reachable from a model-facing tool
 * parameter on all three delegation tools, and it used to throw outside every try, producing a governed
 * refusal with no code and no ledger line at all (R-112).
 */
export function normaliseCorrelation(input: CorrelationMetadata | undefined): CorrelationMetadata | undefined {
  if (input === undefined) return undefined;
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch (error) {
    throw correlationRefusal(`must be JSON serializable (${String(error)})`);
  }
  if (encoded === undefined) throw correlationRefusal("must be a JSON object");
  if (Buffer.byteLength(encoded) > MAX_CORRELATION_BYTES) {
    throw correlationTooLarge(`exceeds ${MAX_CORRELATION_BYTES} bytes`, { limit: MAX_CORRELATION_BYTES });
  }
  const parsed = JSON.parse(encoded) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw correlationRefusal("must be a JSON object");
  }

  const source = parsed as Record<string, unknown>;
  const undeclared = Object.keys(source).filter((key) => !CORRELATION_FIELDS.has(key as keyof CorrelationMetadata));
  if (undeclared.length > 0) {
    throw correlationRefusal(
      `carries fields outside the pinned schema 1.0 contract: ${undeclared.sort().join(", ")}`,
      { undeclared: undeclared.sort().join(",") },
    );
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (key === "assurance_scope") {
      const size = Buffer.byteLength(JSON.stringify(value) ?? "");
      if (size > MAX_CORRELATION_SCOPE_BYTES) {
        throw correlationTooLarge(
          `assurance_scope exceeds ${MAX_CORRELATION_SCOPE_BYTES} bytes`,
          { limit: MAX_CORRELATION_SCOPE_BYTES, actual: size },
        );
      }
      output[key] = normaliseAssuranceScope(value);
      continue;
    }
    if (CORRELATION_NUMERIC.has(key as keyof CorrelationMetadata)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw correlationRefusal(`${key} must be a finite number`, { field: key });
      }
      output[key] = value;
      continue;
    }
    if (typeof value !== "string") throw correlationRefusal(`${key} must be a string`, { field: key });
    if (key === "schema_version" && value !== "1.0") {
      throw correlationRefusal(`unsupported schema_version ${value}; supported version is 1.0`, {
        field: key,
        supported: "1.0",
      });
    }
    if (value.length > MAX_CORRELATION_FIELD_CHARS) {
      throw correlationTooLarge(
        `${key} exceeds ${MAX_CORRELATION_FIELD_CHARS} characters`,
        { field: key, limit: MAX_CORRELATION_FIELD_CHARS, actual: value.length },
      );
    }
    if (CORRELATION_IDENTIFIERS.has(key as keyof CorrelationMetadata) && !isLedgerCorrelationIdentifier(value)) {
      throw correlationRefusal(`${key} must be an ASCII identifier, not free-form text`, { field: key });
    }
    output[key] = value;
  }
  return output as CorrelationMetadata;
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
  tree_sha?: string;
  last_change_seq?: number;
  parent_id: string;
}

/**
 * Builds the binding from TRUSTED values only. It deliberately does not take a `CorrelationMetadata`.
 *
 * It used to read `workspace_id` and `context_id` straight out of caller-supplied correlation into what
 * the comment above calls the trusted scope, and a bound approval could then be spent outside the
 * workspace it named (R-110): approve a delegation carrying a real, registry-validated `workspace` spec,
 * then re-issue the identical task with `correlation.workspace_id` set and NO `workspace` field — no
 * registry lookup, no lease, the parent's own cwd, and every digest still matching. The guard that would
 * have caught it can only fire when there is a spec to disagree with.
 *
 * `workspaceId` must therefore be the id of a workspace that was actually resolved and leased.
 * `contextId` is a caller-declared label that nothing validates; it is included because it can only
 * ever NARROW a binding, and a mismatch fails closed.
 */
export function buildApprovalBinding(input: {
  task: string;
  requested: readonly Capability[];
  effective: readonly Capability[];
  definitionSha256?: DefinitionDigest["sha256"] | string;
  parentId: string;
  /** Id of a workspace this delegation was actually routed to and holds a lease for. */
  workspaceId?: string;
  /** Caller-declared label. Narrows only; never a claim that anything was enforced. */
  contextId?: string;
  /** Optional upstream tree identity. When supplied, later approval use must match it exactly. */
  treeSha?: string;
  /** Optional upstream change floor. When supplied, later approval use must match it exactly. */
  lastChangeSeq?: number;
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
    ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
    ...(input.contextId ? { context_id: input.contextId } : {}),
    ...(input.treeSha !== undefined ? { tree_sha: input.treeSha } : {}),
    ...(input.lastChangeSeq !== undefined ? { last_change_seq: input.lastChangeSeq } : {}),
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
    // Keep the exact pre-ADR-0039 serialization when both additions are absent: persisted approvals store
    // this digest, so unconditional null placeholders would invalidate every existing bound approval.
    ...(binding.tree_sha !== undefined ? { tree_sha: binding.tree_sha } : {}),
    ...(binding.last_change_seq !== undefined ? { last_change_seq: binding.last_change_seq } : {}),
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
    typeof binding.parent_id === "string" &&
    ["definition_sha256", "workspace_id", "context_id", "tree_sha"].every((key) => {
      const value = (binding as Record<string, unknown>)[key];
      return value === undefined || typeof value === "string";
    }) &&
    (binding.last_change_seq === undefined ||
      (typeof binding.last_change_seq === "number" && Number.isFinite(binding.last_change_seq))) &&
    // Self-consistency. This guard's only trust boundary is a binding parsed off DISK
    // (`approval-store.ts`), so an internally contradictory record — digests that do not match the
    // capability arrays sitting beside them — must be unrepresentable rather than merely unlikely.
    binding.requested_sha256 === digestCapabilities(binding.requested as Capability[]) &&
    binding.effective_sha256 === digestCapabilities(binding.effective as Capability[]);
}

export function approvalBindingsEqual(a: ApprovalBinding | undefined, b: ApprovalBinding | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (!isApprovalBinding(a) || !isApprovalBinding(b)) return false;
  return approvalBindingDigest(a) === approvalBindingDigest(b);
}
