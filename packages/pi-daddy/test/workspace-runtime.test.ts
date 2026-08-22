import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { governedWorkspaceAccess, prepareDelegationWorkspace, releaseDelegationWorkspace } from "../extensions/workspace-runtime.ts";
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

/**
 * **R-152: the ledger records what happened, not what was intended.**
 *
 * `releaseDelegationWorkspace` discarded `markRetained`'s result and wrote the word `retained`
 * unconditionally — *"kept deliberately because a herdr writer tab would not close, so the pane may still be
 * live"*. Here the helper is already dead and the kernel lock already back, so the fact is `lost`, which is
 * the distinction R-103 added the release vocabulary for.
 *
 * **The production change that breaks this test** (rule 7): going back to
 * `(await lease.markRetained(reason), "retained")`, or dropping `markRetained`'s liveness check.
 */
test("a retained lease whose helper already died is ledgered `lost`, not `retained`", async () => {
  const root = await tempDir("workspace-runtime-retain-root-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const config = await tempDir("workspace-runtime-retain-config-");
  const leaseDir = join(config, "leases");
  const ledgerPath = join(config, "ledger.jsonl");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const lease = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "o" });

  const record = JSON.parse(await readFile(join(leaseDir, `${createHash("sha256").update(root, "utf8").digest("hex")}.json`), "utf8"));
  process.kill(record.pid, "SIGKILL");
  await Promise.race([lease.lost, new Promise((r) => setTimeout(r, 5_000))]);

  const outcome = await releaseDelegationWorkspace({
    prepared: { workspace, lease, correlation: {} },
    childId: "d0.1",
    ledgerPath,
    reason: "herdr-close-failed",
    retain: true,
  });

  assert.equal(outcome, "lost");
  const events = (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const release = events.at(-1);
  assert.equal(release.event, "workspace_lease");
  assert.equal(
    release.outcome,
    "lost",
    "the ledger claimed a deliberate retention for a lease whose helper was already gone — an operator " +
      "reading it would look for a live pane that does not exist (R-152)",
  );
});
