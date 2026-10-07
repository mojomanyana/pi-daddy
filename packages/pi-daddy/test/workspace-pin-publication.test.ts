import assert from "node:assert/strict";
import { access, open, readFile, realpath, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { createGrantsSession, loadProjectDefinitions } from "../extensions/session.ts";
import type { ReloadLifecycle } from "../extensions/reload-environment.ts";
import { acceptWorkspaces } from "../src/governance/workspace-acceptance.ts";
import { acceptedWorkspacesPath } from "../src/kernel/project-paths.ts";
import { loadWorkspaceRegistry } from "../src/kernel/workspace.ts";
import { BoundedReadCleanupError, readBoundedFile, retainedBoundedReadCleanups } from "../src/kernel/bounded-read.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

// An unreadable operator decision must reject discovery and reach the actual startup diagnostic.
for (const code of ["EIO", "EACCES"]) {
  test(`startup diagnoses ${code} acceptance failure without settling an empty pin`, async () => {
    const cwd = await tempDir("pin-acceptance-unreadable-");
    const savedAgent = process.env.PI_CODING_AGENT_DIR;
    const savedRegistry = process.env.PI_DADDY_WORKSPACE_REGISTRY;
    process.env.PI_CODING_AGENT_DIR = await tempDir("pin-acceptance-unreadable-agent-");
    const registry = join(cwd, "registry.json");
    await writeFile(registry, JSON.stringify({ version: 1, workspaces: { good: { path: cwd }, evil: { path: cwd } } }));
    process.env.PI_DADDY_WORKSPACE_REGISTRY = registry;
    await acceptWorkspaces(registry, ["good"]);
    const path = acceptedWorkspacesPath(registry);
    const before = await readFile(path);
    const failure = Object.assign(new Error(`${code}: cannot read acceptance decision`), { code });
    const owner: ReloadLifecycle = { root: { PI_DADDY_GRANT: "tool:read,tool:delegate", PI_DADDY_DEPTH: "0" } };
    let reads = 0;
    const session = createGrantsSession(undefined, owner, undefined, {
      acceptanceRead: async (name) => {
        assert.equal(name, path);
        reads++;
        throw failure;
      },
    });
    const hooks = new Map<string, Function>();
    const notices: { message: string; type: string }[] = [];
    grantsExtension(
      {
        on: (name: string, handler: Function) => hooks.set(name, handler),
        registerTool: () => {},
        registerCommand: () => {},
        getAllTools: () => [{ name: "read" }, { name: "delegate" }],
        getActiveTools: () => ["read"],
        setActiveTools: () => {},
      } as never,
      session,
    );
    try {
      await hooks.get("session_start")!(
        {},
        {
          cwd,
          mode: "json",
          sessionManager: {},
          ui: {
            notify: (message: string, type: string) => notices.push({ message, type }),
            select: async () => undefined,
          },
          modelRegistry: { find: () => undefined },
        },
      );
      const outcome = await loadProjectDefinitions(session, cwd).catch((error: unknown) => error);
      assert.equal(outcome, failure, "loader must preserve the acceptance error, not publish empty success");
      assert.ok(notices.some(({ message, type }) => type === "error" && message.includes(failure.message)));
      assert.ok(!notices.some(({ message }) => message.includes("registry unreadable")));
      await assert.rejects(loadProjectDefinitions(session, cwd), (error) => error === failure);
      assert.equal(reads, 1, "startup joins the original rejected pin acquisition");
      assert.equal(session.pinSettled, false);
      assert.equal(session.workspacePin, undefined);
      assert.equal(owner.workspacePin, undefined);
      assert.equal(session.workspaceAcceptance, undefined, "no successful acceptance or added evil");
      assert.deepEqual(session.workspaceSkips, []);
      assert.deepEqual(await readFile(path), before, "the accepted-good decision stays byte-identical");
      assert.deepEqual(Object.keys((await loadWorkspaceRegistry(registry)).workspaces), ["good", "evil"]);
    } finally {
      if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgent;
      if (savedRegistry === undefined) delete process.env.PI_DADDY_WORKSPACE_REGISTRY;
      else process.env.PI_DADDY_WORKSPACE_REGISTRY = savedRegistry;
    }
  });
}

// Physical acceptance cleanup belongs to the initiating owner, even after same-session replacement.
for (const replaced of [false, true]) {
  test(`acceptance descriptor failure remains terminal only on its initiating owner (replaced=${replaced})`, async () => {
    const cwd = await tempDir("pin-acceptance-cleanup-");
    const savedAgent = process.env.PI_CODING_AGENT_DIR;
    const savedRegistry = process.env.PI_DADDY_WORKSPACE_REGISTRY;
    process.env.PI_CODING_AGENT_DIR = await tempDir("pin-acceptance-cleanup-agent-");
    const registry = join(cwd, "registry.json");
    await writeFile(registry, JSON.stringify({ version: 1, workspaces: { good: { path: cwd }, evil: { path: cwd } } }));
    process.env.PI_DADDY_WORKSPACE_REGISTRY = registry;
    await acceptWorkspaces(registry, ["good"]);
    const path = acceptedWorkspacesPath(registry);
    const before = await readFile(path);
    const entered = gate();
    const release = gate();
    let held: FileHandle | undefined;
    let failure: BoundedReadCleanupError | undefined;
    let reads = 0;
    let closes = 0;
    // Even an ENOENT cause of cleanup is not an absent acceptance decision.
    const cause = Object.assign(new Error("close failed"), { code: "ENOENT" });
    const oldOwner: ReloadLifecycle = { root: { PI_DADDY_GRANT: "tool:read,tool:delegate", PI_DADDY_DEPTH: "0" } };
    const session = createGrantsSession(undefined, oldOwner, undefined, {
      acceptanceRead: async (name) => {
        if (++reads !== 1) return readFile(name, "utf8");
        try {
          const result = await readBoundedFile(
            name,
            { maxBytes: 1024 * 1024, timeoutMs: 1000 },
            {
              open: async (name, flags) => (held = await open(name, flags)),
              read: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
              close: async (handle) => {
                if (++closes === 1) {
                  entered.resolve();
                  await release.promise;
                  throw cause;
                }
                await handle.close();
              },
            },
          );
          assert.ok(result.ok);
          return result.text;
        } catch (error) {
          if (error instanceof BoundedReadCleanupError) failure = error;
          throw error;
        }
      },
    });
    session.cwd = cwd;
    session.reconcileEnvironment({ ...process.env, ...oldOwner.root }, oldOwner);
    const original = loadProjectDefinitions(session, cwd);
    const outcome = original.catch((error: unknown) => error);
    try {
      await entered.promise;
      const next: ReloadLifecycle = { root: { PI_DADDY_GRANT: "tool:read", PI_DADDY_DEPTH: "0" } };
      if (replaced) {
        session.reconcileEnvironment({ ...process.env, ...next.root }, next);
        await loadProjectDefinitions(session, cwd);
        assert.deepEqual([...session.workspacePin!.keys()], ["good"]);
        assert.deepEqual(session.workspaceAcceptance, { accepted: ["good"], firstUse: false, unaccepted: ["evil"] });
        await session.delegationContext();
      }
      const pin = session.workspacePin;
      const catalog = session.catalog;
      const ready = session.catalogReady;
      const acceptance = session.workspaceAcceptance;
      const skips = [...session.workspaceSkips];
      const definitions = session.definitions;
      const grants = [...session.ownGrant];
      release.resolve();
      const error = await outcome;
      assert.ok(failure instanceof BoundedReadCleanupError);
      assert.equal(error, failure, "acceptance cannot replace or swallow the actual typed cleanup error");
      assert.equal(failure.cause, cause);
      assert.equal(oldOwner.workspacePinFailure, failure);
      assert.equal(oldOwner.discoveryCleanupFailure, failure);
      assert.equal(oldOwner.workspacePin, undefined);
      const failedOwner = replaced ? createGrantsSession(undefined, oldOwner, undefined, session.discovery) : session;
      await assert.rejects(failedOwner.delegationContext(), (error) => error === failure);
      await assert.rejects(original, (error) => error === failure);
      assert.ok(held);
      assert.ok(retainedBoundedReadCleanups().some((owner) => owner.handle === held));
      await held.stat();
      assert.equal(closes, 1, "no implicit physical retry");
      assert.deepEqual(await readFile(path), before, "never overwrite the prior decision");
      const healthy = async () => {
        if (!replaced) return;
        assert.equal(next.discoveryCleanupFailure, undefined);
        assert.equal(next.workspacePinFailure, undefined);
        assert.equal(session.discoveryCleanupFailure, undefined);
        assert.equal(session.workspacePin, pin);
        assert.equal(session.catalog, catalog);
        assert.equal(session.catalogReady, ready);
        assert.equal(session.workspaceAcceptance, acceptance);
        assert.deepEqual(session.workspaceSkips, skips);
        assert.equal(session.definitions, definitions);
        assert.deepEqual(session.ownGrant, grants);
        assert.equal((await session.delegationContext()).catalog, catalog);
      };
      await healthy();
      await Promise.all([failure.cleanup(), failure.cleanup()]);
      assert.equal(closes, 2, "concurrent explicit recovery closes only the original handle once");
      assert.equal(held.fd, -1);
      await assert.rejects(held.stat(), { code: "EBADF" });
      assert.ok(!retainedBoundedReadCleanups().some((owner) => owner.handle === held));
      await assert.rejects(original, (error) => error === failure);
      await assert.rejects(failedOwner.delegationContext(), (error) => error === failure);
      await healthy();
    } finally {
      release.resolve();
      await outcome;
      if (failure) await failure.cleanup();
      assert.ok(!held || held.fd === -1);
      if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgent;
      if (savedRegistry === undefined) delete process.env.PI_DADDY_WORKSPACE_REGISTRY;
      else process.env.PI_DADDY_WORKSPACE_REGISTRY = savedRegistry;
    }
  });
}

// Enduring requirement: old clean pin work cannot publish or begin new acceptance I/O after owner replacement.
for (const boundary of ["registry", "acceptance-missing", "acceptance-existing", "canonical"] as const) {
  test(`same-session replacement isolates late clean ${boundary} pin work`, async () => {
    const cwd = await tempDir("pin-publication-");
    const savedAgent = process.env.PI_CODING_AGENT_DIR;
    const savedRegistry = process.env.PI_DADDY_WORKSPACE_REGISTRY;
    process.env.PI_CODING_AGENT_DIR = await tempDir("pin-publication-agent-");
    const oldRegistry = join(cwd, "old.json");
    const newRegistry = join(cwd, "new.json");
    const missing = join(cwd, "missing");
    await writeFile(
      oldRegistry,
      JSON.stringify({
        version: 1,
        workspaces: {
          obsoleteMissing: { path: missing },
          obsoleteNext: { path: cwd },
          unaccepted: { path: cwd },
        },
      }),
    );
    await writeFile(newRegistry, JSON.stringify({ version: 1, workspaces: { current: { path: cwd } } }));
    process.env.PI_DADDY_WORKSPACE_REGISTRY = oldRegistry;
    if (boundary === "acceptance-existing" || boundary === "canonical")
      await acceptWorkspaces(oldRegistry, ["obsoleteMissing", "obsoleteNext"]);
    const oldAcceptancePath = acceptedWorkspacesPath(oldRegistry);
    const beforeAcceptance = await readFile(oldAcceptancePath, "utf8").catch(() => undefined);
    const entered = gate();
    const release = gate();
    const handles: FileHandle[] = [];
    let acceptanceReads = 0;
    const canonicalStarts: string[] = [];
    let registries = 0;
    const oldOwner: ReloadLifecycle = { root: { PI_DADDY_GRANT: "tool:read,tool:delegate", PI_DADDY_DEPTH: "0" } };
    const session = createGrantsSession(undefined, oldOwner, undefined, {
      registry: (path) => {
        const first = ++registries === 1;
        return loadWorkspaceRegistry(path, (name, limits) =>
          readBoundedFile(name, limits, {
            open: async (name, flags) => {
              const handle = await open(name, flags);
              handles.push(handle);
              return handle;
            },
            read: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
            close: async (handle) => {
              if (first && boundary === "registry") {
                entered.resolve();
                await release.promise;
              }
              await handle.close();
            },
          }),
        );
      },
      acceptanceRead: async (path) => {
        acceptanceReads++;
        // Read real bytes (or real ENOENT), then gate settlement rather than fabricating an acceptance result.
        const result = await readFile(path, "utf8").then(
          (text) => ({ text }),
          (error: unknown) => ({ error }),
        );
        if (path === oldAcceptancePath && boundary.startsWith("acceptance")) {
          entered.resolve();
          await release.promise;
        }
        if ("error" in result) throw result.error;
        return result.text;
      },
      canonicalise: async (path) => {
        canonicalStarts.push(path);
        const result = await realpath(path).then(
          (canonical) => ({ canonical }),
          (error: unknown) => ({ error }),
        );
        if (path === missing && boundary === "canonical") {
          entered.resolve();
          await release.promise;
        }
        if ("error" in result) throw result.error;
        return result.canonical;
      },
    });
    session.cwd = cwd;
    session.reconcileEnvironment({ ...process.env, ...oldOwner.root }, oldOwner);
    const pending = loadProjectDefinitions(session, cwd);
    const outcome = pending.catch((error: unknown) => error);
    try {
      await entered.promise;
      const next: ReloadLifecycle = { root: { PI_DADDY_GRANT: "tool:read", PI_DADDY_DEPTH: "0" } };
      process.env.PI_DADDY_WORKSPACE_REGISTRY = newRegistry;
      session.reconcileEnvironment({ ...process.env, ...next.root }, next);
      await loadProjectDefinitions(session, cwd);
      const acceptance = session.workspaceAcceptance;
      const skips = [...session.workspaceSkips];
      const pin = session.workspacePin;
      const catalog = session.catalog;
      const ready = session.catalogReady;
      const definitions = session.definitions;
      const grants = [...session.ownGrant];
      const reads = acceptanceReads;
      const canonicalCount = canonicalStarts.length;
      const newAcceptanceBytes = await readFile(acceptedWorkspacesPath(newRegistry), "utf8");
      assert.deepEqual(acceptance, { accepted: ["current"], firstUse: true, unaccepted: [] });
      assert.ok(pin?.has("current"));
      await session.delegationContext();
      release.resolve();
      const error = await outcome;
      assert.ok(error instanceof Error);
      assert.match(error.message, /discovery owner replaced before publication/);
      assert.equal(session.workspaceAcceptance, acceptance, "old acceptance must not overwrite the replacement");
      assert.deepEqual(session.workspaceSkips, skips, "old skips and canonical callbacks stay local");
      assert.equal(session.workspacePin, pin);
      assert.equal(session.catalog, catalog);
      assert.equal(session.catalogReady, ready);
      assert.equal(session.definitions, definitions);
      assert.deepEqual(session.ownGrant, grants);
      assert.equal((await session.delegationContext()).catalog, catalog);
      assert.equal(next.discoveryCleanupFailure, undefined);
      assert.equal(oldOwner.discoveryCleanupFailure, undefined, "owner mismatch is not physical cleanup failure");
      assert.equal(next.workspacePinFailure, undefined);
      assert.equal(oldOwner.workspacePin, undefined);
      assert.equal(acceptanceReads, reads, "obsolete registry completion cannot start acceptance reconciliation");
      assert.equal(canonicalStarts.length, canonicalCount, "obsolete work cannot start another realpath");
      assert.equal(
        await readFile(oldAcceptancePath, "utf8").catch(() => undefined),
        beforeAcceptance,
        "no obsolete first-use write may start after replacement",
      );
      assert.equal(await readFile(acceptedWorkspacesPath(newRegistry), "utf8"), newAcceptanceBytes);
      if (beforeAcceptance === undefined) await assert.rejects(access(oldAcceptancePath), { code: "ENOENT" });
      assert.ok(
        handles.every((handle) => handle.fd === -1),
        "all actual clean registry descriptors closed",
      );
    } finally {
      release.resolve();
      await outcome;
      assert.ok(handles.every((handle) => handle.fd === -1));
      if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgent;
      if (savedRegistry === undefined) delete process.env.PI_DADDY_WORKSPACE_REGISTRY;
      else process.env.PI_DADDY_WORKSPACE_REGISTRY = savedRegistry;
    }
  });
}
