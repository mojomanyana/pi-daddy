import assert from "node:assert/strict";
import { after, test } from "node:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeSessionAutoMode, setAutoApproval, closeSessionAutoMode } from "../extensions/session-auto-mode.ts";
import type { GrantsSession } from "../extensions/session.ts";
import { newEpisodeId } from "../src/kernel/episode-id.ts";
import {
  appendLedgerEvent,
  buildAutoModeConfigEvent,
  buildEpisodeCostGateEvent,
  buildEpisodeOutcomeEvent,
  buildSessionConfigEvent,
  verifyLedger,
} from "../src/governance/ledger.ts";
import { appendRecord, readRecords } from "../src/governance/record.ts";
import { validateLedgerV3Event } from "../src/governance/ledger-v3-validation.ts";
import { buildLedgerV3ContractFixtures } from "../scripts/generate-ledger-record-contract.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
const episodeId = newEpisodeId();
const now = new Date("2026-10-09T12:00:00.000Z");
const autoFact = () => buildAutoModeConfigEvent({ episodeId, enabled: true, source: "session", revision: 1, now });
const costFact = () =>
  buildEpisodeCostGateEvent({
    episodeId,
    executionId: "exec:00000000-0000-4000-8000-000000000001",
    parentExecutionId: null,
    childId: "fixture@d1",
    cost: 1,
    ceiling: 2,
    outcome: "stopped",
    now,
  });
const outcomeFact = () =>
  buildEpisodeOutcomeEvent({
    episodeId,
    commit: "a".repeat(40),
    survived: true,
    ci: "green",
    amended: false,
    corrected: false,
    label: "positive",
    now,
  });

test("real session Auto ON/OFF audit writes remain valid ledger history without counting approvals", async () => {
  const path = join(await tempDir("ledger-auto-facts-"), "grants.jsonl");
  const session = {
    ownerBound: true,
    episodeId,
    ledgerPath: path,
    reloadLifecycle: { root: {} },
  } as unknown as GrantsSession;
  try {
    await initializeSessionAutoMode(session, {}, "ledger-auto-fixture");
    await setAutoApproval(session, true, "dashboard");
    await setAutoApproval(session, false, "dashboard");
    const text = await readFile(path, "utf8");
    const read = readRecords<Record<string, unknown>>(text);
    assert.equal(read.damage, null);
    assert.equal(read.records.length, 2);
    assert.deepEqual(
      read.records.map(({ kind, body }) => {
        assert.equal(validateLedgerV3Event(body), null);
        return [kind, body.event, body.trigger, body.autoMode];
      }),
      [
        ["fact", "session_config", "auto-mode", { enabled: true, source: "session", revision: 1 }],
        ["fact", "session_config", "auto-mode", { enabled: false, source: "session", revision: 2 }],
      ],
    );
    const report = await verifyLedger(path);
    assert.equal(report.ok, true);
    assert.deepEqual(report.corrupt, []);
    assert.equal(report.events, 2);
    assert.equal(report.records, 0);
    assert.equal(report.retired, 0);
    assert.deepEqual(report.executors, { herdr: 0, process: 0, unknown: 0 });
    assert.deepEqual(report.lifecycle, { starting: 0, running: 0, completed: 0, failed: 0 });
    assert.ok(Object.values(report.approvals.bySource).every((count) => count === 0));
    assert.ok(Object.values(report.approvals.distinctBySource).every((count) => count === 0));
    assert.equal(report.approvals.unattributed, 0);
    assert.equal(report.approvals.humanDenied, 0);
    assert.equal(await readFile(path, "utf8"), text, "verification must preserve the original evidence");
  } finally {
    await closeSessionAutoMode(session);
  }
});

test("supported supplemental facts preserve the capability summary in a mixed ledger", async () => {
  const path = join(await tempDir("ledger-mixed-facts-"), "grants.jsonl");
  const decision = buildLedgerV3ContractFixtures()["capability-decision.json"];
  await appendLedgerEvent({ path }, decision);
  const before = await verifyLedger(path);
  assert.equal(before.ok, true);
  for (const fact of [
    buildSessionConfigEvent({ episodeId, outcome: "kept", trigger: "first-delegation", overrides: new Map(), now }),
    costFact(),
    outcomeFact(),
  ]) {
    await appendLedgerEvent({ path }, fact);
  }
  const after = await verifyLedger(path);
  assert.deepEqual(after, { ...before, events: before.events + 3 });
});

test("valid envelopes do not make malformed, unversioned or unknown supplemental bodies valid", async () => {
  const dir = await tempDir("ledger-invalid-facts-");
  const invalid = [
    { ...autoFact(), autoMode: { enabled: "yes", source: "session", revision: 1 } },
    { ...costFact(), cost: -1 },
    { ...outcomeFact(), label: "unrecognized" },
    { ...autoFact(), event: "future_fact" },
    { ...autoFact(), ledgerVersion: 2 },
    { ...autoFact(), ledgerVersion: undefined },
  ];
  for (const [index, body] of invalid.entries()) {
    const path = join(dir, `${index}.jsonl`);
    await appendRecord(path, "fact", body);
    const text = await readFile(path, "utf8");
    assert.equal(readRecords(text).damage, null, "this is body invalidity, not an envelope failure");
    const report = await verifyLedger(path);
    assert.equal(report.ok, false);
    assert.equal(report.events, 0);
    assert.equal(report.records, 0);
    assert.deepEqual(report.corrupt, [{ line: 1, reason: "invalid ledger line" }]);
    assert.equal(await readFile(path, "utf8"), text);
  }
});

test("supplemental facts do not hide a torn tail or a changed record digest", async () => {
  const dir = await tempDir("ledger-damaged-facts-");
  for (const kind of ["torn-tail", "digest"] as const) {
    const path = join(dir, `${kind}.jsonl`);
    await appendLedgerEvent({ path }, autoFact());
    if (kind === "torn-tail") await appendFile(path, '{"unfinished":');
    else {
      const event = JSON.parse(await readFile(path, "utf8"));
      event.body.autoMode.enabled = false;
      await writeFile(path, `${JSON.stringify(event)}\n`);
    }
    const text = await readFile(path, "utf8");
    const report = await verifyLedger(path);
    assert.equal(report.ok, false);
    assert.equal(report.events, kind === "torn-tail" ? 1 : 0);
    assert.equal(report.corrupt.length, 1);
    assert.equal(report.corrupt[0]!.line, kind === "torn-tail" ? 2 : 1);
    assert.match(report.corrupt[0]!.reason, /^ledger damaged:/);
    assert.equal(await readFile(path, "utf8"), text);
  }
});
