import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { grantsCommand } from "../extensions/grants-command.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { inspectSessionWorkspace, workspaceDiagnosticSnapshot } from "../extensions/workspace-diagnostics.ts";
import { inspectWorkspaceRouting } from "../src/kernel/workspace-diagnostics.ts";
import { destinationDigest } from "../src/kernel/workspace-pin.ts";
import { acceptWorkspaces, inspectAcceptedWorkspaces } from "../src/governance/workspace-acceptance.ts";
import { acceptedWorkspacesPath } from "../src/kernel/project-paths.ts";
import { validDashboardSourceUpdate } from "../src/kernel/dashboard-observation.ts";
import { GRANT_ENV_KEYS } from "../src/kernel/propagation.ts";
import type { Capability } from "../src/kernel/resolve.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);

// Removing dispatch's resolver from inspection breaks the moved-root, invalid-worktree and alias controls.
// Letting inspection reconcile acceptance or re-mint a pin breaks the no-write/pending controls.
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const keys = [...GRANT_ENV_KEYS, "PI_CODING_AGENT_DIR"],
    env = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    await run(await setup());
  } finally {
    for (const [k, v] of env) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}
async function setup() {
  const root = await tempDir("workspace-diagnostic-"),
    other = await tempDir("workspace-diagnostic-other-");
  for (const cwd of [root, other]) execFileSync("git", ["init", "-q"], { cwd });
  const registryPath = join(root, "registry.json"),
    registry = { version: 1 as const, workspaces: { known: { path: root } } };
  await writeFile(registryPath, JSON.stringify(registry));
  process.env.PI_CODING_AGENT_DIR = await tempDir("workspace-diagnostic-agent-");
  process.env.PI_DADDY_WORKSPACE_REGISTRY = registryPath;
  const pins = new Map([["known", destinationDigest(await realpath(root))]]);
  const input = {
    workspaceId: "known",
    registry,
    accepted: true,
    ownGrant: ["workspace:known"] as Capability[],
    pins,
    depth: 0,
  };
  return { root, other, registryPath, registry, pins, input };
}
test("known and active routing reuse the real worktree resolver without claiming dispatch readiness", async () =>
  fixture(async ({ input, pins }) => {
    const before = [...pins],
      value = await inspectWorkspaceRouting(input);
    assert.equal(value.state, "active");
    assert.equal(value.accepted, true);
    assert.equal(value.pin, "matching");
    assert.match(value.dispatchChecks, /candidate.*approvals.*lease.*settlement.*dispatch/);
    assert.deepEqual([...pins], before);
  }));
test("accepted-but-unpinned root is pending activation and inspection cannot repin", async () =>
  fixture(async ({ input }) => {
    const pins = new Map<string, string>(),
      value = await inspectWorkspaceRouting({ ...input, pins });
    assert.equal(value.state, "pending-activation");
    assert.equal(pins.size, 0);
    assert.match(value.recovery, /reload keeps the old pin/);
    assert.equal((await inspectWorkspaceRouting({ ...input, pins, depth: 1 })).state, "not-pinned");
  }));
test("current missing or revoked capability stays separate from persistent acceptance", async () =>
  fixture(async ({ input }) => {
    const value = await inspectWorkspaceRouting({ ...input, ownGrant: [] });
    assert.equal(value.state, "not-granted");
    assert.equal(value.accepted, true);
    assert.equal(value.pin, "matching");
    assert.match(value.recovery, /never granted or revoked/);
  }));
test("a moved accepted destination and a removed registry entry are distinct", async () =>
  fixture(async ({ input, other }) => {
    const moved = await inspectWorkspaceRouting({
      ...input,
      registry: { version: 1, workspaces: { known: { path: other } } },
    });
    assert.equal(moved.state, "destination-changed");
    assert.equal(moved.pin, "moved");
    assert.match(moved.recovery, /reload cannot repin/);
    const removed = await inspectWorkspaceRouting({ ...input, registry: { version: 1, workspaces: {} } });
    assert.equal(removed.state, "not-registered");
    assert.match(removed.reason, /entry has been removed/);
  }));
test("an alias of the pinned worktree matches; a directory inside it is not a valid registered root", async () =>
  fixture(async ({ input, root, other }) => {
    const alias = join(other, "alias");
    await symlink(root, alias, "dir");
    assert.equal(
      (await inspectWorkspaceRouting({ ...input, registry: { version: 1, workspaces: { known: { path: alias } } } }))
        .state,
      "active",
    );
    const invalid = await inspectWorkspaceRouting({
      ...input,
      registry: { version: 1, workspaces: { known: { path: join(root, ".git") } } },
    });
    assert.equal(invalid.state, "unavailable");
    assert.match(invalid.recovery, /exact worktree root/);
  }));
test("read-only inspection never creates absent acceptance and respects malformed state", async () =>
  fixture(async ({ registryPath }) => {
    assert.deepEqual(await inspectAcceptedWorkspaces(registryPath), { state: "absent", accepted: [] });
    await assert.rejects(readFile(acceptedWorkspacesPath(registryPath)), { code: "ENOENT" });
    await acceptWorkspaces(registryPath, ["known"]);
    await writeFile(acceptedWorkspacesPath(registryPath), "broken");
    assert.deepEqual(await inspectAcceptedWorkspaces(registryPath), { state: "invalid", accepted: [] });
    assert.equal(await readFile(acceptedWorkspacesPath(registryPath), "utf8"), "broken");
  }));
test("owner inspection reports fresh acceptance, caches bounded timestamps and never reads during redraw", async () =>
  fixture(async ({ registryPath, pins, root }) => {
    const session = createGrantsSession(undefined);
    session.ownerBound = true;
    session.cwd = root;
    session.storeCwd = root;
    session.grantSource = "stored";
    session.workspacePin = pins;
    session.ownGrant = ["workspace:known"];
    await acceptWorkspaces(registryPath, ["known"]);
    const before = await readFile(acceptedWorkspacesPath(registryPath), "utf8");
    const value = await inspectSessionWorkspace(session, "known");
    assert.match(value, /known: active/);
    assert.match(value, /Grant source: stored/);
    const snapshot = workspaceDiagnosticSnapshot(session)!;
    assert.ok(validDashboardSourceUpdate({ sequence: snapshot.sequence, items: snapshot.items }));
    await writeFile(registryPath, "invalid registry after observation");
    assert.deepEqual(
      workspaceDiagnosticSnapshot(session),
      snapshot,
      "redraw returns exact last observation without registry rescan",
    );
    assert.equal(await readFile(acceptedWorkspacesPath(registryPath), "utf8"), before);
    session.ownGrant = [];
    assert.equal(workspaceDiagnosticSnapshot(session), undefined, "a known grant change invalidates the cached view");
  }));
test("fresh acceptance can be known while the current owner still awaits activation", async () =>
  fixture(async ({ registryPath, root }) => {
    const session = createGrantsSession(undefined);
    session.ownerBound = true;
    session.cwd = root;
    session.storeCwd = root;
    session.workspacePin = new Map();
    session.ownGrant = ["workspace:known"];
    session.workspaceAcceptance = { accepted: [], firstUse: false, unaccepted: ["known"] };
    await acceptWorkspaces(registryPath, ["known"]);
    assert.match(await inspectSessionWorkspace(session, "known"), /pending-activation/);
    assert.equal(session.workspacePin.size, 0);
    assert.deepEqual(session.workspaceAcceptance.accepted, []);
  }));
test("registered read-only command works without definition discovery or acceptance mutation", async () =>
  fixture(async ({ root, pins }) => {
    const session = createGrantsSession(undefined);
    session.ownerBound = true;
    session.cwd = root;
    session.storeCwd = root;
    session.ownGrant = ["workspace:known"];
    session.workspacePin = pins;
    session.ensureDefinitions = async () => {
      throw Error("inspection must not load definitions");
    };
    let command: typeof grantsCommand | undefined,
      text = "";
    grantsExtension(
      {
        on() {},
        registerTool() {},
        registerCommand(name: string, value: typeof grantsCommand) {
          if (name === "grants") command = value;
        },
      } as never,
      session,
    );
    await command!.handler("workspace known", {
      ui: {
        notify(value: string) {
          text = value;
        },
      },
    });
    assert.match(text, /known: active/);
    await command!.handler("workspace known extra", {
      ui: {
        notify(value: string) {
          text = value;
        },
      },
    });
    assert.match(text, /read-only routing inspection/);
  }));
test("acceptance notification explicitly separates next-root activation from reload", async () => {
  let text = "";
  await grantsCommand.handler("workspaces", {
    grants: { acceptWorkspaces: async () => ["known"] },
    ui: {
      notify(value: string) {
        text = value;
      },
    },
  });
  assert.match(text, /next root session/);
  assert.match(text, /unchanged.*reload/);
});

test("an in-flight inspection cannot publish after its owner or current grant changes", async () =>
  fixture(async ({ root, pins }) => {
    for (const change of ["owner", "grant"]) {
      const session = createGrantsSession(undefined);
      session.ownerBound = true;
      session.cwd = root;
      session.storeCwd = root;
      session.ownGrant = ["workspace:known"];
      session.workspacePin = pins;
      const pending = inspectSessionWorkspace(session, "known");
      if (change === "owner") session.reloadLifecycle = { root: {} };
      else session.ownGrant = [];
      await assert.rejects(pending, /owner or authority changed/);
      assert.equal(workspaceDiagnosticSnapshot(session), undefined);
    }
  }));
