import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  appendRecord,
  LEDGER_DAMAGED,
  readRecordsFile,
  readRecords,
  repairLedger,
  RECORD_FORMAT,
  recordDigest,
} from "../src/governance/record.ts";
import { GovernanceRefusal } from "../src/kernel/refusals.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

/**
 * ADR-0076 PR 3d: one record envelope for every append-only store. Each line chains to the previous line's
 * bytes and carries its own digest; the reader returns the intact prefix plus one damage marker; the writer
 * refuses to append to a damaged file until an explicit repair truncates the torn tail (operator decision
 * 2026-09-21: read the intact prefix, refuse to append).
 */
test("records chain, digest, and read back in order", async () => {
  const path = join(await tempDir("record-chain-"), "ledger.jsonl");
  const first = await appendRecord(path, "capability", { effective: ["tool:read"] });
  const second = await appendRecord(path, "lifecycle", { state: "starting" });
  assert.equal(first.v, RECORD_FORMAT);
  assert.equal(first.seq, 1);
  assert.equal(first.prev, null);
  assert.equal(second.seq, 2);
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(
    second.prev,
    createHash("sha256").update(lines[0], "utf8").digest("hex"),
    "prev is the previous line's bytes",
  );
  assert.equal(first.digest, recordDigest(first), "digest covers the record minus itself");
  const read = readRecords(await readFile(path, "utf8"));
  assert.equal(read.damage, null);
  assert.deepEqual(
    read.records.map((r) => [r.kind, r.seq]),
    [
      ["capability", 1],
      ["lifecycle", 2],
    ],
  );
  assert.deepEqual(read.records[0].body, { effective: ["tool:read"] });
});

test("a torn tail yields the intact prefix and one damage marker, and the writer refuses until repaired", async () => {
  const path = join(await tempDir("record-torn-"), "ledger.jsonl");
  await appendRecord(path, "capability", { n: 1 });
  await appendRecord(path, "capability", { n: 2 });
  await appendFile(path, '{"v":1,"seq":3,"kind":"capab');
  const read = await readRecordsFile(path);
  assert.equal(read.records.length, 2, "everything before the tear is readable");
  assert.deepEqual(read.damage, { line: 3, reason: "unterminated or unparsable line" });
  // Production change that breaks this: appending past damage (the 'skip the bad line' policy the operator rejected).
  await assert.rejects(
    appendRecord(path, "capability", { n: 3 }),
    (error: unknown) => error instanceof GovernanceRefusal && error.code === LEDGER_DAMAGED,
  );
  const preview = await repairLedger(path, { apply: false });
  assert.deepEqual(preview.dropped, ['{"v":1,"seq":3,"kind":"capab']);
  assert.equal((await readRecordsFile(path)).damage?.line, 3, "a preview changes nothing");
  const repaired = await repairLedger(path, { apply: true });
  assert.equal(repaired.dropped.length, 1);
  assert.equal((await readRecordsFile(path)).damage, null);
  const third = await appendRecord(path, "capability", { n: 3 });
  assert.equal(third.seq, 3, "the sequence resumes after the intact prefix");
});

test("a tampered record is damage at that line, not a skipped warning", async () => {
  const path = join(await tempDir("record-tamper-"), "ledger.jsonl");
  await appendRecord(path, "capability", { n: 1 });
  await appendRecord(path, "capability", { n: 2 });
  await appendRecord(path, "capability", { n: 3 });
  const lines = (await readFile(path, "utf8")).split("\n");
  const tampered = JSON.parse(lines[1]);
  tampered.body.n = 99; // digest no longer matches
  lines[1] = JSON.stringify(tampered);
  await writeFile(path, lines.join("\n"));
  const read = readRecords(lines.join("\n"));
  assert.equal(read.records.length, 1);
  assert.deepEqual(read.damage, { line: 2, reason: "digest mismatch" });
  // Re-serialising with a fresh digest but leaving line 3's prev pointing at the old bytes is caught one line later.
  tampered.digest = recordDigest(tampered);
  lines[1] = JSON.stringify(tampered);
  const chained = readRecords(lines.join("\n"));
  assert.equal(chained.records.length, 2);
  assert.deepEqual(chained.damage, { line: 3, reason: "prev hash mismatch" });
});

test("sequence numbers must be contiguous from 1 and kinds must be known", () => {
  const good = readRecords("");
  assert.deepEqual(good, { records: [], damage: null });
  const bogus = { v: 1, seq: 2, prev: null, at: "2026-09-21T00:00:00.000Z", kind: "capability", id: "r-1", body: {} };
  const line = JSON.stringify({ ...bogus, digest: recordDigest(bogus) }) + "\n";
  assert.deepEqual(readRecords(line).damage, { line: 1, reason: "sequence gap" });
  const unknown = { ...bogus, seq: 1, kind: "mystery" };
  assert.deepEqual(readRecords(JSON.stringify({ ...unknown, digest: recordDigest(unknown) }) + "\n").damage, {
    line: 1,
    reason: "unknown kind",
  });
});
