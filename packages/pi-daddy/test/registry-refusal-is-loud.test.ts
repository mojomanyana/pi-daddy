import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCatalog, makeCatalog } from "../src/kernel/catalog.ts";
import { registeredWorkspaceIds } from "../src/kernel/workspace.ts";
import { grantsCommand } from "../extensions/grants-command.ts";

/**
 * A registry the reader refuses must not vanish without a word.
 *
 * Failing SOFT is deliberate and stays: a malformed registry must not stop a session starting, because
 * nothing in the catalog is an authority. Failing soft and SILENTLY was the defect — `buildCatalog` caught
 * with `() => []` and `registeredWorkspaceIds` with `catch { return [] }`, so one malformed entry removed
 * every workspace from `/grants`, from the catalog and from `pi-daddy init`, and produced no message
 * anywhere. An operator saw an empty list identical to the one a machine with no registry shows. That is
 * rule 8's silent safe-mode, which the rule says is as confusing as a silent unsafe one.
 *
 * **The production change that breaks these:** restoring either swallowing handler, or dropping the
 * `routable (none …)` line from `/grants`.
 */

function badRegistry(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-daddy-registry-"));
  const path = join(dir, "registry.json");
  writeFileSync(path, JSON.stringify({ version: 1, workspaces: { prod: { path: "not/absolute" } } }));
  return path;
}

test("buildCatalog still yields no workspaces, but now carries the reason", async () => {
  const path = badRegistry();
  try {
    const catalog = await buildCatalog({ cwd: process.cwd(), observedTools: null, registryPath: path });
    assert.deepEqual(catalog.byKind("workspace"), [], "failing soft is the point and must not change");
    assert.ok(catalog.registryRefusal, "the reason must survive the soft failure");
    assert.match(catalog.registryRefusal!, /absolute path/);
  } finally {
    rmSync(path, { force: true });
  }
});

test("a registry that reads cleanly leaves no refusal to report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-daddy-registry-ok-"));
  const path = join(dir, "registry.json");
  writeFileSync(path, JSON.stringify({ version: 1, workspaces: {} }));
  try {
    const catalog = await buildCatalog({ cwd: process.cwd(), observedTools: null, registryPath: path });
    assert.equal(catalog.registryRefusal, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registeredWorkspaceIds hands the reason to its caller instead of discarding it", async () => {
  const path = badRegistry();
  try {
    const reasons: string[] = [];
    assert.deepEqual(await registeredWorkspaceIds(path, (r) => reasons.push(r)), []);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /absolute path/);
    // A caller that passes nothing keeps the old behaviour rather than throwing.
    assert.deepEqual(await registeredWorkspaceIds(path), []);
  } finally {
    rmSync(path, { force: true });
  }
});

test("/grants prints why the routable line is empty", async () => {
  let out = "";
  const ctx = {
    ui: { notify: (text: string) => void (out = text) },
    grants: {
      cwd: process.cwd(),
      governed: true,
      ownGrant: ["tool:read"],
      executor: { disclosure: "in-process (test)" },
      advisor: { decider: "none" },
      observed: true,
      depth: 0,
      maxDepth: 2,
      catalog: makeCatalog([], "workspace registry /tmp/r.json is not valid JSON (SyntaxError)"),
      definitions: new Map(),
      sessionApprovals: new Set(),
      inheritedApprovals: new Map(),
      previewDelegation: async () => assert.fail("no definitions to preview"),
    },
  };
  await grantsCommand.handler("", ctx as never);
  assert.match(out, /routable {3}\(none — workspace registry unreadable\)/);
  assert.match(out, /is not valid JSON/);
});
