/**
 * G6 — ledger integrity (review findings A-S3, A-A5, B-I2, B-I3).
 *
 * The ledger is the package's only evidence that governance happened. Two defects made it lie, and one
 * left its own write path unexercised:
 *
 *  - **A-S3** — `decideSpawn` returns no `ResolveResult` on six of its eight paths, so the extension
 *    recomputes one from different inputs (`grants.ts:326`). `resolve()` has no notion of the wildcard,
 *    so a wildcard delegator's grant matches nothing and every ALLOWED wildcard spawn is recorded with
 *    `denied` non-empty — which `isEscalationAttempt()` reports as an attack.
 *  - **A-A5** — `appendRecord` had zero tests despite `ledger.ts` documenting a fail-closed contract.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentType } from "../src/agent-types.ts";
import { makeCatalog } from "../src/catalog.ts";
import { planDelegation } from "../src/delegate.ts";
import { decideSpawn } from "../src/interceptor.ts";
import { appendRecord, buildRecord, isEscalationAttempt } from "../src/ledger.ts";

const types = (...defs: AgentType[]) => new Map(defs.map((d) => [d.name, d]));
const docsWriter: AgentType = { name: "docs-writer", tools: ["read", "write"], source: "x.md" };

const recordFor = (decision: ReturnType<typeof decideSpawn>, parentGrant: string[]) =>
  buildRecord({
    parentId: "d0",
    childId: `${decision.typeName}@d${decision.childDepth}`,
    depth: decision.childDepth,
    agentType: decision.typeName,
    requested: decision.requested,
    parentGrant,
    // The extension uses `decision.result ?? resolve(...)`; a decision that always carries its own
    // result is what removes the recompute entirely.
    result: decision.result!,
    blocked: !decision.allow,
    reason: decision.reason,
    now: new Date(),
  });

test("an ALLOWED wildcard spawn is not recorded as an escalation attempt", () => {
  const decision = decideSpawn(
    { subagentType: "docs-writer" },
    { parentGrant: ["tool:*"], depth: 0, maxDepth: 2, types: types(docsWriter) },
  );
  assert.equal(decision.allow, true, "precondition: a wildcard holder may spawn this type");
  assert.ok(decision.result, "every decision must carry the result it was made from");
  assert.equal(
    isEscalationAttempt(recordFor(decision, ["tool:*"])),
    false,
    "the ledger's one signal must not fire for a spawn the interceptor allowed",
  );
});

test("a decision refused before resolution still carries a result", () => {
  // Depth, missing type name, and unknown type all return before `resolve()` is reached, so the
  // extension had nothing to record and `if (ledgerPath && plan.result)` skipped the entry entirely.
  for (const [label, decision] of [
    [
      "depth limit",
      decideSpawn(
        { subagentType: "docs-writer" },
        { parentGrant: ["tool:read"], depth: 5, maxDepth: 2, types: types(docsWriter) },
      ),
    ],
    [
      "no subagent_type",
      decideSpawn({}, { parentGrant: ["tool:read"], depth: 0, maxDepth: 2, types: types(docsWriter) }),
    ],
    [
      "spawning disabled",
      decideSpawn(
        { subagentType: "docs-writer" },
        { parentGrant: ["tool:read"], depth: 0, maxDepth: 0, types: types(docsWriter) },
      ),
    ],
  ] as const) {
    assert.equal(decision.allow, false, `${label}: precondition`);
    assert.ok(decision.result, `${label}: a refusal with no result cannot be recorded`);
  }
});

test("a wildcard-ceiling refusal carries a result too", () => {
  const decision = decideSpawn(
    { subagentType: "unknown-type" },
    { parentGrant: ["tool:read"], depth: 0, maxDepth: 2, types: types(docsWriter) },
  );
  assert.equal(decision.allow, false);
  assert.ok(decision.result);
});

test("a delegation refused before resolution still carries a result", () => {
  // B-I3. The extension guarded its ledger write with `if (ledgerPath && plan.result)`, so these four
  // refusals — every one of them a governance decision worth auditing — were never recorded at all.
  const base = { ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: [] };
  const cases = [
    ["disabled", planDelegation({ task: "t", tools: [] }, { ...base, maxDepth: 0 })],
    ["depth limit", planDelegation({ task: "t", tools: [] }, { ...base, depth: 9 })],
    ["empty task", planDelegation({ task: "   ", tools: [] }, base)],
    [
      "unknown capability",
      planDelegation({ task: "t", tools: ["nope"] }, { ...base, catalog: makeCatalog([]) }),
    ],
  ] as const;

  for (const [label, plan] of cases) {
    assert.equal(plan.ok, false, `${label}: precondition`);
    assert.ok(plan.result, `${label}: a refusal with no result is dropped by the ledger`);
  }
});

test("appendRecord writes one JSON line per record, appending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grants-ledger-"));
  const path = join(dir, "nested", "grants.jsonl");
  const record = buildRecord({
    parentId: "d0",
    childId: "c@d1",
    depth: 1,
    agentType: "docs-writer",
    requested: ["tool:read"],
    parentGrant: ["tool:read"],
    result: { effective: ["tool:read"], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    blocked: false,
    now: new Date(),
  });

  await appendRecord({ path }, record);
  await appendRecord({ path }, record);

  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2, "appendRecord must append, never truncate");
  assert.equal(JSON.parse(lines[0]).agentType, "docs-writer");
});

test("appendRecord fails closed by default when the ledger cannot be written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grants-ledger-"));
  // A regular file where a directory must be: mkdir(dirname) cannot succeed.
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "not a directory");

  await assert.rejects(
    () => appendRecord({ path: join(blocker, "grants.jsonl") }, {} as never),
    /failing closed/,
    "ledger.ts documents that an unrecorded grant must fail closed — that is the default",
  );
});

test("appendRecord in non-strict mode swallows the failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grants-ledger-"));
  const blocker = join(dir, "blocker");
  await mkdir(dir, { recursive: true });
  await writeFile(blocker, "not a directory");

  await assert.doesNotReject(() =>
    appendRecord({ path: join(blocker, "grants.jsonl"), strict: false }, {} as never),
  );
});
