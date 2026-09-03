import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Compile } from "typebox/compile";
import { APPROVAL_SCOPES, APPROVAL_SOURCES } from "../src/approval.ts";
import { EXECUTOR_KINDS } from "../src/executor.ts";
import { validateLedgerV3Event } from "../src/ledger-v3-validation.ts";
import { REFUSAL_CODES } from "../src/refusals.ts";
import {
  CHILD_LIFECYCLE_STATES,
  CHILD_PROCESS_SIGNALS,
  LEDGER_EVENT_KINDS,
  LEDGER_GATE_OUTCOMES,
  WORKSPACE_ACCESSES,
  WORKSPACE_LEASE_OUTCOMES,
  WORKSPACE_RECOVERY_VALUES,
  WORKFLOW_FACT_KINDS,
  WORKFLOW_FACT_PROVENANCE,
  WORKFLOW_FACT_STATES,
  buildCheckReceiptLedgerEvent,
  buildChildLifecycleEvent,
  buildRecord,
  buildWorkspaceLeaseEvent,
  buildWorkflowFactEvent,
  type CapabilityDecisionEvent,
  type CheckReceiptLedgerEvent,
  type ChildLifecycleEvent,
  type GrantRecord,
  type WorkspaceLeaseEvent,
  type WorkflowFactEvent,
} from "../src/ledger.ts";
import type { CorrelationMetadata } from "../src/correlation.ts";
import type { DefinitionDigest } from "../src/definitions.ts";
import type { StructuredRefusal } from "../src/refusals.ts";
import {
  buildLedgerV3ContractFixtures,
  generateLedgerV3Contract,
} from "../scripts/generate-ledger-v3-contract.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contractRoot = join(packageRoot, "contracts", "ledger", "v3");
const schemaPath = join(contractRoot, "ledger-event.schema.json");
const v2Root = join(packageRoot, "contracts", "ledger", "v2");
const executionId = "exec:00000000-0000-4000-8000-000000000001";

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

const CAPABILITY_FIELDS = [
  "ledgerVersion", "event", "ts", "executionId", "parentExecutionId", "parentId", "childId", "depth",
  "agentType", "requested", "parentGrant", "effective", "denied", "clipped", "gatedBlocked", "blocked",
  "reason", "approved", "approvalSource", "approvalSources", "approvalScopes", "approvalExpiresAt",
  "approvalUses", "approvalScope", "humanDenied", "gateOutcome", "definitionDigest", "executor", "taskFrom",
  "taskFromExecutionId", "taskDigest", "correlation", "refusal",
] as const;
const LEASE_FIELDS = [
  "ledgerVersion", "event", "ts", "executionId", "parentExecutionId", "childId", "workspaceId", "root",
  "access", "outcome", "recovered", "releaseReason", "refusal", "correlation",
] as const;
const LIFECYCLE_FIELDS = [
  "ledgerVersion", "event", "ts", "executionId", "parentExecutionId", "childId", "state", "executor",
  "deadlineAt", "herdrPaneId", "herdrAgentName", "exitCode", "signal", "timedOut", "aborted", "truncated",
  "reason", "correlation",
] as const;
const RECEIPT_FIELDS = [
  "ledgerVersion", "event", "ts", "executionId", "parentExecutionId", "childId", "receiptId", "workspaceId",
  "checkId", "treeSha", "correlation",
] as const;
const WORKFLOW_FACT_FIELDS = [
  "ledgerVersion", "event", "ts", "factId", "source", "provenance", "kind", "subject", "state", "correlation",
] as const;
const CAPABILITY_REQUIRED = [
  "ledgerVersion", "event", "ts", "executionId", "parentExecutionId", "parentId", "childId", "depth",
  "requested", "parentGrant", "effective", "denied", "clipped", "gatedBlocked", "blocked", "executor", "taskDigest",
] as const;
const LEASE_REQUIRED = [
  "ledgerVersion", "event", "ts", "executionId", "parentExecutionId", "childId", "workspaceId", "root", "access", "outcome",
] as const;
const LIFECYCLE_REQUIRED = [
  "ledgerVersion", "event", "ts", "executionId", "parentExecutionId", "childId", "state", "executor",
] as const;
const RECEIPT_REQUIRED = [
  "ledgerVersion", "event", "ts", "executionId", "parentExecutionId", "childId", "receiptId", "workspaceId", "checkId", "treeSha",
] as const;
const WORKFLOW_FACT_REQUIRED = [...WORKFLOW_FACT_FIELDS] as const;
const CORRELATION_FIELDS = [
  "schema_version", "run_id", "task_id", "workspace_id", "context_id", "phase", "assurance",
  "assurance_effective", "policy_label", "assurance_source", "assurance_scope", "activated_at", "plan_digest",
  "definition_digest", "task_digest", "base_sha", "head_sha", "tree_sha", "event_seq", "last_change_seq",
  "last_authority_seq", "check_receipt_id",
] as const;
const REFUSAL_FIELDS = ["code", "message", "details"] as const;
const DEFINITION_FIELDS = ["name", "source", "sha256"] as const;
const APPROVAL_USE_FIELDS = ["max", "remaining"] as const;

type _CapabilityFields = Assert<Equal<keyof GrantRecord, typeof CAPABILITY_FIELDS[number]>>;
type _LeaseFields = Assert<Equal<keyof WorkspaceLeaseEvent, typeof LEASE_FIELDS[number]>>;
type _LifecycleFields = Assert<Equal<keyof ChildLifecycleEvent, typeof LIFECYCLE_FIELDS[number]>>;
type _ReceiptFields = Assert<Equal<keyof CheckReceiptLedgerEvent, typeof RECEIPT_FIELDS[number]>>;
type _CapabilityRequired = Assert<Equal<RequiredKeys<CapabilityDecisionEvent>, typeof CAPABILITY_REQUIRED[number]>>;
type _LeaseRequired = Assert<Equal<RequiredKeys<WorkspaceLeaseEvent>, typeof LEASE_REQUIRED[number]>>;
type _LifecycleRequired = Assert<Equal<RequiredKeys<ChildLifecycleEvent>, typeof LIFECYCLE_REQUIRED[number]>>;
type _ReceiptRequired = Assert<Equal<RequiredKeys<CheckReceiptLedgerEvent>, typeof RECEIPT_REQUIRED[number]>>;
type _WorkflowFactFields = Assert<Equal<keyof WorkflowFactEvent, typeof WORKFLOW_FACT_FIELDS[number]>>;
type _WorkflowFactRequired = Assert<Equal<RequiredKeys<WorkflowFactEvent>, typeof WORKFLOW_FACT_REQUIRED[number]>>;
type _CorrelationFields = Assert<Equal<keyof CorrelationMetadata, typeof CORRELATION_FIELDS[number]>>;
type _RefusalFields = Assert<Equal<keyof StructuredRefusal, typeof REFUSAL_FIELDS[number]>>;
type _DefinitionFields = Assert<Equal<keyof DefinitionDigest, typeof DEFINITION_FIELDS[number]>>;
type _ApprovalUseFields = Assert<Equal<keyof ApprovalUse, typeof APPROVAL_USE_FIELDS[number]>>;

async function json(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

function finite(node: SchemaNode | undefined): unknown[] {
  if (!node) return [];
  if (node.enum) return [...node.enum];
  if (Object.hasOwn(node, "const")) return [node.const];
  if (node.type === "boolean") return [false, true];
  if (node.type === "null") return [null];
  return node.oneOf?.flatMap(finite) ?? [];
}

const sorted = (values: readonly unknown[]): unknown[] =>
  [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test("the published ledger v3 fixtures come from the production builders", async () => {
  const generated = buildLedgerV3ContractFixtures();
  assert.deepEqual(Object.keys(generated).sort(), [
    "capability-decision.json", "check-receipt.json", "child-lifecycle.json", "workflow-fact.json", "workspace-lease.json",
  ]);
  for (const [name, event] of Object.entries(generated)) {
    assert.deepEqual(await json(join(contractRoot, "fixtures", name)), event, `${name} drifted`);
  }
});

test("the closed v3 schema accepts fixtures and rejects v2, extra fields and missing identity", async () => {
  const validator = Compile(await json(schemaPath));
  for (const [name, event] of Object.entries(buildLedgerV3ContractFixtures())) {
    assert.equal(validator.Check(event), true, `${name}: ${[...validator.Errors(event)].map((e) => e.message).join(", ")}`);
  }
  const fixture = buildLedgerV3ContractFixtures()["capability-decision.json"];
  assert.equal(validator.Check({ ...fixture, ledgerVersion: 2 }), false);
  assert.equal(validator.Check({ ...fixture, executionId: undefined }), false);
  assert.equal(validator.Check({ ...fixture, task: "forbidden ledger text" }), false);
  assert.equal(validator.Check({ ...fixture, agentType: "SECRET TASK TEXT" }), false);
  assert.equal(validator.Check({ ...fixture, effective: ["SECRET OUTPUT TEXT"] }), false);
  assert.equal(validator.Check({
    ...fixture, correlation: { ...fixture.correlation, policy_label: "SECRET TASK TEXT" },
  }), false);
  assert.equal(validator.Check({
    ...fixture, correlation: { ...fixture.correlation, assurance_scope: null },
  }), false, "the schema must agree with runtime normalization, which never emits a null scope");
  assert.equal(validator.Check({
    ...fixture, correlation: { ...fixture.correlation, schema_version: "1.1" },
  }), false, "unknown upstream schema versions fail at the version field");
  assert.equal(validator.Check({
    ...fixture, correlation: { ...fixture.correlation, assurance_scope: { type: "selectors", selectors: [] } },
  }), false, "selector scope is non-empty");
  assert.equal(validator.Check({
    ...fixture, correlation: { ...fixture.correlation, assurance_scope: { type: "entire-run", selectors: ["src/**"] } },
  }), false, "entire-run carries no selectors");
  const workflow = buildLedgerV3ContractFixtures()["workflow-fact.json"];
  assert.equal(validator.Check({ ...workflow, provenance: "planned", state: "completed" }), false);
  assert.equal(validator.Check({ ...workflow, correlation: { ...workflow.correlation, run_id: "" } }), false);
  const lifecycle = buildLedgerV3ContractFixtures()["child-lifecycle.json"];
  const { deadlineAt: _deadline, ...startingWithoutDeadline } = { ...lifecycle, state: "starting" };
  assert.equal(validator.Check(startingWithoutDeadline), false);
  assert.equal(validator.Check({
    ...lifecycle, state: "running", executor: "process", herdrPaneId: "w1:p2", herdrAgentName: "review-d0-1",
  }), false);
});

test("the v3 schema and runtime share one timestamp profile", async () => {
  const validator = Compile(await json(schemaPath));
  const fixtures = buildLedgerV3ContractFixtures();
  const leapSecond = "1990-12-31T23:59:60Z";
  const cases = [
    { ...fixtures["capability-decision.json"], ts: leapSecond },
    {
      ...fixtures["capability-decision.json"],
      approvalExpiresAt: { "tool:bash": leapSecond },
    },
    { ...fixtures["workspace-lease.json"], ts: leapSecond },
    { ...fixtures["child-lifecycle.json"], ts: leapSecond },
    { ...fixtures["child-lifecycle.json"], deadlineAt: leapSecond },
    { ...fixtures["check-receipt.json"], ts: leapSecond },
    { ...fixtures["workflow-fact.json"], ts: leapSecond },
  ];
  for (const event of cases) {
    assert.equal(validator.Check(event), false, `${event.event} schema accepted the unsupported leap second`);
    assert.notEqual(validateLedgerV3Event(event), null, `${event.event} runtime accepted the unsupported leap second`);
  }
});

test("the v3 schema exhaustively matches production fields and finite vocabularies", async () => {
  const schema = await json(schemaPath) as ContractSchema;
  const defs = schema.$defs;
  const resolve = (node?: SchemaNode) => node?.$ref?.startsWith("#/$defs/") ? defs[node.$ref.slice(8)] : node;
  const values = (definition: string, property: string) => finite(resolve(defs[definition]?.properties?.[property]));
  const mapValues = (definition: string, property: string) => {
    const additional = defs[definition]?.properties?.[property]?.additionalProperties;
    return typeof additional === "object" ? finite(resolve(additional)) : [];
  };
  const fields = (name: string) => Object.keys(defs[name]?.properties ?? {}).sort();
  const required = (name: string) => [...(defs[name]?.required ?? [])].sort();

  const definitionForEvent = {
    capability_decision: "capabilityDecision",
    workspace_lease: "workspaceLease",
    child_lifecycle: "childLifecycle",
    check_receipt: "checkReceipt",
    workflow_fact: "workflowFact",
  } as const satisfies Record<typeof LEDGER_EVENT_KINDS[number], string>;
  assert.deepEqual(schema.oneOf?.map((entry) => entry.$ref).sort(), LEDGER_EVENT_KINDS.map((event) => `#/$defs/${definitionForEvent[event]}`).sort());
  assert.deepEqual(sorted(finite(defs.approvalSource)), sorted(APPROVAL_SOURCES));
  assert.deepEqual(sorted(finite(defs.approvalScope)), sorted(APPROVAL_SCOPES));
  assert.deepEqual(sorted(values("capabilityDecision", "executor")), sorted(EXECUTOR_KINDS));
  assert.deepEqual(sorted(values("capabilityDecision", "gateOutcome")), sorted(LEDGER_GATE_OUTCOMES));
  assert.deepEqual(sorted(mapValues("capabilityDecision", "approvalSources")), sorted(APPROVAL_SOURCES));
  assert.deepEqual(sorted(values("workspaceLease", "access")), sorted(WORKSPACE_ACCESSES));
  assert.deepEqual(sorted(values("workspaceLease", "outcome")), sorted(WORKSPACE_LEASE_OUTCOMES));
  assert.deepEqual(sorted(finite(defs.workspaceLease?.properties?.recovered)), sorted(WORKSPACE_RECOVERY_VALUES));
  assert.deepEqual(sorted(values("childLifecycle", "state")), sorted(CHILD_LIFECYCLE_STATES));
  assert.deepEqual(sorted(values("childLifecycle", "signal")), sorted([...CHILD_PROCESS_SIGNALS, null]));
  assert.deepEqual(sorted(finite(defs.refusalCode)), sorted(REFUSAL_CODES));
  assert.deepEqual(sorted(values("workflowFact", "provenance")), sorted(WORKFLOW_FACT_PROVENANCE));
  assert.deepEqual(sorted(values("workflowFact", "kind")), sorted(WORKFLOW_FACT_KINDS));
  assert.deepEqual(sorted(values("workflowFact", "state")), sorted(WORKFLOW_FACT_STATES));

  assert.deepEqual(fields("capabilityDecision"), [...CAPABILITY_FIELDS].sort());
  assert.deepEqual(fields("workspaceLease"), [...LEASE_FIELDS].sort());
  assert.deepEqual(fields("childLifecycle"), [...LIFECYCLE_FIELDS].sort());
  assert.deepEqual(fields("checkReceipt"), [...RECEIPT_FIELDS].sort());
  assert.deepEqual(fields("workflowFact"), [...WORKFLOW_FACT_FIELDS].sort());
  assert.deepEqual(required("capabilityDecision"), [...CAPABILITY_REQUIRED].sort());
  assert.deepEqual(required("workspaceLease"), [...LEASE_REQUIRED].sort());
  assert.deepEqual(required("childLifecycle"), [...LIFECYCLE_REQUIRED].sort());
  assert.deepEqual(required("checkReceipt"), [...RECEIPT_REQUIRED].sort());
  assert.deepEqual(required("workflowFact"), [...WORKFLOW_FACT_REQUIRED].sort());
  assert.deepEqual(fields("correlation"), [...CORRELATION_FIELDS].sort());
  assert.deepEqual(fields("refusal"), [...REFUSAL_FIELDS].sort());
  assert.deepEqual(fields("definitionDigest"), [...DEFINITION_FIELDS].sort());
  assert.deepEqual(fields("approvalUse"), [...APPROVAL_USE_FIELDS].sort());
});

test("every v3 builder emits explicit execution identity, including a running Herdr pane", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");
  const result = { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] };
  const decision = buildRecord({
    executionId, parentExecutionId: null, parentId: "d0", childId: "d0.1", depth: 1,
    requested: [], parentGrant: [], result, blocked: false, executor: "process", taskDigest: "1".repeat(64), now,
  });
  const lease = buildWorkspaceLeaseEvent({
    executionId, parentExecutionId: null, childId: "d0.1", workspaceId: "w", root: "/w",
    access: "read", outcome: "uncontended", now,
  });
  const lifecycle = buildChildLifecycleEvent({
    executionId, parentExecutionId: null, childId: "d0.1", state: "running", executor: "herdr",
    deadlineAt: "2026-08-28T12:10:00.000Z", herdrPaneId: "w1:p2", herdrAgentName: "review-d0-1", now,
  });
  const receipt = buildCheckReceiptLedgerEvent({
    executionId, parentExecutionId: null, childId: "check:x", receiptId: "2".repeat(64),
    workspaceId: "w", checkId: "x", treeSha: "tree", now,
  });
  const workflow = buildWorkflowFactEvent({
    factId: "fact:00000000-0000-4000-8000-000000000003", source: "principal-pi-skills",
    provenance: "planned", kind: "workflow_phase", subject: "review", state: "pending",
    correlation: { run_id: "run-1" }, now,
  });
  for (const event of [decision, lease, lifecycle, receipt]) {
    assert.equal(event.ledgerVersion, 3);
    assert.equal(event.executionId, executionId);
    assert.ok(Object.hasOwn(event, "parentExecutionId"));
  }
  assert.equal(workflow.provenance, "planned");
});

test("regenerating v3 restores the refusal enum without touching the frozen v2 schema", async () => {
  const dir = await tempDir("ledger-v3-contract-");
  const schemaCopy = join(dir, "ledger-event.schema.json");
  const original = await json(schemaPath);
  const drifted = structuredClone(original);
  drifted.$defs.refusalCode.enum = drifted.$defs.refusalCode.enum.slice(1);
  await writeFile(schemaCopy, JSON.stringify(drifted, null, 2));
  const fixtureCopies = join(dir, "fixtures");
  await generateLedgerV3Contract({ schema: schemaCopy, fixtures: fixtureCopies });
  assert.equal((await json(join(fixtureCopies, "capability-decision.json"))).ledgerVersion, 3);
  assert.deepEqual((await json(schemaCopy)).$defs.refusalCode.enum, [...REFUSAL_CODES]);
  assert.equal((await json(join(v2Root, "ledger-event.schema.json"))).$defs.capabilityDecision.properties.ledgerVersion.const, 2);
});

test("v2 stays a frozen readable historical contract", async () => {
  const schema = await json(join(v2Root, "ledger-event.schema.json"));
  const validator = Compile(schema);
  for (const name of ["capability-decision", "workspace-lease", "child-lifecycle", "check-receipt"]) {
    const fixture = await json(join(v2Root, "fixtures", `${name}.json`));
    assert.equal(fixture.ledgerVersion, 2);
    assert.equal(validator.Check(fixture), true, name);
    assert.equal(Object.hasOwn(fixture, "executionId"), false);
  }
});
