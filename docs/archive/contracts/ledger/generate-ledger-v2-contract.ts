#!/usr/bin/env node
/**
 * Historical v2 artifact copier.
 *
 * v2 was frozen when 0.19.0 shipped. Production builders now emit v3, so regenerating v2 through them
 * would silently rewrite history. This command only copies the checked-in v2 fixtures to an optional
 * target; the schema and its enums are immutable.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, "..", "contracts", "ledger", "v2");
const fixtureDir = join(contractDir, "fixtures");
const fixtureNames = [
  "capability-decision.json",
  "workspace-lease.json",
  "child-lifecycle.json",
  "check-receipt.json",
] as const;

export function buildLedgerV2ContractFixtures(): Record<string, unknown> {
  return Object.fromEntries(
    fixtureNames.map((name) => [name, JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as unknown]),
  );
}

export async function writeLedgerV2ContractFixtures(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const name of fixtureNames) await writeFile(join(target, name), await readFile(join(fixtureDir, name)));
}

export async function generateLedgerV2Contract(targets: { fixtures?: string } = {}): Promise<void> {
  if (targets.fixtures) await writeLedgerV2ContractFixtures(targets.fixtures);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) await generateLedgerV2Contract();
