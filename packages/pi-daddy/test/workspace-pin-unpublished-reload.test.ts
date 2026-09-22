import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { beginExtensionLifecycle, bindReloadLifecycle } from "../extensions/reload-environment.ts";
import { createGrantsSession, loadProjectDefinitions } from "../extensions/session.ts";
import { GRANT_ENV_KEYS } from "../src/kernel/propagation.ts";
import { destinationDigest } from "../src/kernel/workspace-pin.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);

/**
 * A reload before anything has published must not re-mint the destination pin (ADR-0042).
 *
 * **Its own file because the state it turns on is process-global.** `latestChildPublication` lives on a
 * `globalThis` symbol, so any other test in the same file that publishes would set it and this case would
 * stop being exercised — passing for a reason that has nothing to do with what it checks.
 *
 * The defect: `bindReloadLifecycle` deletes a settled pin whenever the current environment does not match the
 * last child publication, and its comment called that "an explicit change to this owner's root". True of the
 * second disjunct, false of the first — which fires when NOTHING has published yet, where nothing has been
 * replaced at all. A root that settled and reloaded before publishing therefore minted again, over a registry
 * a child had had time to rewrite. Low severity, because `session_start` reaches its publication in normal
 * flow, but that is an unstated invariant nobody was forcing, which is the shape this feature has produced
 * five times now.
 *
 * **The production change that breaks this:** deleting the pin unconditionally in that branch again.
 */
test("a reload before any publication keeps the settled pin", async () => {
  const staging = await tempDir("pin-unpublished-");
  const prod = await tempDir("pin-unpublished-prod-");
  for (const dir of [staging, prod]) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    await writeFile(join(dir, "README.md"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  }
  const registryPath = join(staging, "registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, workspaces: { staging: { path: staging } } }));

  const keys = [...GRANT_ENV_KEYS, "PI_DADDY_WORKSPACE_REGISTRY", "PI_CODING_AGENT_DIR"] as const;
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    process.env.PI_DADDY_WORKSPACE_REGISTRY = registryPath;
    process.env.PI_CODING_AGENT_DIR = await tempDir("pin-unpublished-agent-");
    process.env.PI_DADDY_GRANT = "tool:write,workspace:staging";

    const owner = {};
    const reload = () => {
      const bound = bindReloadLifecycle(owner, beginExtensionLifecycle().lifecycle);
      const session = createGrantsSession(undefined, bound.lifecycle);
      session.reconcileEnvironment(bound.environment, bound.lifecycle);
      return session;
    };

    const first = reload();
    await loadProjectDefinitions(first, staging);
    // Asserted so a leaked `PI_DADDY_DEPTH` cannot make this pass for the descendant reason instead.
    assert.equal(first.depth, 0, "this must exercise a ROOT, or it proves nothing about minting");
    const minted = first.workspacePin?.get("staging");
    assert.equal(minted, destinationDigest(await realpath(staging)));

    // No publication in between — the whole point. Then the tamper a child performs with `tool:write`.
    await writeFile(registryPath, JSON.stringify({ version: 1, workspaces: { staging: { path: prod } } }));
    const second = reload();
    await loadProjectDefinitions(second, staging);
    assert.equal(second.depth, 0);
    assert.equal(second.workspacePin?.get("staging"), minted, "an unpublished reload must not re-mint");
    assert.notEqual(second.workspacePin?.get("staging"), destinationDigest(await realpath(prod)));
  } finally {
    for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});
