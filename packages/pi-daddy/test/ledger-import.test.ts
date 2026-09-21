import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { importLegacyLedger } from "../src/governance/ledger.ts";
import { readRecordsFile } from "../src/governance/record.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

// ADR-0076 PR 3d: the old ledger is imported once, verbatim bodies, each record marked with its source line; the
// source is never touched, a torn source tail stops the import visibly, and an existing target is never appended to.
test("a pre-format ledger imports once with source markers and stops at a torn line", async () => {
  const dir = await tempDir("ledger-import-");
  const source = join(dir, "grants.jsonl"),
    target = join(dir, "pi-daddy", "grants.jsonl");
  const v3 = {
    ledgerVersion: 3,
    event: "child_lifecycle",
    ts: "2026-09-01T00:00:00.000Z",
    childId: "d0.1",
    state: "starting",
    executor: "process",
  };
  const legacy = {
    ts: "2026-08-16T10:00:00.000Z",
    parentId: "d0",
    childId: "d0.1",
    requested: [],
    parentGrant: [],
    effective: [],
    denied: [],
    clipped: [],
    gatedBlocked: [],
    blocked: false,
  };
  await writeFile(source, `${JSON.stringify(legacy)}\n${JSON.stringify(v3)}\n`);
  const first = await importLegacyLedger(source, target);
  assert.deepEqual(first, { imported: 2, stoppedAt: null, skipped: null });
  const read = await readRecordsFile(target);
  assert.equal(read.damage, null);
  assert.deepEqual(
    read.records.map((r) => [r.kind, r.imported?.line]),
    [
      ["capability", 1],
      ["lifecycle", 2],
    ],
  );
  assert.deepEqual(read.records[1].body, v3, "bodies are verbatim");
  assert.equal(
    await readFile(source, "utf8"),
    `${JSON.stringify(legacy)}\n${JSON.stringify(v3)}\n`,
    "the source is untouched",
  );
  assert.deepEqual(await importLegacyLedger(source, target), {
    imported: 0,
    stoppedAt: null,
    skipped: "target-exists",
  });
  assert.equal(read.records.length, (await readRecordsFile(target)).records.length, "a second import appends nothing");

  const torn = join(dir, "torn.jsonl"),
    target2 = join(dir, "pi-daddy", "torn-target.jsonl");
  await writeFile(torn, `${JSON.stringify(v3)}\n`);
  await appendFile(torn, '{"ledgerVersion":3,"event":"child_life');
  const second = await importLegacyLedger(torn, target2);
  assert.deepEqual(second, { imported: 1, stoppedAt: 2, skipped: null });
  assert.equal(existsSync(target2), true);
  assert.deepEqual(await importLegacyLedger(join(dir, "missing.jsonl"), join(dir, "pi-daddy", "x.jsonl")), {
    imported: 0,
    stoppedAt: null,
    skipped: "source-missing",
  });
});
