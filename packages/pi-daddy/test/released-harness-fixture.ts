/**
 * Independent-release guard: the current producer's real retry ledger must still be readable by released Harness.
 * The dedicated CI lane installs exact public packages outside this checkout and sets both paths. Ordinary unit
 * runs need no network or optional package. The lane fails if the fixtures or the pinned consumer are absent.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { recordDigest } from "../src/governance/record.ts";
import { verifyLedger } from "../src/governance/ledger.ts";

const HARNESS_VERSION = "0.35.6";
const DADDY_VERSION = "0.59.1";

async function manifest(root: string, name: string, version: string) {
  const value = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(value.name, name);
  assert.equal(value.version, version, "compatibility must use the released package, not the candidate consumer");
  return value;
}

export async function assertReleasedHarnessLedger(raw: string): Promise<void> {
  const harnessRoot = process.env.DADDY_TEST_RELEASED_HARNESS_PACKAGE;
  const oldDaddyRoot = process.env.DADDY_TEST_RELEASED_DADDY_PACKAGE;
  if (!harnessRoot && !oldDaddyRoot) return;
  assert.ok(harnessRoot && oldDaddyRoot, "released-package lane requires both exact package roots");
  const harness = await manifest(harnessRoot, "@skill-harness/adapters", HARNESS_VERSION);
  await manifest(oldDaddyRoot, "pi-daddy", DADDY_VERSION);
  const adapter = await import(pathToFileURL(join(harnessRoot, harness.main)).href);
  assert.equal(typeof adapter.normalizePiDaddyRecordLedgerV1, "function");

  const lines = raw.trimEnd().split("\n");
  const records = lines.map((line) => JSON.parse(line));
  const decisions = records.filter((record) => record.body.event === "capability_decision");
  assert.equal(decisions.length, 2, "check the actual first attempt and its automatic retry");
  assert.notEqual(decisions[0].body.executionId, decisions[1].body.executionId);
  const native = adapter.normalizePiDaddyRecordLedgerV1(raw);
  assert.equal(native.length, records.length, "the released reader must retain every native record");
  for (const decision of decisions) {
    assert.ok(native.some((event: { execution_id?: string }) => event.execution_id === decision.body.executionId));
  }
  // Native record-v1 is its own protocol. Harness's raw-body ledger-v3 selector intentionally pins an older
  // historical producer; stripping a modern envelope does not convert its body into that historical protocol.
  assert.ok(native.every((event: { source: string }) => event.source === "pi-daddy-record-v1"));

  const historical = join(oldDaddyRoot, "contracts", "ledger-record", "v1", "fixtures", "ledger-record.jsonl");
  const oldRaw = await readFile(historical, "utf8");
  assert.ok(adapter.normalizePiDaddyRecordLedgerV1(oldRaw).length > 0, "released writer remains supported");
  assert.equal((await verifyLedger(historical)).ok, true, "current reader retains released writer compatibility");

  // Corrupt the last body but rebuild the envelope digest: rejection must be about the contract, not bad hashing.
  const damaged = structuredClone(records.at(-1));
  damaged.body.unrecognizedRetryField = true;
  damaged.digest = recordDigest(damaged);
  const invalid = [...lines.slice(0, -1), JSON.stringify(damaged)].join("\n") + "\n";
  assert.throws(() => adapter.normalizePiDaddyRecordLedgerV1(invalid), /governance body/);
  if (process.env.DADDY_TEST_RELEASED_HARNESS_RECEIPT) {
    await writeFile(
      process.env.DADDY_TEST_RELEASED_HARNESS_RECEIPT,
      JSON.stringify({ status: "passed", reader: HARNESS_VERSION, historicalWriter: DADDY_VERSION, attempts: 2 }) +
        "\n",
    );
  }
}
