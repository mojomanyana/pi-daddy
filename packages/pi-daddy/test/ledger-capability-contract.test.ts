import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { after, test } from "node:test";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { CAPABILITY_NAMESPACE_PREFIXES } from "../src/kernel/capabilities.ts";
import { isLedgerCapabilityIdentifier } from "../src/kernel/ledger-identifiers.ts";
import { buildLedgerV3ContractFixtures, syncLedgerV3RefusalEnum } from "../scripts/generate-ledger-record-contract.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
const schemaUrl = new URL("../contracts/ledger-record/v1/governance-event.schema.json", import.meta.url);

test("published capability grammar matches runtime namespaces and tail bounds", async () => {
  const validator = Compile(JSON.parse(await readFile(schemaUrl, "utf8")));
  const fixture = buildLedgerV3ContractFixtures()["capability-decision.json"];
  assert.ok(fixture.parentGrant.includes("context:files"));
  assert.ok(fixture.parentGrant.includes("context:summary"));
  for (const prefix of [...CAPABILITY_NAMESPACE_PREFIXES, "unknown:", "Context:"]) {
    for (const tail of [
      "files",
      "summary",
      "*",
      "a".repeat(256),
      "",
      "a".repeat(257),
      "bad:tail",
      "bad tail",
      "-bad",
      "bad\n",
    ]) {
      const capability = prefix + tail;
      assert.equal(
        validator.Check({ ...fixture, parentGrant: [capability] }),
        isLedgerCapabilityIdentifier(capability),
        JSON.stringify(capability),
      );
    }
  }
});

test("contract generation repairs stale capability namespaces without widening unknown ids", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  schema.$defs.ledgerCapabilityIdentifier.pattern = "^tool:.*$";
  const path = join(await tempDir("capability-contract-"), "schema.json");
  await writeFile(path, JSON.stringify(schema));
  await syncLedgerV3RefusalEnum(path);
  const repaired = Compile(JSON.parse(await readFile(path, "utf8")));
  const fixture = buildLedgerV3ContractFixtures()["capability-decision.json"];
  assert.equal(repaired.Check(fixture), true);
  assert.equal(repaired.Check({ ...fixture, parentGrant: ["unknown:files"] }), false);
});
