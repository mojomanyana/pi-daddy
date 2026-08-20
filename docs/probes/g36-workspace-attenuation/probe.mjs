#!/usr/bin/env node
/**
 * G36 — does workspace routing attenuate? (R-131, the blocking input for ADR-0035)
 *
 * ADR-0035 was left Proposed because its escalation was derived from reading three files rather than
 * measured. R-26 — the same defect one namespace over — was found by a three-level transitivity test, not
 * by a code-read, so this decision should have the same class of evidence before acceptance.
 *
 * What this drives: the REAL production propagation path (`planDelegation` → `mergeChildEnv` →
 * `loadWorkspaceRegistry` → `resolveWorkspace` → `acquireWorkspaceLease`) against REAL Git worktrees and a
 * real kernel `flock`. No model, no pi process — the escalation is a property of propagation and
 * authorisation, and both are library code that can be driven directly.
 *
 * The control matters as much as the finding: it measures a dimension that DOES attenuate (the grant, and
 * depth) through the exact same child environment. Without that, "the registry inherits" is a fact about
 * one variable rather than evidence of an asymmetry.
 *
 * Run from the repository root:
 *   node docs/probes/g36-workspace-attenuation/probe.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PKG = new URL("../../../packages/pi-daddy/src/", import.meta.url);
const load = (m) => import(pathToFileURL(new URL(m, PKG).pathname).href);

const { planDelegation } = await load("delegate.ts");
const { mergeChildEnv, GRANT_ENV_KEYS, ENV_GRANT, ENV_DEPTH } = await load("propagation.ts");
const {
  ENV_WORKSPACE_REGISTRY,
  loadWorkspaceRegistry,
  resolveWorkspace,
  acquireWorkspaceLease,
} = await load("workspace.ts");

function worktree(root, name) {
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "user.email", "probe@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Probe"], { cwd: root });
  execFileSync("sh", ["-c", `printf '%s\\n' ${name} > MARKER`], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", `base ${name}`], { cwd: root });
  return root;
}

const dir = await mkdtemp(join(tmpdir(), "g36-workspace-attenuation-"));
const findings = {};
const leases = [];
try {
  const staging = worktree(join(dir, "staging"), "staging");
  const prod = worktree(join(dir, "prod"), "prod");
  const registryPath = join(dir, "registry.json");
  const leaseDir = join(dir, "leases");
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    workspaces: { staging: { path: staging }, prod: { path: prod } },
  }));

  // ---------------------------------------------------------------- level 0: the root session
  // An operator who registered both workspaces, granted the root a write-capable tool plus the ability to
  // delegate, and routed its child to `staging`. Nothing here mentions `prod`.
  const rootEnv = { ...process.env, [ENV_WORKSPACE_REGISTRY]: registryPath };
  const rootGrant = ["tool:read", "tool:write", "tool:delegate"];

  const level1 = planDelegation(
    { task: "review the staging tree", tools: ["read", "write", "delegate"] },
    { ownGrant: rootGrant, depth: 0, maxDepth: 3, gated: [], spawnId: "d0", childSpawnId: "d0.1" },
  );
  findings.level1_planned = level1.ok;
  findings.level1_effective = level1.effective;

  // The REAL environment the child process would receive.
  const childEnv = mergeChildEnv(rootEnv, level1.env);

  // ---------------------------------------------------------------- the two measurements
  // (a) Does the registry survive into the child? `mergeChildEnv` deletes GRANT_ENV_KEYS and copies the
  //     rest, so this is exactly the membership question.
  findings.registry_in_grant_env_keys = GRANT_ENV_KEYS.includes(ENV_WORKSPACE_REGISTRY);
  findings.registry_inherited_by_child = childEnv[ENV_WORKSPACE_REGISTRY] === registryPath;

  // (b) CONTROL — dimensions that DO attenuate, measured through the same child env. If these were also
  //     unchanged the probe would show "everything inherits", which is a different (and lesser) claim.
  findings.control_depth_attenuated = childEnv[ENV_DEPTH] === "1" && rootEnv[ENV_DEPTH] === undefined;
  const narrowed = planDelegation(
    { task: "narrower", tools: ["read"] },
    { ownGrant: rootGrant, depth: 0, maxDepth: 3, gated: [], spawnId: "d0", childSpawnId: "d0.2" },
  );
  const narrowedChildEnv = mergeChildEnv(rootEnv, narrowed.env);
  findings.control_grant_attenuated =
    narrowedChildEnv[ENV_GRANT] === "tool:read" && !narrowedChildEnv[ENV_GRANT].includes("tool:write");

  // ---------------------------------------------------------------- level 1: the child escalates
  // Everything below uses ONLY what the child inherited. The child was routed to `staging` and was never
  // granted anything naming `prod`.
  const childRegistry = await loadWorkspaceRegistry(childEnv[ENV_WORKSPACE_REGISTRY]);
  findings.child_can_enumerate_workspaces = Object.keys(childRegistry.workspaces).sort();

  const grandchildPlan = planDelegation(
    { task: "escalate to prod", tools: ["read", "write"] },
    { ownGrant: level1.effective, depth: 1, maxDepth: 3, gated: [], spawnId: "d0.1", childSpawnId: "d0.1.1" },
  );
  findings.grandchild_planned = grandchildPlan.ok;
  // The question the ADR turns on: does anything in the plan refuse the workspace the caller never held?
  findings.grandchild_refusal_code = grandchildPlan.refusal?.code ?? null;

  let resolvedProd = null;
  let leaseTaken = null;
  try {
    resolvedProd = await resolveWorkspace(childRegistry, "prod");
    const lease = await acquireWorkspaceLease({
      workspace: resolvedProd, access: "write", leaseDir, ownerId: "grandchild-of-staging",
    });
    leases.push(lease);
    leaseTaken = lease.access;
  } catch (error) {
    leaseTaken = `refused:${error?.code ?? String(error)}`;
  }
  findings.grandchild_resolved_prod_root = resolvedProd?.root === prod;
  findings.grandchild_write_lease_on_prod = leaseTaken;

  // Would the grandchild actually START in prod? The CWD is the observable an operator would see.
  let observedCwd = null;
  if (resolvedProd) {
    observedCwd = execFileSync("sh", ["-c", "cat MARKER"], { cwd: resolvedProd.root, encoding: "utf8" }).trim();
  }
  findings.grandchild_cwd_marker = observedCwd;

  findings.conclusion =
    findings.registry_inherited_by_child
    && findings.grandchild_refusal_code === null
    && findings.grandchild_resolved_prod_root
    && findings.grandchild_write_lease_on_prod === "write"
    && findings.grandchild_cwd_marker === "prod"
    && findings.control_grant_attenuated
    && findings.control_depth_attenuated
      ? "CONFIRMED: routing does not attenuate — a child routed to staging took a write lease on prod and "
        + "would start there, while the grant and depth attenuated through the same child environment"
      : "NOT REPRODUCED on this build — read the findings above before trusting either reading";
} finally {
  for (const lease of leases) await lease.release("probe-complete").catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ node: process.version, platform: process.platform, findings }, null, 2)}\n`);
