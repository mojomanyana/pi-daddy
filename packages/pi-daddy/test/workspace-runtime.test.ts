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
  // A write tool still forces a writer lease when it arrives ALONGSIDE non-tool ids — the filter below must
  // not become a way to hide one.
  assert.equal(governedWorkspaceAccess("read", ["workspace:staging", "tool:write"]), "write");
  assert.equal(governedWorkspaceAccess("read", ["agent:builder", "tool:bash"]), "write");
});

/**
 * A capability that cannot write must not force a writer lease.
 *
 * **This regressed the moment `workspace:<id>` became grantable to a child** (ADR-0035's review). The check
 * required *every* requested capability to be a known read-only tool, which was true while only `tool:` and
 * `ext:` could appear. Measured before the fix: `("read", ["tool:read","workspace:staging"])` → `"write"`, so
 * the intended shape — route this child read-only, let it route its own grandchild — took an **exclusive**
 * writer lease on the root, blocked every other writer, and recorded `access: "write"` in the ledger when the
 * operator asked for `read`.
 *
 * **`tool:delegate` is NOT in the read-only set**, and its absence is deliberate — see
 * `KNOWN_READ_ONLY_TOOLS`. Adding it was true of the capability and false of the code, because a routed
 * child's cwd is the leased root and its inherited `PI_GRANTS_LEDGER` was relative. So "route read-only and
 * delegate onward" still takes a writer lease, exactly as it did in 0.18.1; R-141 tracks the plumbing change
 * that would make it a reader.
 *
 * Breaks by: removing the `tool:`/`ext:` filter in `governedWorkspaceAccess`.
 */
test("a non-tool capability does not force an exclusive writer lease", () => {
  // The exact shape the review measured as broken.
  assert.equal(governedWorkspaceAccess("read", ["tool:read", "workspace:staging"]), "read");
  // A delegating child still classifies WRITE — unchanged from 0.18.1, and R-141 is why.
  assert.equal(governedWorkspaceAccess("read", ["tool:read", "tool:delegate", "workspace:staging"]), "write");
  // Every non-tool namespace: none of them can change a file.
  for (const capability of ["workspace:prod", "agent:builder", "skill:review"]) {
    assert.equal(governedWorkspaceAccess("read", ["tool:read", capability]), "read", capability);
  }
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
