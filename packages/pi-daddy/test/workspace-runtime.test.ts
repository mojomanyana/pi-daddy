import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { after, test } from "node:test";
import { governedWorkspaceAccess, prepareDelegationWorkspace } from "../extensions/workspace-runtime.ts";
import { planDelegation } from "../src/delegate.ts";
import { childEnv } from "../src/propagation.ts";
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
 * A `read`-leased child must not WRITE into the root it was given, and the ledger path is how it did.
 *
 * This is why `tool:delegate` can sit in `KNOWN_READ_ONLY_TOOLS` at all. Review measured the composition: a
 * routed child's cwd IS the leased root; `ENV_LEDGER` was passed verbatim and `pi-daddy init` scaffolds a
 * RELATIVE `.pi/grants.jsonl`; and a `read` lease takes no kernel lock. So two delegating children classified
 * `read` both created `.pi/` inside one worktree and neither excluded the other — `git status` showed `?? .pi/`
 * and a grandchild took a WRITE lease on a root already held. Classifying `tool:delegate` as non-writing was
 * true of the capability and false of the code.
 *
 * Fixed at the cause: the child's ledger path is resolved absolute, so the write lands where the parent's
 * ledger already is — which also repairs a pre-existing audit split, since a routed subtree's records used to
 * go to a different file that `/grants ledger` never read.
 *
 * Breaks by: reverting either `ENV_LEDGER` assignment to pass `ledgerPath` through unresolved.
 */
test("a delegated child's ledger path is absolute, so it cannot write into the workspace it was given", () => {
  const plan = planDelegation(
    { task: "t", tools: ["read", "delegate"] },
    { ownGrant: ["tool:read", "tool:delegate"], depth: 0, maxDepth: 3, gated: [], approved: [],
      ledgerPath: ".pi/grants.jsonl" } as never,
  );
  assert.equal(plan.ok, true, plan.reason ?? "");
  assert.equal(
    isAbsolute(plan.env.PI_GRANTS_LEDGER ?? ""),
    true,
    `a relative ledger path resolves inside the child's cwd — which for a routed child is the leased root: ${plan.env.PI_GRANTS_LEDGER}`,
  );
  assert.equal(plan.env.PI_GRANTS_LEDGER, resolvePath(".pi/grants.jsonl"));

  // The interceptor path carries the same rule.
  const published = childEnv({
    ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: [], approved: [], ledgerPath: ".pi/grants.jsonl",
  } as never);
  assert.equal(isAbsolute(published.PI_GRANTS_LEDGER ?? ""), true);

  // An absolute path an operator wrote is untouched.
  const explicit = planDelegation(
    { task: "t", tools: ["read"] },
    { ownGrant: ["tool:read"], depth: 0, maxDepth: 3, gated: [], approved: [],
      ledgerPath: "/var/log/grants.jsonl" } as never,
  );
  assert.equal(explicit.env.PI_GRANTS_LEDGER, "/var/log/grants.jsonl");
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
 * `tool:delegate` belongs in the read-only set for a reason worth stating: a delegated child's `--tools` comes
 * from a grant this package narrowed from the parent's own, so delegating cannot reach a write primitive the
 * delegator did not hold — and if it held one, that capability is in `requested` and fails on its own account.
 *
 * Breaks by: removing the `tool:`/`ext:` filter in `governedWorkspaceAccess`, or dropping `tool:delegate`
 * from `KNOWN_READ_ONLY_TOOLS`.
 */
test("routing and delegation authority do not force an exclusive writer lease", () => {
  // The exact shape the review measured as broken.
  assert.equal(governedWorkspaceAccess("read", ["tool:read", "workspace:staging"]), "read");
  // And the full intended configuration: read the tree, route a grandchild onward.
  assert.equal(
    governedWorkspaceAccess("read", ["tool:read", "tool:delegate", "workspace:staging"]),
    "read",
    "a read-routed child that may delegate is still a reader",
  );
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
