#!/usr/bin/env node
/**
 * Probe g37 — routing attenuates by ID, not by DESTINATION (R-137).
 *
 * ADR-0035 made routing a capability, so a descendant may only name workspace ids it holds. It left the
 * id -> path mapping in a mutable file. This measures whether a child holding `workspace:staging` and a WRITE
 * TOOL — not `bash`, so inside ADR-0012's scope — can repoint that entry at another worktree and route its
 * grandchild there.
 *
 * Real Git worktrees, a real kernel `flock`, the real production path (`planDelegation` -> `mergeChildEnv` ->
 * `loadWorkspaceRegistry` -> `resolveWorkspace` -> `acquireWorkspaceLease`). No model, no spawned `pi`, so it
 * re-runs free. Run from the repository root:
 *
 *   node docs/probes/g37-registry-tamper/probe.mjs
 */
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const pkg = new URL("../../../packages/pi-daddy/src/", import.meta.url).pathname;
const { planDelegation } = await import(join(pkg, "delegate.ts"));
const { childEnv, mergeChildEnv } = await import(join(pkg, "propagation.ts"));
const { loadWorkspaceRegistry, resolveWorkspace, acquireWorkspaceLease, validateRegisteredWorkspace } =
  await import(join(pkg, "workspace.ts"));

const base = await mkdtemp(join(tmpdir(), "g37-"));
const worktree = async (name) => {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "p@x"], { cwd: dir });
  await run("git", ["config", "user.name", "p"], { cwd: dir });
  await writeFile(join(dir, "MARKER"), name, "utf8");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-qm", name], { cwd: dir });
  return dir;
};

const staging = await worktree("staging");
const prod = await worktree("prod");
const registry = join(base, "registry.json");
const leaseDir = join(base, "leases");
const honest = { version: 1, workspaces: { staging: { path: staging }, prod: { path: prod } } };
await writeFile(registry, JSON.stringify(honest), "utf8");

const findings = {};

// A root grants a child `workspace:staging` and a write tool. The child holds nothing naming `prod`.
process.env.PI_GRANTS_WORKSPACE_REGISTRY = registry;
process.env.PI_GRANTS_WORKSPACE_LEASE_DIR = leaseDir;
const rootPlan = planDelegation(
  { task: "t", tools: ["read", "write", "delegate", "workspace:staging"], boundWorkspaceId: "staging" },
  { ownGrant: ["tool:read", "tool:write", "tool:delegate", "workspace:staging", "workspace:prod"],
    depth: 0, maxDepth: 3, gated: [], approved: [] },
);
findings.child_grant = rootPlan.env.PI_GRANTS_GRANT;
findings.child_holds_prod = (rootPlan.env.PI_GRANTS_GRANT ?? "").includes("workspace:prod");

// CONTROL: the child cannot route its grandchild to `prod` by NAME. This is ADR-0035 working.
const childCtx = {
  ownGrant: (rootPlan.env.PI_GRANTS_GRANT ?? "").split(",").filter(Boolean),
  depth: 1, maxDepth: 3, gated: [], approved: [],
};
const byName = planDelegation({ task: "t", tools: ["read"], boundWorkspaceId: "prod" }, childCtx);
findings.control_route_to_prod_by_name = byName.refusal?.code ?? null;

// THE ATTACK: the child has `tool:write`. It rewrites the entry it legitimately holds.
await writeFile(registry, JSON.stringify({
  version: 1, workspaces: { staging: { path: prod }, prod: { path: prod } },
}), "utf8");

const tampered = planDelegation({ task: "t", tools: ["read"], boundWorkspaceId: "staging" }, childCtx);
findings.route_to_staging_after_tamper = tampered.refusal?.code ?? "NO REFUSAL";

const reg = await loadWorkspaceRegistry(registry);
const resolved = await resolveWorkspace(reg, "staging");
findings.staging_now_resolves_to = resolved.root === prod ? "the prod worktree" : resolved.root;
findings.grandchild_cwd_marker = (await readFile(join(resolved.root, "MARKER"), "utf8")).trim();

const validated = await validateRegisteredWorkspace({ workspaceId: "staging", registeredRoot: resolved.root });
const lease = await acquireWorkspaceLease({ workspace: validated, access: "write", leaseDir, ownerId: "grandchild" });
findings.grandchild_write_lease = lease.access;
await lease.release("probe-complete");

findings.conclusion = findings.route_to_staging_after_tamper === "NO REFUSAL"
  && findings.grandchild_cwd_marker === "prod"
  ? "CONFIRMED: routing attenuates by ID and not by DESTINATION. A child holding only `workspace:staging` "
    + "and `tool:write` repointed that id at the prod worktree and took an exclusive write lease there. The "
    + "control shows the same child refused when it named `prod` directly, so the capability check works and "
    + "the thing it names is what moved."
  : "NOT REPRODUCED — re-derive before trusting this entry";

console.log(JSON.stringify({ probe: "g37-registry-tamper", platform: process.platform, findings }, null, 2));
