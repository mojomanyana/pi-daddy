/** Regression: activity session setup failed before any helper existed, but retained capacity and a real writer lock. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test, { after } from "node:test";
import { createCapacityAllocator } from "../src/kernel/capacity.ts";
import { planDelegation } from "../src/kernel/delegate.ts";
import { acquireWorkspaceLease } from "../src/governance/workspace-lease.ts";
import { validateRegisteredWorkspace } from "../src/kernel/workspace.ts";
import { executePlannedChild } from "../extensions/execute-child.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);

test("actual mkdtemp failure releases the prepared writer and refunds proven-not-started capacity", async () => {
  const root = await tempDir("pi-prelaunch-refund-");
  execFileSync("git", ["init", "-q", root]);
  const workspace = await validateRegisteredWorkspace({ workspaceId: "fixture", registeredRoot: root });
  const leaseRoot = join(root, "leases");
  const prior = { TMPDIR: process.env.TMPDIR, PI_DADDY_WORKSPACE_LEASE_DIR: process.env.PI_DADDY_WORKSPACE_LEASE_DIR };
  process.env.PI_DADDY_WORKSPACE_LEASE_DIR = leaseRoot;
  const lease = await acquireWorkspaceLease({ workspace, access: "write", leaseDir: leaseRoot, ownerId: "first" });
  const owner = createCapacityAllocator(1);
  const reserved = owner.reserve("prelaunch", 0);
  assert.equal(reserved.ok, true);
  const plan = planDelegation({ task: "cannot start", tools: [] }, { ownGrant: [], depth: 0, maxDepth: 2, gated: [] });
  let handoffDisposed = false;
  plan.disposeHandoff = () => {
    handoffDisposed = true;
  };
  process.env.TMPDIR = join(root, "does-not-exist");
  try {
    await assert.rejects(
      executePlannedChild({
        session: { executor: { kind: "process" } } as never,
        plan,
        executionId: "prelaunch",
        parentExecutionId: null,
        childId: "first",
        cwd: root,
        capacityReservation: reserved.reservation,
        preparedWorkspace: { workspace, lease, correlation: { workspace_id: "fixture" } },
      }),
      /ENOENT|mkdtemp/,
    );
    assert.equal(reserved.reservation.state, "released");
    assert.equal(owner.available, 1);
    assert.equal(handoffDisposed, true);
    prior.TMPDIR === undefined ? delete process.env.TMPDIR : (process.env.TMPDIR = prior.TMPDIR);
    const next = await acquireWorkspaceLease({ workspace, access: "write", leaseDir: leaseRoot, ownerId: "successor" });
    await next.release();
  } finally {
    await lease.release();
    for (const [key, value] of Object.entries(prior))
      value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
});
