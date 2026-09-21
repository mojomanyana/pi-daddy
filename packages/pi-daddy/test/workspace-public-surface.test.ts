import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import * as routing from "../src/kernel/workspace.ts";
import * as lease from "../src/governance/workspace-lease.ts";
import * as subpath from "../src/governance/workspace-public.ts";

// ADR-0076 PR 2 split routing (kernel) from the governed-writer lease (governance). The `pi-daddy/workspace`
// subpath must still expose both, exactly as `src/kernel/workspace.ts` did before the split. The review of that PR
// found one of the seven lease names silently dropped; this test forces all of them. Production change that
// breaks it: removing a name from workspace-public.ts, or repointing the export map away from it.
const LEASE_NAMES = [
  "ENV_WORKSPACE_LEASE_DIR",
  "acquireWorkspaceLease",
  "defaultWorkspaceLeaseDir",
  "leaseAcquisitionOutcome",
  "leaseReleaseLedgerOutcome",
];

test("pi-daddy/workspace exposes every routing export and the lease surface it had before the split", async () => {
  const exported = new Set(Object.keys(subpath));
  for (const name of Object.keys(routing))
    assert.ok(exported.has(name), `routing export missing from subpath: ${name}`);
  for (const name of LEASE_NAMES) {
    assert.ok(name in lease, `lease module lost ${name}`);
    assert.ok(exported.has(name), `lease export missing from subpath: ${name}`);
  }
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.exports["./workspace"], {
    types: "./dist/governance/workspace-public.d.ts",
    default: "./dist/governance/workspace-public.js",
  });
});
