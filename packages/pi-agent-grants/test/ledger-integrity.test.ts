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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeCatalog } from "../src/catalog.ts";
import type { SkillDefinition } from "../src/definitions.ts";
import { planDelegation } from "../src/delegate.ts";
import { appendRecord, buildRecord, isEscalationAttempt, verifyLedger } from "../src/ledger.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

// RETARGETED by ADR-0016. These tests were written against `decideSpawn`, the interceptor's decision
// function, which is deleted along with the rest of the pi-subagents port. **The properties they guard
// survive intact** — every refusal must carry the result it was decided from, and the ledger's one
// security signal must not fire on an allowed spawn — so they are re-pointed at `planDelegation`, which
// is now the only decision function, rather than deleted with the code they happened to exercise.
const definitions = (...defs: SkillDefinition[]) => new Map(defs.map((d) => [d.name, d]));
const docsWriter: SkillDefinition = {
  name: "docs-writer",
  description: "Writes docs",
  allowedTools: "read write",
  body: "Write docs.",
  source: "/skills/docs-writer/SKILL.md",
};

const recordFor = (plan: ReturnType<typeof planDelegation>, parentGrant: string[], agentType: string) =>
  buildRecord({
    parentId: "d0",
    childId: `${agentType}@d${plan.childDepth}`,
    depth: plan.childDepth,
    agentType,
    requested: plan.requested,
    parentGrant,
    // A plan that always carries its own result is what removes the extension's recompute entirely.
    result: plan.result,
    blocked: !plan.ok,
    reason: plan.reason,
    now: new Date(),
  });

test("an ALLOWED wildcard spawn is not recorded as an escalation attempt", () => {
  // The grant here is what `deriveOwnGrant` ACTUALLY produces for a wildcard holder that has observed
  // its tools: the wildcard **plus the enumerated names**. That detail is the whole point of this test —
  // `resolve()` has no notion of `tool:*` (see A-S3 above), so a wildcard-only grant matches nothing and
  // would be refused. Writing `["tool:*"]` alone here would test an unreachable state and, worse, would
  // read as evidence that a wildcard grant is honoured directly. It is not; it is expanded first.
  const plan = planDelegation(
    { task: "write the docs", agent: "docs-writer" },
    {
      ownGrant: ["tool:*", "tool:read", "tool:write"],
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: definitions(docsWriter),
    },
  );
  assert.equal(plan.ok, true, `precondition: a wildcard holder may spawn this definition — ${plan.reason}`);
  assert.equal(
    isEscalationAttempt(recordFor(plan, ["tool:*"], "docs-writer")),
    false,
    "the ledger's one signal must not fire for a spawn that was allowed",
  );
});

test("a definition spawn refused before resolution still carries a result", () => {
  // Depth, a missing task, and an unknown name all return before `resolve()` is reached, so there was
  // nothing to record and `if (ledgerPath && plan.result)` skipped the entry entirely.
  const known = { definitions: definitions(docsWriter), gated: [] as string[] };
  for (const [label, plan] of [
    [
      "depth limit",
      planDelegation({ task: "t", agent: "docs-writer" }, { ownGrant: ["tool:read"], depth: 5, maxDepth: 2, ...known }),
    ],
    [
      "no task",
      planDelegation({ task: "", agent: "docs-writer" }, { ownGrant: ["tool:read"], depth: 0, maxDepth: 2, ...known }),
    ],
    [
      "spawning disabled",
      planDelegation({ task: "t", agent: "docs-writer" }, { ownGrant: ["tool:read"], depth: 0, maxDepth: 0, ...known }),
    ],
    [
      "unknown definition",
      planDelegation({ task: "t", agent: "nope" }, { ownGrant: ["tool:read"], depth: 0, maxDepth: 2, ...known }),
    ],
    [
      // ADR-0016's inversion: undeclared is the WEAKEST state. The old format's equivalent case resolved
      // to the wildcard, which is why this one is worth pinning.
      "undeclared allowed-tools",
      planDelegation(
        { task: "t", agent: "docs-writer" },
        {
          ownGrant: ["tool:read"],
          depth: 0,
          maxDepth: 2,
          gated: [],
          definitions: definitions({ ...docsWriter, allowedTools: undefined }),
        },
      ),
    ],
  ] as const) {
    assert.equal(plan.ok, false, `${label}: precondition`);
    assert.ok(plan.result, `${label}: a refusal with no result cannot be recorded`);
  }
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
  const dir = await tempDir("grants-ledger-");
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
  const dir = await tempDir("grants-ledger-");
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
  const dir = await tempDir("grants-ledger-");
  const blocker = join(dir, "blocker");
  await mkdir(dir, { recursive: true });
  await writeFile(blocker, "not a directory");

  await assert.doesNotReject(() =>
    appendRecord({ path: join(blocker, "grants.jsonl"), strict: false }, {} as never),
  );
});

// ---------------------------------------------------------------------------
// Fan-out made concurrent appends ordinary rather than theoretical (review finding F13).
//
// Two separate problems, and they need different answers:
//
//  1. **Nothing ever read the ledger back.** `appendRecord`'s strict mode catches write *errors*, not
//     corruption, so a torn line would be lost exactly at peak concurrency — which is when the audit
//     trail matters most. Detection is the compensating control ADR-0008 relies on and never had.
//  2. **Concurrent writers.** `O_APPEND` is atomic for a single write to a regular file on a POSIX
//     filesystem. It promises nothing on drvfs (`/mnt/c` under WSL2) or NFS, and `ENV_LEDGER` propagates
//     to children, so a subtree can have many processes appending to one file.
// ---------------------------------------------------------------------------

test("F13: a ledger of concurrent appends is fully parseable", async () => {
  const dir = await tempDir("grants-concurrent-");
  const path = join(dir, "ledger.jsonl");
  const big = Array.from({ length: 120 }, (_, i) => `tool:capability-with-a-longish-name-${i}`);

  // Records deliberately far larger than any single-write atomicity window, appended concurrently.
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      appendRecord(
        { path, strict: true },
        buildRecord({
          parentId: "d0",
          childId: `d0.${i + 1}`,
          depth: 1,
          requested: big,
          parentGrant: big,
          result: { effective: big, denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
          blocked: false,
          now: new Date(),
        }),
      ),
    ),
  );

  const report = await verifyLedger(path);
  assert.equal(report.corrupt.length, 0, `every line must parse, got ${JSON.stringify(report.corrupt.slice(0, 2))}`);
  assert.equal(report.records, 40, "and none may be lost");
});

test("verifyLedger reports a torn line instead of ignoring it", async () => {
  // The point of the detector. Without it, a truncated record is indistinguishable from a spawn that never
  // happened — a gap in the audit trail that reads as an absence of activity.
  const dir = await tempDir("grants-torn-");
  const path = join(dir, "ledger.jsonl");
  await appendRecord({ path }, buildRecord({
    parentId: "d0", childId: "d0.1", depth: 1, requested: [], parentGrant: [],
    result: { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    blocked: false, now: new Date(),
  }));
  await writeFile(path, `${await readFile(path, "utf8")}{"parentId":"d0","childId":"d0.2","dep\n`, "utf8");

  const report = await verifyLedger(path);
  assert.equal(report.records, 1);
  assert.equal(report.corrupt.length, 1);
  assert.equal(report.corrupt[0].line, 2, "the line number is what makes it actionable");
  assert.equal(report.ok, false);
});

test("verifyLedger on a missing ledger is not an error", async () => {
  // An operator who has not set PI_GRANTS_LEDGER has no ledger, which is a configuration state rather than
  // a corruption. Reporting it as damage would train them to ignore the check.
  const dir = await tempDir("grants-absent-");
  const report = await verifyLedger(join(dir, "nope.jsonl"));
  assert.equal(report.ok, true);
  assert.equal(report.records, 0);
  assert.equal(report.exists, false);
});

test("verifyLedger counts escalation attempts, so the one signal is readable", async () => {
  const dir = await tempDir("grants-esc-");
  const path = join(dir, "ledger.jsonl");
  for (const denied of [[], ["tool:write"], []]) {
    await appendRecord({ path }, buildRecord({
      parentId: "d0", childId: "d0.1", depth: 1, requested: [], parentGrant: [],
      result: { effective: [], denied, clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
      blocked: denied.length > 0, now: new Date(),
    }));
  }
  const report = await verifyLedger(path);
  assert.equal(report.records, 3);
  assert.equal(report.escalationAttempts, 1);
});

test("ADR-0020: verifyLedger tallies where each yes came from, per capability", async () => {
  // The measurement ADR-0020 named and nothing performed. `persisted` is the number that settles it: each
  // one is a prompt the operator never saw, so it is the size of what deleting the layer would cost.
  const dir = await tempDir("grants-sources-");
  const path = join(dir, "ledger.jsonl");
  const record = (approvalSources: Record<string, string>, humanDenied = false) =>
    appendRecord({ path }, buildRecord({
      parentId: "d0", childId: "d0.1", depth: 1, requested: [], parentGrant: [],
      result: { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
      blocked: false, now: new Date(), approvalSources: approvalSources as never,
      ...(humanDenied ? { humanDenied: true } : {}),
    } as never));

  // Deliberately a MIXED record: two capabilities, two different sources. Counting per record instead of
  // per capability is the specific error R-46 already made once with the scalar, and it would report this
  // as one prompt — halving the persisted count in exactly the direction that flatters the layer.
  await record({ "tool:bash": "persisted", "tool:write": "prompt" });
  await record({ "tool:bash": "persisted" });
  await record({ "skill:deploy": "inherited" }, true);

  const { bySource, unattributed, humanDenied } = (await verifyLedger(path)).approvals;
  assert.deepEqual(bySource, { prompt: 1, session: 0, persisted: 2, inherited: 1 });
  assert.equal(unattributed, 0);
  assert.equal(humanDenied, 1, "a human saying no is the fatigue argument's other half");
});

test("ADR-0020: records are counted separately from distinct capability@subject pairs", async () => {
  // **The bias this exists to remove, and it was in the first version of this feature.** Counting
  // `persisted` RECORDS as prompts avoided overstates the layer: precedence is inherited → session →
  // persisted → prompt, and `session` approvals live in memory owing the store nothing. So a session
  // spawning `deploy` twenty times under ONE persisted entry writes twenty records, while deleting the
  // store would raise ONE prompt and satisfy the other nineteen from the session cache. Twentyfold, in
  // favour of keeping the thing under evaluation.
  const dir = await tempDir("grants-pairs-");
  const path = join(dir, "ledger.jsonl");
  const spawn = (agentType: string) =>
    appendRecord({ path }, buildRecord({
      parentId: "d0", childId: "d0.1", depth: 1, agentType, requested: [], parentGrant: [],
      result: { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
      blocked: false, now: new Date(), approvalSources: { "tool:write": "persisted" } as never,
    } as never));

  for (let i = 0; i < 5; i += 1) await spawn("deploy");
  await spawn("review");

  const { bySource, distinctBySource } = (await verifyLedger(path)).approvals;
  assert.equal(bySource.persisted, 6, "six records, which is the upper bound and NOT the answer");
  assert.equal(
    distinctBySource.persisted,
    2,
    "tool:write@deploy and tool:write@review — the closer estimate, and the number a reader should quote",
  );
});

test("ADR-0020: the same capability under two subjects is two pairs, not one", async () => {
  // The pair key must carry the SUBJECT. Keying on capability alone would collapse `tool:write@deploy` and
  // `tool:write@review` into one — under-counting this time, which is the other direction and equally
  // wrong. It is the same keying `approvalKey` uses, so the report cannot disagree with the store about
  // what one approval is.
  const dir = await tempDir("grants-subject-");
  const path = join(dir, "ledger.jsonl");
  await writeFile(
    path,
    [
      JSON.stringify({ ts: "2026-08-14T00:00:00.000Z", parentId: "d0", childId: "d0.1", depth: 1, agentType: "deploy", requested: [], parentGrant: [], effective: [], denied: [], clipped: [], gatedBlocked: [], blocked: false, approvalSources: { "tool:write": "persisted" } }),
      // No `agentType` at all — the `tools:` delegation form, whose subject is `<delegate>`.
      JSON.stringify({ ts: "2026-08-14T00:00:01.000Z", parentId: "d0", childId: "d0.2", depth: 1, requested: [], parentGrant: [], effective: [], denied: [], clipped: [], gatedBlocked: [], blocked: false, approvalSources: { "tool:write": "persisted" } }),
    ].join("\n") + "\n",
    "utf8",
  );

  const { distinctBySource } = (await verifyLedger(path)).approvals;
  assert.equal(distinctBySource.persisted, 2, "tool:write@deploy and tool:write@<delegate> are two approvals");
});

test("ADR-0020: a pre-0.11.1 line is counted as unattributed, never as a prompt", async () => {
  // The bias this must not have. Before per-capability sources, ONE scalar described the whole set even
  // when the sources differed (R-46) — so folding `approvalSource` into the tally would report humans as
  // having been asked about capabilities they were never asked about, inflating `prompt` against the
  // `persisted` number the whole measurement turns on. Old lines shrink the sample; they never colour it.
  const dir = await tempDir("grants-legacy-src-");
  const path = join(dir, "ledger.jsonl");
  await writeFile(
    path,
    `${JSON.stringify({
      ts: new Date().toISOString(), parentId: "d0", childId: "d0.1", depth: 1,
      requested: [], parentGrant: [], effective: [], denied: [], clipped: [], gatedBlocked: [],
      blocked: false, approved: ["tool:bash", "tool:write"], approvalSource: "prompt",
    })}\n`,
    "utf8",
  );

  const { bySource, unattributed } = (await verifyLedger(path)).approvals;
  assert.equal(bySource.prompt, 0, "the legacy scalar must not become evidence a human was asked");
  assert.equal(unattributed, 2, "counted, so the sample size is visible rather than silently smaller");
});
