#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildChildLifecycleEvent, buildRecord, buildWorkspaceLeaseEvent } from "../src/governance/ledger.ts";
import type { CorrelationMetadata } from "../src/kernel/correlation.ts";
import { REFUSAL_CODES } from "../src/kernel/refusals.ts";
import { RECORD_FORMAT, RECORD_KINDS, recordDigest } from "../src/governance/record.ts";
import { recordKindForEvent } from "../src/governance/ledger.ts";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, "..", "contracts", "ledger-record", "v1");
const fixtureDir = join(contractDir, "fixtures");
const schemaPath = join(contractDir, "governance-event.schema.json");
const envelopeSchemaPath = join(contractDir, "record.schema.json");

const correlation: CorrelationMetadata = {
  schema_version: "1.0",
  run_id: "run-contract-001",
  task_id: "task-contract-001",
  workspace_id: "workspace-contract",
  context_id: "context-contract",
  phase: "verify",
  assurance: "critical",
  assurance_effective: "critical",
  policy_label: "policy-contract",
  assurance_source: "policy",
  assurance_scope: { type: "selectors", selectors: ["src/**"] },
  activated_at: "2026-08-20T12:00:00.000Z",
  plan_digest: "1".repeat(64),
  definition_digest: "2".repeat(64),
  task_digest: "3".repeat(64),
  base_sha: "4".repeat(40),
  head_sha: "5".repeat(40),
  tree_sha: "6".repeat(40),
  event_seq: 21,
  last_change_seq: 18,
  last_authority_seq: 20,
  check_receipt_id: "7".repeat(64),
};

/** Deterministic examples produced through the same builders as production ledger lines. */
export function buildLedgerV3ContractFixtures() {
  return {
    "capability-decision.json": buildRecord({
      executionId: "exec:00000000-0000-4000-8000-000000000001",
      parentExecutionId: null,
      parentId: "d0",
      childId: "d0.1",
      depth: 1,
      agentType: "build",
      requested: ["tool:bash", "tool:read"],
      parentGrant: ["agent:build", "tool:bash", "tool:read"],
      result: {
        effective: ["tool:bash", "tool:read"],
        denied: [],
        clipped: [],
        gatedBlocked: [],
        universal: [],
        subsumedBy: [],
      },
      blocked: true,
      reason: "workspace-contract already has a governed writer",
      approved: ["tool:bash", "tool:read"],
      approvalSources: { "tool:bash": "persisted", "tool:read": "prompt" },
      approvalScopes: { "tool:bash": "always", "tool:read": "once" },
      approvalExpiresAt: { "tool:bash": "2026-09-19T12:00:00.000Z" },
      approvalUses: { "tool:read": { max: 1, remaining: 0 } },
      definitionDigest: {
        name: "build",
        source: "/operator/skills/build/SKILL.md",
        sha256: "8".repeat(64),
      },
      executor: "process",
      taskFrom: "d0.0",
      taskFromExecutionId: "exec:00000000-0000-4000-8000-000000000000",
      taskDigest: "9".repeat(64),
      refusal: {
        code: "WORKSPACE_WRITE_CONFLICT",
        message: "workspace-contract already has a governed writer",
        details: { workspace_id: "workspace-contract", retryable: true, holder_depth: 1 },
      },
      correlation,
      now: new Date("2026-08-20T12:00:01.000Z"),
    }),
    "workspace-lease.json": buildWorkspaceLeaseEvent({
      executionId: "exec:00000000-0000-4000-8000-000000000001",
      parentExecutionId: null,
      childId: "d0.1",
      workspaceId: "workspace-contract",
      root: "/worktrees/contract",
      access: "write",
      outcome: "acquired",
      recovered: "unknown",
      correlation,
      now: new Date("2026-08-20T12:00:02.000Z"),
    }),
    "child-lifecycle.json": buildChildLifecycleEvent({
      executionId: "exec:00000000-0000-4000-8000-000000000001",
      parentExecutionId: null,
      childId: "d0.1",
      state: "failed",
      executor: "process",
      deadlineAt: "2026-08-20T12:10:00.000Z",
      exitCode: null,
      signal: null,
      aborted: true,
      reason: "child did not start",
      correlation,
      now: new Date("2026-08-20T12:00:03.000Z"),
    }),
  };
}

export async function writeLedgerV3ContractFixtures(target = fixtureDir): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const [name, event] of Object.entries(buildLedgerV3ContractFixtures())) {
    await writeFile(join(target, name), `${JSON.stringify(event, null, 2)}\n`, "utf8");
  }
}

/**
 * Sync the schema's `refusalCode` enum to `REFUSAL_CODES`, which is its only source of truth.
 *
 * **This script wrote fixtures and nothing else, and that was the defect.** The schema — including a closed
 * enum of every refusal code — was hand-maintained beside a `REFUSAL_CODES` array it had to match exactly,
 * with `ledger-contract.test.ts` asserting the equality. So adding `WORKSPACE_NOT_AUTHORIZED` in `src/`
 * turned the suite red, `npm run contracts:generate` produced no diff, and the only route back to green was
 * for somebody to notice which hand-written JSON file to edit. Every future refusal code had the same
 * ambush waiting. Derived now: the test that caught it becomes a check on this function rather than a
 * tripwire on human memory.
 *
 * Only the enum is generated. The rest of the schema stays hand-authored on purpose — it encodes decisions
 * (`additionalProperties: false`, the `const: true` flags, the discriminated union) that no generator should
 * be inventing, and `contracts/ledger-record/v1/README.md` is the compatibility contract for changing them.
 */
export async function syncLedgerV3RefusalEnum(target = schemaPath): Promise<void> {
  const raw = await readFile(target, "utf8");
  const schema = JSON.parse(raw) as { $defs: { refusalCode: { enum: string[] } } };
  schema.$defs.refusalCode.enum = [...REFUSAL_CODES];
  await writeFile(target, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
}

/**
 * Everything `npm run contracts:generate` does, as ONE exported function.
 *
 * The entry point used to call the two steps itself, which made "somebody drops the enum sync from the
 * script" unfalsifiable: a test can call an exported function, and it cannot call the inside of an
 * `if (invoked)` block. The docstring in `test/ledger-contract.test.ts` named exactly that edit as a breaker
 * and a mutation audit showed it was not one. Now the entry point is a one-liner over a function the test
 * drives, so the two cannot diverge.
 */
export async function generateLedgerV3Contract(targets: { schema?: string; fixtures?: string } = {}): Promise<void> {
  await writeRecordEnvelopeSchema();
  await writeRecordFixtureLedger();
  await writeLedgerV3ContractFixtures(targets.fixtures);
  await syncLedgerV3RefusalEnum(targets.schema);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) await generateLedgerV3Contract();

/**
 * The record envelope every ledger line carries since ADR-0076 PR 3d (`src/governance/record.ts`). The body of a
 * governance record is one of the events described by `governance-event.schema.json`; work and activity bodies
 * have their own shapes. Generated from the runtime's constants so the two cannot drift.
 */
export function buildRecordEnvelopeSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/mojomanyana/pi-daddy/contracts/ledger-record/v1/record.schema.json",
    title: "pi-daddy ledger record envelope v1",
    type: "object",
    additionalProperties: false,
    required: ["v", "seq", "prev", "at", "kind", "id", "body", "digest"],
    properties: {
      v: { const: RECORD_FORMAT },
      seq: { type: "integer", minimum: 1 },
      prev: {
        anyOf: [{ type: "null" }, { type: "string", pattern: "^[0-9a-f]{64}$" }],
        description: "SHA-256 of the previous line's bytes; null for the first record",
      },
      at: { type: "string", format: "date-time", description: "the writer's clock, not the body's timestamp" },
      kind: { type: "string", enum: [...RECORD_KINDS] },
      id: { type: "string", minLength: 1, maxLength: 128 },
      body: { description: "the record payload; a governance event validates against governance-event.schema.json" },
      imported: {
        type: "object",
        additionalProperties: false,
        required: ["path", "line"],
        properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 } },
        description: "present on records copied from a pre-format ledger; the source is left untouched",
      },
      digest: {
        type: "string",
        pattern: "^[0-9a-f]{64}$",
        description: "SHA-256 of the canonical JSON of the record without this field",
      },
    },
  };
}

export async function writeRecordEnvelopeSchema(target = envelopeSchemaPath): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(buildRecordEnvelopeSchema(), null, 2)}\n`, "utf8");
}

/** The body fixtures as one chained ledger file, so an installed consumer can exercise the real reader on real lines. */
export function buildRecordFixtureLedger(): string {
  const lines: string[] = [];
  let prev: string | null = null;
  let seq = 0;
  for (const [name, body] of Object.entries(buildLedgerV3ContractFixtures())) {
    seq += 1;
    const draft: Record<string, unknown> = {
      v: RECORD_FORMAT,
      seq,
      prev,
      at: "2026-09-21T00:00:00.000Z",
      kind: recordKindForEvent(body as { event?: string }),
      id: `fixture-${name.replace(/\.json$/, "")}`,
      body,
    };
    const line: string = JSON.stringify({ ...draft, digest: recordDigest(draft) });
    lines.push(line);
    prev = createHash("sha256").update(line, "utf8").digest("hex");
  }
  return lines.join("\n") + "\n";
}

export async function writeRecordFixtureLedger(target = join(fixtureDir, "ledger-record.jsonl")): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buildRecordFixtureLedger(), "utf8");
}
