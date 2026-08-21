import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Compile } from "typebox/compile";
import {
  buildLedgerV2ContractFixtures,
  syncLedgerV2RefusalEnum,
} from "../scripts/generate-ledger-v2-contract.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
import { APPROVAL_SCOPES, APPROVAL_SOURCES } from "../src/approval.ts";
import { PROMPT_OUTCOME_KINDS } from "../src/approval-prompt.ts";
import { EXECUTOR_KINDS } from "../src/executor.ts";
import { REFUSAL_CODES } from "../src/refusals.ts";
import {
  CHILD_LIFECYCLE_STATES,
  CHILD_PROCESS_SIGNALS,
  LEDGER_EVENT_KINDS,
  LEDGER_GATE_OUTCOMES,
  WORKSPACE_ACCESSES,
  WORKSPACE_LEASE_OUTCOMES,
  WORKSPACE_RECOVERY_VALUES,
  buildCheckReceiptLedgerEvent,
  buildChildLifecycleEvent,
  buildRecord,
  buildWorkspaceLeaseEvent,
  type CapabilityDecisionEvent,
  type CheckReceiptLedgerEvent,
  type ChildLifecycleEvent,
  type GrantRecord,
  type WorkspaceLeaseEvent,
} from "../src/ledger.ts";
import type { CorrelationMetadata } from "../src/correlation.ts";
import type { DefinitionDigest } from "../src/definitions.ts";
import type { StructuredRefusal } from "../src/refusals.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contractRoot = join(packageRoot, "contracts", "ledger", "v2");
const schemaPath = join(contractRoot, "ledger-event.schema.json");

type SchemaNode = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  oneOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  required?: string[];
  $ref?: string;
};
type ContractSchema = SchemaNode & { $defs: Record<string, SchemaNode> };
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type ApprovalUse = NonNullable<GrantRecord["approvalUses"]>[string];

const CAPABILITY_DECISION_FIELDS = [
  "ledgerVersion", "event", "ts", "parentId", "childId", "depth", "agentType", "requested", "parentGrant",
  "effective", "denied", "clipped", "gatedBlocked", "blocked", "reason", "approved", "approvalSource",
  "approvalSources", "approvalScopes", "approvalExpiresAt", "approvalUses", "approvalScope", "humanDenied",
  "gateOutcome", "definitionDigest", "executor", "taskFrom", "taskDigest", "correlation", "refusal",
] as const;
const WORKSPACE_LEASE_FIELDS = [
  "ledgerVersion", "event", "ts", "childId", "workspaceId", "root", "access", "outcome", "recovered",
  "releaseReason", "refusal", "correlation",
] as const;
const CHILD_LIFECYCLE_FIELDS = [
  "ledgerVersion", "event", "ts", "childId", "state", "executor", "exitCode", "signal", "timedOut", "aborted",
  "truncated", "reason", "correlation",
] as const;
const CHECK_RECEIPT_FIELDS = [
  "ledgerVersion", "event", "ts", "childId", "receiptId", "workspaceId", "checkId", "treeSha", "correlation",
] as const;
const CAPABILITY_DECISION_REQUIRED = [
  "ledgerVersion", "event", "ts", "parentId", "childId", "depth", "requested", "parentGrant", "effective",
  "denied", "clipped", "gatedBlocked", "blocked", "executor", "taskDigest",
] as const;
const WORKSPACE_LEASE_REQUIRED = [
  "ledgerVersion", "event", "ts", "childId", "workspaceId", "root", "access", "outcome",
] as const;
const CHILD_LIFECYCLE_REQUIRED = ["ledgerVersion", "event", "ts", "childId", "state", "executor"] as const;
const CHECK_RECEIPT_REQUIRED = [
  "ledgerVersion", "event", "ts", "childId", "receiptId", "workspaceId", "checkId", "treeSha",
] as const;
const CORRELATION_FIELDS = [
  "schema_version", "run_id", "task_id", "workspace_id", "context_id", "phase", "assurance",
  "assurance_effective", "policy_label", "assurance_source", "assurance_scope", "activated_at", "plan_digest",
  "definition_digest", "task_digest", "base_sha", "head_sha", "tree_sha", "event_seq", "last_change_seq",
  "last_authority_seq", "check_receipt_id",
] as const;
const REFUSAL_FIELDS = ["code", "message", "details"] as const;
const DEFINITION_DIGEST_FIELDS = ["name", "source", "sha256"] as const;
const APPROVAL_USE_FIELDS = ["max", "remaining"] as const;
const CORRELATION_REQUIRED = [] as const;
const REFUSAL_REQUIRED = ["code", "message"] as const;
const DEFINITION_DIGEST_REQUIRED = ["name", "source", "sha256"] as const;
const APPROVAL_USE_REQUIRED = ["max", "remaining"] as const;

type _CapabilityDecisionFieldsAreExhaustive = Assert<Equal<keyof GrantRecord, typeof CAPABILITY_DECISION_FIELDS[number]>>;
type _WorkspaceLeaseFieldsAreExhaustive = Assert<Equal<keyof WorkspaceLeaseEvent, typeof WORKSPACE_LEASE_FIELDS[number]>>;
type _ChildLifecycleFieldsAreExhaustive = Assert<Equal<keyof ChildLifecycleEvent, typeof CHILD_LIFECYCLE_FIELDS[number]>>;
type _CheckReceiptFieldsAreExhaustive = Assert<Equal<keyof CheckReceiptLedgerEvent, typeof CHECK_RECEIPT_FIELDS[number]>>;
type _CapabilityDecisionRequiredIsExhaustive = Assert<Equal<RequiredKeys<CapabilityDecisionEvent>, typeof CAPABILITY_DECISION_REQUIRED[number]>>;
type _WorkspaceLeaseRequiredIsExhaustive = Assert<Equal<RequiredKeys<WorkspaceLeaseEvent>, typeof WORKSPACE_LEASE_REQUIRED[number]>>;
type _ChildLifecycleRequiredIsExhaustive = Assert<Equal<RequiredKeys<ChildLifecycleEvent>, typeof CHILD_LIFECYCLE_REQUIRED[number]>>;
type _CheckReceiptRequiredIsExhaustive = Assert<Equal<RequiredKeys<CheckReceiptLedgerEvent>, typeof CHECK_RECEIPT_REQUIRED[number]>>;
type _CorrelationFieldsAreExhaustive = Assert<Equal<keyof CorrelationMetadata, typeof CORRELATION_FIELDS[number]>>;
type _RefusalFieldsAreExhaustive = Assert<Equal<keyof StructuredRefusal, typeof REFUSAL_FIELDS[number]>>;
type _DefinitionDigestFieldsAreExhaustive = Assert<Equal<keyof DefinitionDigest, typeof DEFINITION_DIGEST_FIELDS[number]>>;
type _ApprovalUseFieldsAreExhaustive = Assert<Equal<keyof ApprovalUse, typeof APPROVAL_USE_FIELDS[number]>>;
type _CorrelationRequiredIsExhaustive = Assert<Equal<RequiredKeys<CorrelationMetadata>, typeof CORRELATION_REQUIRED[number]>>;
type _RefusalRequiredIsExhaustive = Assert<Equal<RequiredKeys<StructuredRefusal>, typeof REFUSAL_REQUIRED[number]>>;
type _DefinitionDigestRequiredIsExhaustive = Assert<Equal<RequiredKeys<DefinitionDigest>, typeof DEFINITION_DIGEST_REQUIRED[number]>>;
type _ApprovalUseRequiredIsExhaustive = Assert<Equal<RequiredKeys<ApprovalUse>, typeof APPROVAL_USE_REQUIRED[number]>>;
type _HumanDeniedDomainMatchesSchema = Assert<Equal<NonNullable<CapabilityDecisionEvent["humanDenied"]>, true>>;
type _TimedOutDomainMatchesSchema = Assert<Equal<NonNullable<ChildLifecycleEvent["timedOut"]>, true>>;
type _AbortedDomainMatchesSchema = Assert<Equal<NonNullable<ChildLifecycleEvent["aborted"]>, true>>;
type _TruncatedDomainMatchesSchema = Assert<Equal<NonNullable<ChildLifecycleEvent["truncated"]>, true>>;

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function finiteValues(node: SchemaNode | undefined): unknown[] {
  if (!node) return [];
  if (node.enum) return [...node.enum];
  if (Object.hasOwn(node, "const")) return [node.const];
  if (node.type === "boolean") return [false, true];
  if (node.type === "null") return [null];
  return node.oneOf?.flatMap(finiteValues) ?? [];
}

const sortedValues = (values: readonly unknown[]): unknown[] =>
  [...values].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

test("the published ledger v2 fixtures are generated by the real event builders", async () => {
  const generated = buildLedgerV2ContractFixtures();
  assert.deepEqual(
    Object.keys(generated).sort(),
    ["capability-decision.json", "check-receipt.json", "child-lifecycle.json", "workspace-lease.json"],
  );
  for (const [name, event] of Object.entries(generated)) {
    assert.deepEqual(await json(join(contractRoot, "fixtures", name)), event, `${name} drifted from its builder`);
  }
});

test("v2 builders refuse digest values that their canonical schema would reject", () => {
  assert.throws(() => buildRecord({
    parentId: "d0", childId: "d0.1", depth: 1, requested: [], parentGrant: [],
    result: { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    blocked: false, executor: "process", taskDigest: "", now: new Date(),
  }), /taskDigest must be a SHA-256/);
  assert.throws(() => buildRecord({
    parentId: "d0", childId: "d0.1", depth: 1, requested: [], parentGrant: [],
    result: { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    blocked: false, executor: "process", taskDigest: "not-a-sha256", now: new Date(),
  }), /taskDigest must be a SHA-256/);
  assert.throws(() => buildRecord({
    parentId: "d0", childId: "d0.1", depth: 1, requested: [], parentGrant: [],
    result: { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    blocked: false, executor: "process", taskDigest: "a".repeat(64),
    definitionDigest: { name: "x", source: "/x", sha256: "not-a-sha256" }, now: new Date(),
  }), /definitionDigest.sha256 must be a SHA-256/);
  assert.throws(() => buildCheckReceiptLedgerEvent({
    childId: "check:x", receiptId: "not-a-sha256", workspaceId: "w", checkId: "x",
    treeSha: "tree", now: new Date(),
  }), /receiptId must be a SHA-256/);
});

test("the canonical schema accepts every generated fixture and rejects unsupported explicit versions", async () => {
  const schema = await json(schemaPath) as Parameters<typeof Compile>[0];
  const validator = Compile(schema);
  for (const [name, event] of Object.entries(buildLedgerV2ContractFixtures())) {
    assert.equal(validator.Check(event), true, `${name}: ${[...validator.Errors(event)].map((error) => error.message).join(", ")}`);
  }
  const fixture = buildLedgerV2ContractFixtures()["capability-decision.json"];
  assert.equal(validator.Check({ ...fixture, ledgerVersion: 3 }), false);
  assert.equal(validator.Check({ ...fixture, extraAuthority: true }), false);
});

test("the closed schema exhaustively matches production event vocabularies and fields", async () => {
  const schema = await json(schemaPath) as ContractSchema;
  const defs = schema.$defs;
  const resolve = (node: SchemaNode | undefined): SchemaNode | undefined => {
    const prefix = "#/$defs/";
    return node?.$ref?.startsWith(prefix) ? defs[node.$ref.slice(prefix.length)] : node;
  };
  const contractValues = (node: SchemaNode | undefined): unknown[] => finiteValues(resolve(node));
  const values = (definition: string, property: string): unknown[] =>
    contractValues(defs[definition]?.properties?.[property]);
  const mapValues = (definition: string, property: string): unknown[] => {
    const additional = defs[definition]?.properties?.[property]?.additionalProperties;
    return typeof additional === "object" ? contractValues(additional) : [];
  };
  const fields = (definition: string): string[] => Object.keys(defs[definition]?.properties ?? {}).sort();
  const required = (definition: string): string[] => [...(defs[definition]?.required ?? [])].sort();

  const definitionForEvent = {
    capability_decision: "capabilityDecision",
    workspace_lease: "workspaceLease",
    child_lifecycle: "childLifecycle",
    check_receipt: "checkReceipt",
  } as const satisfies Record<typeof LEDGER_EVENT_KINDS[number], string>;
  assert.deepEqual(
    schema.oneOf?.map((entry) => entry.$ref).sort(),
    LEDGER_EVENT_KINDS.map((event) => `#/$defs/${definitionForEvent[event]}`).sort(),
  );
  assert.deepEqual(
    LEDGER_EVENT_KINDS.map((event) => defs[definitionForEvent[event]]?.properties?.event?.const),
    [...LEDGER_EVENT_KINDS],
  );
  assert.deepEqual(sortedValues(finiteValues(defs.approvalSource)), sortedValues(APPROVAL_SOURCES));
  assert.deepEqual(sortedValues(finiteValues(defs.approvalScope)), sortedValues(APPROVAL_SCOPES));
  assert.deepEqual(sortedValues(values("capabilityDecision", "approvalSource")), sortedValues(APPROVAL_SOURCES));
  assert.deepEqual(sortedValues(mapValues("capabilityDecision", "approvalSources")), sortedValues(APPROVAL_SOURCES));
  assert.deepEqual(sortedValues(values("capabilityDecision", "approvalScope")), sortedValues(APPROVAL_SCOPES));
  assert.deepEqual(sortedValues(mapValues("capabilityDecision", "approvalScopes")), sortedValues(APPROVAL_SCOPES));
  assert.deepEqual(
    sortedValues(PROMPT_OUTCOME_KINDS.filter((kind) => kind !== "granted")),
    sortedValues(LEDGER_GATE_OUTCOMES),
  );
  assert.deepEqual(sortedValues(values("capabilityDecision", "gateOutcome")), sortedValues(LEDGER_GATE_OUTCOMES));
  assert.deepEqual(sortedValues(values("capabilityDecision", "executor")), sortedValues(EXECUTOR_KINDS));
  assert.deepEqual(sortedValues(values("workspaceLease", "access")), sortedValues(WORKSPACE_ACCESSES));
  assert.deepEqual(sortedValues(values("workspaceLease", "outcome")), sortedValues(WORKSPACE_LEASE_OUTCOMES));
  assert.deepEqual(
    sortedValues(finiteValues(defs.workspaceLease?.properties?.recovered)),
    sortedValues(WORKSPACE_RECOVERY_VALUES),
  );
  assert.deepEqual(sortedValues(values("childLifecycle", "state")), sortedValues(CHILD_LIFECYCLE_STATES));
  assert.deepEqual(sortedValues(values("childLifecycle", "executor")), sortedValues(EXECUTOR_KINDS));
  assert.deepEqual(
    sortedValues(finiteValues(defs.childLifecycle?.properties?.signal)),
    sortedValues([...CHILD_PROCESS_SIGNALS, null]),
  );

  assert.deepEqual(fields("capabilityDecision"), [...CAPABILITY_DECISION_FIELDS].sort());
  assert.deepEqual(fields("workspaceLease"), [...WORKSPACE_LEASE_FIELDS].sort());
  assert.deepEqual(fields("childLifecycle"), [...CHILD_LIFECYCLE_FIELDS].sort());
  assert.deepEqual(fields("checkReceipt"), [...CHECK_RECEIPT_FIELDS].sort());
  assert.deepEqual(required("capabilityDecision"), [...CAPABILITY_DECISION_REQUIRED].sort());
  assert.deepEqual(required("workspaceLease"), [...WORKSPACE_LEASE_REQUIRED].sort());
  assert.deepEqual(required("childLifecycle"), [...CHILD_LIFECYCLE_REQUIRED].sort());
  assert.deepEqual(required("checkReceipt"), [...CHECK_RECEIPT_REQUIRED].sort());

  assert.deepEqual(fields("correlation"), [...CORRELATION_FIELDS].sort());
  assert.deepEqual(required("correlation"), [...CORRELATION_REQUIRED].sort());
  assert.deepEqual(fields("refusal"), [...REFUSAL_FIELDS].sort());
  assert.deepEqual(required("refusal"), [...REFUSAL_REQUIRED].sort());
  assert.deepEqual(fields("definitionDigest"), [...DEFINITION_DIGEST_FIELDS].sort());
  assert.deepEqual(required("definitionDigest"), [...DEFINITION_DIGEST_REQUIRED].sort());
  assert.deepEqual(fields("approvalUse"), [...APPROVAL_USE_FIELDS].sort());
  assert.deepEqual(required("approvalUse"), [...APPROVAL_USE_REQUIRED].sort());
});

test("the schema accepts every minimal, maximal, and enumerated builder shape", async () => {
  const schema = await json(schemaPath) as Parameters<typeof Compile>[0];
  const validator = Compile(schema);
  const check = (label: string, event: unknown) =>
    assert.equal(validator.Check(event), true, `${label}: ${[...validator.Errors(event)].map((error) => error.message).join(", ")}`);
  const now = new Date("2026-08-20T12:30:00.000Z");
  const result = { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] };

  check("minimal capability decision", buildRecord({
    parentId: "d0", childId: "d0.1", depth: 1, requested: [], parentGrant: [], result,
    blocked: false, executor: "process", taskDigest: "1".repeat(64), now,
  }));
  check("granted gate outcome is deliberately omitted", buildRecord({
    parentId: "d0", childId: "d0.1", depth: 1, requested: [], parentGrant: [], result,
    blocked: false, gateOutcome: "granted", executor: "process", taskDigest: "2".repeat(64), now,
  }));
  for (const gateOutcome of PROMPT_OUTCOME_KINDS.filter((kind) => kind !== "granted")) {
    check(`maximal capability decision (${gateOutcome})`, buildRecord({
      parentId: "d0", childId: "d0.1", depth: 1, agentType: "review", requested: ["tool:read"],
      parentGrant: ["tool:read"], result, blocked: true, reason: "blocked", approved: ["tool:read"],
      approvalSources: { "tool:read": "prompt" }, approvalScopes: { "tool:read": "once" },
      approvalExpiresAt: { "tool:read": now.toISOString() }, approvalUses: { "tool:read": { max: 1, remaining: 0 } },
      humanDenied: true, gateOutcome, definitionDigest: { name: "review", source: "/review", sha256: "2".repeat(64) },
      executor: "herdr", taskFrom: "d0.0", taskDigest: "3".repeat(64),
      correlation: { run_id: "run-contract" },
      refusal: { code: "GATED_UNAPPROVED", message: "blocked", details: { retryable: false } }, now,
    }));
  }

  for (const access of WORKSPACE_ACCESSES) {
    for (const outcome of WORKSPACE_LEASE_OUTCOMES) {
      for (const recovered of WORKSPACE_RECOVERY_VALUES) {
        check(`workspace lease (${access}, ${outcome}, ${String(recovered)})`, buildWorkspaceLeaseEvent({
          childId: "d0.1", workspaceId: "w", root: "/w", access, outcome, recovered,
          releaseReason: "complete", refusal: { code: "WORKSPACE_LEASE_STALE", message: "stale" },
          correlation: { workspace_id: "w" }, now,
        }));
      }
    }
  }
  check("minimal workspace lease", buildWorkspaceLeaseEvent({
    childId: "d0.1", workspaceId: "w", root: "/w", access: "read", outcome: "uncontended", now,
  }));

  for (const state of CHILD_LIFECYCLE_STATES) {
    for (const executor of EXECUTOR_KINDS) {
      for (const signal of CHILD_PROCESS_SIGNALS) {
        check(`child lifecycle (${state}, ${executor}, ${signal})`, buildChildLifecycleEvent({
          childId: "d0.1", state, executor, exitCode: null, signal, timedOut: true, aborted: true,
          truncated: true, reason: "complete", correlation: { run_id: "run-contract" }, now,
        }));
      }
    }
  }
  check("minimal child lifecycle", buildChildLifecycleEvent({ childId: "d0.1", state: "starting", executor: "process", now }));
  check("numeric child exit and null signal", buildChildLifecycleEvent({
    childId: "d0.1", state: "completed", executor: "process", exitCode: 0, signal: null, now,
  }));

  check("minimal check receipt", buildCheckReceiptLedgerEvent({
    childId: "check:x", receiptId: "4".repeat(64), workspaceId: "w", checkId: "x", treeSha: "tree", now,
  }));
  check("maximal check receipt", buildCheckReceiptLedgerEvent({
    childId: "check:x", receiptId: "5".repeat(64), workspaceId: "w", checkId: "x", treeSha: "tree",
    correlation: { check_receipt_id: "5".repeat(64) }, now,
  }));
});

/**
 * The `refusalCode` enum is GENERATED, not remembered.
 *
 * The test below asserts `schema.$defs.refusalCode.enum === REFUSAL_CODES`, which is the right assertion —
 * and for one release it was the only thing holding the two together, because `contracts:generate` wrote
 * fixtures and never touched the schema. So adding `WORKSPACE_NOT_AUTHORIZED` in `src/refusals.ts` turned
 * the suite red, running the generator produced no diff, and getting back to green required knowing which
 * hand-written JSON file to edit. Every future refusal code had the same ambush waiting.
 *
 * This pins the mechanism rather than the state: the sync function is what makes the assertion below
 * satisfiable by running a command. **Breaks by:** deleting the `syncLedgerV2RefusalEnum` call from the
 * script's entry point, or reverting it to leave the enum alone.
 */
test("regenerating the contract restores the refusal enum from REFUSAL_CODES", async () => {
  const dir = await tempDir("pi-daddy-contract-");
  const copy = join(dir, "ledger-event.schema.json");
  const original = await json(schemaPath) as { $defs: { refusalCode: { enum: string[] } } };

  // Drift it exactly the way a new refusal code drifts it: one member short.
  const drifted = structuredClone(original);
  drifted.$defs.refusalCode.enum = drifted.$defs.refusalCode.enum.filter((c) => c !== "WORKSPACE_NOT_AUTHORIZED");
  await writeFile(copy, JSON.stringify(drifted, null, 2), "utf8");
  assert.notDeepEqual(drifted.$defs.refusalCode.enum, [...REFUSAL_CODES], "precondition: the copy is stale");

  await syncLedgerV2RefusalEnum(copy);

  const synced = await json(copy) as { $defs: { refusalCode: { enum: string[] } } };
  assert.deepEqual(synced.$defs.refusalCode.enum, [...REFUSAL_CODES]);
  // Only the enum is generated: everything else in the hand-authored schema is left exactly as it was.
  assert.deepEqual({ ...synced, $defs: { ...synced.$defs, refusalCode: null } },
    { ...original, $defs: { ...original.$defs, refusalCode: null } });
});

test("the schema pins nested correlation, approval, refusal, digest, and null contracts", async () => {
  const schema = await json(schemaPath) as Parameters<typeof Compile>[0] & {
    $defs: { refusalCode: { enum: string[] } };
  };
  assert.deepEqual(sortedValues(finiteValues(schema.$defs.refusalCode)), sortedValues(REFUSAL_CODES));
  const validator = Compile(schema);
  const fixtures = buildLedgerV2ContractFixtures();
  const capability = fixtures["capability-decision.json"];
  assert.equal(validator.Check({ ...capability, taskDigest: null }), false);
  assert.equal(validator.Check({ ...capability, correlation: { ...capability.correlation, unknown: "x" } }), false);
  assert.equal(validator.Check({ ...capability, refusal: { code: "NOT_A_REFUSAL", message: "x" } }), false);
  assert.equal(validator.Check({ ...capability, approvalUses: { "tool:bash": { max: 1, remaining: null } } }), false);

  assert.equal((schema as ContractSchema).$defs.capabilityDecision?.properties?.humanDenied?.const, true);
  assert.equal((schema as ContractSchema).$defs.childLifecycle?.properties?.timedOut?.const, true);
  assert.equal((schema as ContractSchema).$defs.childLifecycle?.properties?.aborted?.const, true);
  assert.equal((schema as ContractSchema).$defs.childLifecycle?.properties?.truncated?.const, true);

  const lifecycle = fixtures["child-lifecycle.json"];
  assert.equal(lifecycle.exitCode, null);
  assert.equal(lifecycle.signal, null);
  assert.equal(validator.Check(lifecycle), true);
  assert.equal(validator.Check({ ...lifecycle, exitCode: "0" }), false);
});
