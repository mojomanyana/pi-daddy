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
import { MAX_CHAIN_STEPS, MAX_CHILDREN_PER_CALL } from "../src/fanout.ts";
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
    executor: "process", now: new Date(),
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
    executor: "process", now: new Date(),
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
          executor: "process", now: new Date(),
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
    blocked: false, executor: "process", now: new Date(),
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
      blocked: denied.length > 0, executor: "process", now: new Date(),
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
      blocked: false, executor: "process", now: new Date(), approvalSources: approvalSources as never,
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
      blocked: false, executor: "process", now: new Date(), approvalSources: { "tool:write": "persisted" } as never,
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

test("R-64: a malformed approvalSources cannot corrupt the tally or delete the report", async () => {
  // Found by an independent pass over the same day's work, and every case confirmed by execution first.
  // These shapes arrive from a torn, hand-edited or foreign line — the input class `verifyLedger` EXISTS
  // for — so "this package never writes that" is not a defence.
  const dir = await tempDir("grants-malformed-");
  const base = {
    ts: "2026-08-14T00:00:00.000Z", parentId: "d0", childId: "d0.1", depth: 1,
    requested: [], parentGrant: [], effective: [], denied: [], clipped: [], gatedBlocked: [], blocked: false,
  };
  const write = async (name: string, records: object[]) => {
    const p = join(dir, name);
    await writeFile(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    return (await verifyLedger(p)).approvals;
  };

  // `{}` beside a non-empty `approved` was counted NOWHERE — silently shrinking the sample that
  // `unattributed` exists to keep visible, which is the exact promise the field's doc comment makes.
  const empty = await write("empty.jsonl", [{ ...base, approved: ["tool:write", "tool:bash"], approvalSources: {} }]);
  assert.equal(empty.unattributed, 2, "an empty map is an ABSENT map, not a map saying nothing");

  // An array passed `typeof === "object"` and was tallied with numeric indices as capability names —
  // inventing a `0@deploy` pair and inflating `persisted`, which is R-63's direction.
  const arr = await write("array.jsonl", [{ ...base, agentType: "deploy", approved: ["tool:write"], approvalSources: ["persisted"] as never }]);
  assert.equal(arr.bySource.persisted, 0, "an array is not a source map");
  assert.equal(arr.unattributed, 1, "and it is counted, not dropped");

  // **The one that deleted the whole measurement.** `source in bySource` walks the PROTOTYPE, so a source
  // of `"toString"` passed the check, `bySource.toString += 1` wrote a string into a counter, and
  // `attributed` — a sum in the renderer — became a string, so `attributed > 0` was false and the entire
  // approvals block vanished. The intact records beside it were reported as corrupt at the same time.
  const proto = await write("proto.jsonl", [
    { ...base, approved: ["tool:write"], approvalSources: { "tool:write": "toString" } },
    { ...base, agentType: "deploy", approved: ["tool:write"], approvalSources: { "tool:write": "persisted" } },
  ]);
  assert.deepEqual(proto.bySource, { prompt: 0, session: 0, persisted: 1, inherited: 0 }, "no prototype key");
  assert.equal(proto.unattributed, 1, "the unknown source is counted as unattributed");
  assert.equal(
    typeof Object.values(proto.bySource).reduce((s, n) => s + n, 0),
    "number",
    "the renderer sums these — a string here deletes the report it was added to produce",
  );
});

test("R-64: the tools: form is keyed to <delegate>, the subject the approval layer actually uses", async () => {
  // The pair key claimed to match `approvalKey` and did not: the approval subject is `DELEGATE_SUBJECT`
  // (`<delegate>`) while the ledger writes `agentType: spec.agent ?? "delegate"` — the bare word. The old
  // test asserted the mapping using a record with NO agentType, a shape production has never written, so
  // it passed while proving nothing about the real one.
  const dir = await tempDir("grants-subject-key-");
  const path = join(dir, "ledger.jsonl");
  const rec = (agentType: string | undefined, capability: string) =>
    JSON.stringify({
      ts: "2026-08-14T00:00:00.000Z", parentId: "d0", childId: "d0.1", depth: 1, ...(agentType ? { agentType } : {}),
      requested: [], parentGrant: [], effective: [], denied: [], clipped: [], gatedBlocked: [], blocked: false,
      approved: [capability], approvalSources: { [capability]: "persisted" },
    });

  // `agentType: "delegate"` is what run-delegation.ts writes for the tools: form — the shape that matters.
  await writeFile(path, [rec("delegate", "tool:write"), rec(undefined, "tool:write"), rec("deploy", "tool:write")].join("\n") + "\n", "utf8");

  const { distinctBySource } = (await verifyLedger(path)).approvals;
  assert.equal(
    distinctBySource.persisted,
    2,
    "the bare-word and absent forms are ONE approval (tool:write@<delegate>); deploy is the other",
  );
});

test("R-69: the four kinds of unsatisfied gate are distinguishable in the record", async () => {
  // `PromptOutcomeKind` has five members and the record kept one bit of it (`humanDenied`), so `no-ui`,
  // `dismissed` and `error` produced IDENTICAL records — gatedBlocked non-empty, no approvalSource,
  // blocked: true — separated only by free-text `reason` written for a human at the call site. Given a
  // failed run, "was there an operator who timed out, or was there nobody to ask?" had no answer, and the
  // two want opposite fixes: a longer PI_GRANTS_APPROVAL_TIMEOUT versus an operator pre-approving.
  //
  // ADR-0026 rests its decision on this vocabulary being able to say "nobody was there to ask" and be
  // believed, which is why it is recorded rather than inferred.
  const blocked = {
    effective: [], denied: [], clipped: [], gatedBlocked: ["tool:bash"], universal: [], subsumedBy: [],
  };
  const record = (gateOutcome: "no-ui" | "dismissed" | "error" | "declined" | "granted") =>
    buildRecord({
      parentId: "d0", childId: "d0.1", depth: 1, agentType: "deploy", requested: ["tool:bash"],
      parentGrant: ["tool:bash"], result: blocked, blocked: true, executor: "process", now: new Date(),
      humanDenied: gateOutcome === "declined", gateOutcome,
    });

  assert.equal(record("no-ui").gateOutcome, "no-ui", "nobody was there — an operator pre-approves");
  assert.equal(record("dismissed").gateOutcome, "dismissed", "somebody was, and did not answer in time");
  assert.equal(record("error").gateOutcome, "error", "the dialog itself broke — a defect, not a decision");
  assert.equal(record("declined").gateOutcome, "declined");
  assert.equal(record("declined").humanDenied, true, "the older field still says what it always said");

  // A field present on every record is not a signal. An approved spawn already says so via approvalSources.
  assert.equal(record("granted").gateOutcome, undefined, "success is not a reason a gate went unsatisfied");

  // The four unsatisfied kinds must be mutually distinguishable — the whole point.
  const kinds = (["no-ui", "dismissed", "error", "declined"] as const).map((k) => record(k).gateOutcome);
  assert.equal(new Set(kinds).size, 4, "four causes, four values, no free-text parsing");
});

test("ADR-0031: a record names the executor, because the argv differs between them", () => {
  // The production change that breaks this: dropping `executor` from buildRecord, or making it optional.
  //
  // Why it must be recorded at all: before ADR-0031 the executor was a variable an operator set, so "which one
  // ran?" was answerable from configuration afterwards. It is now decided by a runtime probe at session start,
  // and the herdr plan withholds `--print` — so two records with identical capabilities can describe different
  // argv, and nothing outside the record preserves which.
  const shape = {
    parentId: "d0", childId: "d0.1", depth: 1, agentType: "review",
    requested: ["tool:read"], parentGrant: ["tool:read"],
    result: { effective: ["tool:read"], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    blocked: false, now: new Date("2026-08-17T12:00:00Z"),
  };

  assert.equal(buildRecord({ ...shape, executor: "herdr" }).executor, "herdr");
  assert.equal(buildRecord({ ...shape, executor: "process" }).executor, "process");
});

test("ADR-0031: a REFUSED spawn still names an executor — the one the session would have used", () => {
  // A refused spawn has no executor of its own, and omitting the field would make "which refusals came from a
  // herdr session?" unanswerable. The honest value is what the session had settled on.
  const record = buildRecord({
    parentId: "d0", childId: "d0.1", depth: 1, agentType: "review",
    requested: ["tool:bash"], parentGrant: ["tool:read"],
    result: { effective: [], denied: ["tool:bash"], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    blocked: true, reason: "exceeds the parent grant", executor: "herdr", now: new Date(),
  });
  assert.equal(record.blocked, true);
  assert.equal(record.executor, "herdr");
});

test("ADR-0031: the executor survives a round trip through the ledger file", async () => {
  // Written AND read back: a field the writer sets and the parser drops is the shape R-51 was.
  const dir = await tempDir("grants-executor-");
  const path = join(dir, "ledger.jsonl");
  await appendRecord({ path }, buildRecord({
    parentId: "d0", childId: "d0.1", depth: 1, requested: [], parentGrant: [],
    result: { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    blocked: false, executor: "herdr", now: new Date(),
  }));

  const [line] = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(JSON.parse(line).executor, "herdr");

  const report = await verifyLedger(path);
  assert.equal(report.ok, true, "the new field must not make a line unparseable");
  assert.equal(report.records, 1);
});

test("ADR-0033: a chained step records WHICH child composed its task", () => {
  // Without this, "who wrote this instruction?" is unanswerable — and that is the question ADR-0033's handoff
  // decision makes worth asking, since the fence is framing rather than enforcement. No other field carries it:
  // `agentType` names the definition and `definitionDigest` names its instructions.
  //
  // The production change that breaks this: dropping `taskFrom` from buildRecord.
  const base = {
    parentId: "d0", childId: "d0.2", depth: 1, agentType: "review",
    requested: ["tool:read"], parentGrant: ["tool:read"],
    result: { effective: ["tool:read"], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    blocked: false, executor: "process" as const, now: new Date("2026-08-17T12:00:00Z"),
  };

  assert.equal(buildRecord({ ...base, taskFrom: "d0.1" }).taskFrom, "d0.1");
});

test("ADR-0033: a NON-chained spawn asserts no prior author", () => {
  // Optional, unlike `executor`, and the asymmetry is the point: an empty string would claim a predecessor that
  // does not exist. The production change that breaks this: making the field required, or defaulting it to "".
  const record = buildRecord({
    parentId: "d0", childId: "d0.1", depth: 1, agentType: "review",
    requested: ["tool:read"], parentGrant: ["tool:read"],
    result: { effective: ["tool:read"], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    blocked: false, executor: "process", now: new Date(),
  });
  assert.equal(record.taskFrom, undefined);
  assert.ok(!("taskFrom" in record), "and the key should be absent, not present-and-undefined");
});

test("ADR-0033: MAX_CHAIN_STEPS is derived from MAX_CHILDREN_PER_CALL so the two cannot drift", () => {
  assert.equal(MAX_CHAIN_STEPS, MAX_CHILDREN_PER_CALL);
});
