import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { governedWorkspaceAccess, prepareDelegationWorkspace } from "../extensions/workspace-runtime.ts";
import {
  acquireWorkspaceLease,
  ENV_WORKSPACE_LEASE_DIR,
  ENV_WORKSPACE_REGISTRY,
  validateRegisteredWorkspace,
} from "../src/workspace.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("a model cannot label a write-capable grant read-only", () => {
  assert.equal(governedWorkspaceAccess("read", ["tool:read"]), "read");
  for (const capability of ["tool:write", "tool:edit", "tool:bash", "ext:custom"]) {
    assert.equal(governedWorkspaceAccess("read", [capability]), "write");
  }
  assert.equal(governedWorkspaceAccess("write", ["tool:read"]), "write");
});

test("a ledger failure after lease acquisition releases the writer lock", async () => {
  const root = await tempDir("workspace-runtime-root-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const config = await tempDir("workspace-runtime-config-");
  const registry = join(config, "registry.json");
  const leaseDir = join(config, "leases");
  const ledgerDirectory = await tempDir("workspace-runtime-bad-ledger-");
  await writeFile(registry, JSON.stringify({ version: 1, workspaces: { w1: { path: root } } }));
  const oldRegistry = process.env[ENV_WORKSPACE_REGISTRY];
  const oldLeaseDir = process.env[ENV_WORKSPACE_LEASE_DIR];
  process.env[ENV_WORKSPACE_REGISTRY] = registry;
  process.env[ENV_WORKSPACE_LEASE_DIR] = leaseDir;
  try {
    await assert.rejects(
      () => prepareDelegationWorkspace({
        spec: { workspace_id: "w1", access: "write" }, childId: "d0.1", ledgerPath: ledgerDirectory,
      }),
      /grant ledger write failed/,
    );
    const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
    const next = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "next" });
    await next.release("test-complete");
  } finally {
    if (oldRegistry === undefined) delete process.env[ENV_WORKSPACE_REGISTRY];
    else process.env[ENV_WORKSPACE_REGISTRY] = oldRegistry;
    if (oldLeaseDir === undefined) delete process.env[ENV_WORKSPACE_LEASE_DIR];
    else process.env[ENV_WORKSPACE_LEASE_DIR] = oldLeaseDir;
  }
});
