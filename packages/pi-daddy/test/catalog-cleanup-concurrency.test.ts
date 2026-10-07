import assert from "node:assert/strict";
import { fstatSync } from "node:fs";
import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { createGrantsSession, loadProjectDefinitions } from "../extensions/session.ts";
import { CollectedBoundedReadCleanupError } from "../src/kernel/bounded-read-failures.ts";
import { buildCatalog } from "../src/kernel/catalog.ts";
import { loadDefinitions } from "../src/kernel/definitions.ts";
import { loadWorkspaceRegistry } from "../src/kernel/workspace.ts";
import { BoundedReadCleanupError, readBoundedFile, retainedBoundedReadCleanups } from "../src/kernel/bounded-read.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

// Explicit discovery reads definitions before its concurrent catalog phase. Keep that first phase clean
// so these cases measure independently owned definitions + registry closes in the actual catalog join.
function catalogPhaseDefinitions(loader: typeof loadDefinitions): typeof loadDefinitions {
  let initial = true;
  return (cwd, skipped) => {
    if (initial) {
      initial = false;
      return loadDefinitions(cwd, skipped);
    }
    return loader(cwd, skipped);
  };
}

// Started discovery branches own independent physical closes even when another branch rejects first.
for (const multiple of [false, true]) {
  for (const first of ["definitions", "registry"] as const) {
    for (const persistent of multiple ? [false, true] : [false]) {
      test(`explicit discovery joins ${multiple ? "two physical failures" : "ordinary and physical failure"}, ${first} first, retry failure ${persistent}`, async () => {
        const cwd = await tempDir("catalog-cleanup-concurrent-");
        const oldAgent = process.env.PI_CODING_AGENT_DIR;
        const oldRegistry = process.env.PI_DADDY_WORKSPACE_REGISTRY;
        process.env.PI_CODING_AGENT_DIR = await tempDir("catalog-cleanup-concurrent-agent-");
        const registry = join(cwd, "registry.json");
        const skill = join(cwd, ".pi", "skills", "reader", "SKILL.md");
        await mkdir(join(cwd, ".pi", "skills", "reader"), { recursive: true });
        await writeFile(skill, "---\nname: reader\ndescription: reader\nallowed-tools: Read\n---\nRead.\n");
        await writeFile(registry, JSON.stringify({ version: 1, workspaces: { w: { path: cwd } } }));
        const releases = { definitions: gate(), registry: gate() };
        const entered = { definitions: gate(), registry: gate() };
        const finished = { definitions: gate(), registry: gate() };
        const errors = new Map<string, BoundedReadCleanupError>();
        const handles = new Map<string, FileHandle>();
        const causes = { definitions: false, registry: undefined };
        const closes = new Map<string, number>();
        const ordinary = new Error("definitions discovery unavailable");
        const reader =
          (kind: "definitions" | "registry"): typeof readBoundedFile =>
          async (path, limits) => {
            try {
              return await readBoundedFile(path, limits, {
                open: async (name, flags) => {
                  const handle = await open(name, flags);
                  handles.set(kind, handle);
                  return handle;
                },
                read: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
                close: async (handle) => {
                  const count = (closes.get(kind) ?? 0) + 1;
                  closes.set(kind, count);
                  if (count === 1) {
                    entered[kind].resolve();
                    await releases[kind].promise;
                    throw causes[kind];
                  }
                  if (persistent && kind === "registry" && count === 2) throw null;
                  await handle.close();
                },
              });
            } catch (error) {
              assert.ok(error instanceof BoundedReadCleanupError);
              errors.set(kind, error);
              throw error;
            } finally {
              finished[kind].resolve();
            }
          };
        const definitions: typeof loadDefinitions = multiple
          ? (path, skipped) => loadDefinitions(path, skipped, reader("definitions"))
          : async () => {
              entered.definitions.resolve();
              await releases.definitions.promise;
              finished.definitions.resolve();
              throw ordinary;
            };
        const session = createGrantsSession(
          undefined,
          { root: { PI_DADDY_GRANT: "tool:read,tool:delegate", PI_DADDY_DEPTH: "0", PI_DADDY_WORKSPACE_PIN: "" } },
          undefined,
          {
            definitions: catalogPhaseDefinitions(definitions),
            registry: (path) => loadWorkspaceRegistry(path, reader("registry")),
          },
        );
        session.cwd = cwd;
        const hooks = new Map<string, Function>();
        const notices: string[] = [];
        const api = {
          on: (name: string, handler: Function) => hooks.set(name, handler),
          registerTool: () => {},
          registerCommand: () => {},
        };
        grantsExtension(api as never, session);
        const ctx = { cwd, ui: { notify: (message: string) => notices.push(message) } };
        try {
          const prior = await buildCatalog({ cwd, observedTools: null });
          session.catalog = prior;
          process.env.PI_DADDY_WORKSPACE_REGISTRY = registry;
          const original = loadProjectDefinitions(session, cwd);
          const outcome = original.then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          );
          await Promise.all([entered.definitions.promise, entered.registry.promise]);
          releases[first].resolve();
          await finished[first].promise;
          // Drain reactions of the first branch before releasing the second; no clock-dependent sleep.
          await new Promise<void>((resolve) => setImmediate(resolve));
          const last = first === "definitions" ? "registry" : "definitions";
          releases[last].resolve();
          await finished[last].promise;
          const result = await outcome;
          const registryError = errors.get("registry")!;
          assert.ok(
            result.error instanceof BoundedReadCleanupError,
            "no ordinary stale success after a started close fails",
          );
          const failure = result.error;
          const members = multiple
            ? (failure as BoundedReadCleanupError & { errors: readonly BoundedReadCleanupError[] }).errors
            : [failure];
          assert.deepEqual(members, multiple ? [errors.get("definitions"), registryError] : [registryError]);
          assert.equal(session.discoveryCleanupFailure, failure);
          await assert.rejects(session.delegationContext(), (error) => error === failure);
          assert.equal(session.catalog, prior, "old catalog is display only");
          assert.equal(
            session.reloadLifecycle.discoveryCleanupFailure,
            failure,
            "initiating owner retains the joined failure",
          );
          for (const [kind, error] of errors) {
            assert.equal(error.cause, causes[kind as keyof typeof causes]);
            assert.equal(closes.get(kind), 1, "no implicit retry");
            const held = handles.get(kind)!;
            fstatSync(held.fd);
            assert.ok(retainedBoundedReadCleanups().some((owner) => owner.handle === held));
          }
          if (persistent) {
            await assert.rejects(failure.cleanup(), (error) => error === registryError);
            assert.equal(handles.get("definitions")!.fd, -1, "independent successful retry is not skipped");
            fstatSync(handles.get("registry")!.fd);
            assert.equal(registryError.cause, undefined);
            assert.equal(registryError.lastCause, null);
          }
          await Promise.all([failure.cleanup(), failure.cleanup()]);
          for (const [kind, held] of handles) {
            assert.equal(closes.get(kind), persistent && kind === "registry" ? 3 : 2);
            assert.equal(held.fd, -1);
            await assert.rejects(held.stat(), { code: "EBADF" });
          }
          await assert.rejects(original, (error) => error === failure);
          await assert.rejects(session.delegationContext(), (error) => error === failure);
        } finally {
          releases.definitions.resolve();
          releases.registry.resolve();
          await Promise.all([...errors.values()].map((error) => error.cleanup()));
          if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = oldAgent;
          if (oldRegistry === undefined) delete process.env.PI_DADDY_WORKSPACE_REGISTRY;
          else process.env.PI_DADDY_WORKSPACE_REGISTRY = oldRegistry;
        }
      });
    }
  }
}

// Synchronous trusted callbacks must not escape the join or prevent another reader from starting.
for (const schedule of ["ordinary registry", "typed registry", "ordinary definitions"] as const) {
  for (const replaced of schedule === "ordinary registry" ? [false, true] : [false]) {
    test(`explicit discovery joins synchronous ${schedule} failure with late physical cleanup, owner replaced ${replaced}`, async () => {
      const cwd = await tempDir("catalog-sync-cleanup-");
      const oldAgent = process.env.PI_CODING_AGENT_DIR;
      const oldRegistry = process.env.PI_DADDY_WORKSPACE_REGISTRY;
      process.env.PI_CODING_AGENT_DIR = await tempDir("catalog-sync-cleanup-agent-");
      const registry = join(cwd, "registry.json");
      const skill = join(cwd, ".pi", "skills", "reader", "SKILL.md");
      await mkdir(join(cwd, ".pi", "skills", "reader"), { recursive: true });
      await writeFile(skill, "---\nname: reader\ndescription: reader\nallowed-tools: Read\n---\nRead.\n");
      await writeFile(registry, JSON.stringify({ version: 1, workspaces: { w: { path: cwd } } }));
      const pending = schedule === "ordinary definitions" ? "registry" : "definitions";
      const opening = gate();
      const allowOpen = gate();
      const closing = gate();
      const allowClose = gate();
      const errors = new Map<string, BoundedReadCleanupError>();
      const handles = new Map<string, FileHandle>();
      const closes = new Map<string, number>();
      const branches: Promise<unknown>[] = [];
      const causes = { definitions: false, registry: undefined };
      const ordinary = new Error(`synchronous ${schedule} unavailable`);
      const calls: string[] = [];
      const unhandled: unknown[] = [];
      const observeUnhandled = (error: unknown) => unhandled.push(error);
      const reader =
        (kind: "definitions" | "registry"): typeof readBoundedFile =>
        async (path, limits) => {
          try {
            return await readBoundedFile(path, limits, {
              open: async (name, flags) => {
                if (kind === pending) {
                  opening.resolve();
                  await allowOpen.promise;
                }
                const handle = await open(name, flags);
                handles.set(kind, handle);
                return handle;
              },
              read: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
              close: async (handle) => {
                assert.equal(handle, handles.get(kind), "always close the original actual FileHandle");
                const count = (closes.get(kind) ?? 0) + 1;
                closes.set(kind, count);
                if (count === 1) {
                  if (kind === pending) {
                    closing.resolve();
                    await allowClose.promise;
                  }
                  throw causes[kind];
                }
                await handle.close();
              },
            });
          } catch (error) {
            assert.ok(error instanceof BoundedReadCleanupError);
            errors.set(kind, error);
            throw error;
          }
        };
      const notices: { message: string; type: string | undefined }[] = [];
      process.on("unhandledRejection", observeUnhandled);
      try {
        // A synchronous typed throw carries a real, independently failed registry descriptor.
        if (schedule === "typed registry") {
          await assert.rejects(
            loadWorkspaceRegistry(registry, reader("registry")),
            (error) => error === errors.get("registry"),
          );
        }
        const session = createGrantsSession(
          undefined,
          { root: { PI_DADDY_GRANT: "tool:read,tool:delegate", PI_DADDY_DEPTH: "0", PI_DADDY_WORKSPACE_PIN: "" } },
          undefined,
          {
            definitions: catalogPhaseDefinitions((path, skipped) => {
              calls.push("definitions");
              if (schedule === "ordinary definitions") throw ordinary;
              const branch = loadDefinitions(path, skipped, reader("definitions"));
              branches.push(branch);
              return branch;
            }),
            registry: (path) => {
              calls.push("registry");
              if (schedule === "typed registry") throw errors.get("registry")!;
              if (schedule === "ordinary registry") throw ordinary;
              const branch = loadWorkspaceRegistry(path, reader("registry"));
              branches.push(branch);
              return branch;
            },
          },
        );
        session.cwd = cwd;
        const hooks = new Map<string, Function>();
        grantsExtension(
          {
            on: (name: string, handler: Function) => hooks.set(name, handler),
            registerTool: () => {},
            registerCommand: () => {},
          } as never,
          session,
        );
        const prior = await buildCatalog({ cwd, observedTools: null });
        session.catalog = prior;
        const initiatingOwner = session.reloadLifecycle;
        process.env.PI_DADDY_WORKSPACE_REGISTRY = registry;
        const original = loadProjectDefinitions(session, cwd);
        let settled = false;
        const outcome = original.then(
          (value) => {
            settled = true;
            return { value, error: undefined };
          },
          (error: unknown) => {
            settled = true;
            return { value: undefined, error };
          },
        );
        await opening.promise;
        const delegation = session.delegationContext();
        const delegationOutcome = delegation.then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(calls, ["definitions", "registry"], "both independent loaders are invoked");
        await opening.promise;
        const settledDuringOpen = settled;
        assert.equal(session.catalog, prior);
        allowOpen.resolve();
        await closing.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        const held = handles.get(pending)!;
        fstatSync(held.fd);
        assert.ok(retainedBoundedReadCleanups().some((owner) => owner.handle === held));
        assert.equal(settled, false, "catalog stays pending during the original physical close");
        assert.equal(settledDuringOpen, false, "catalog stays pending during actual reader acquisition");
        if (replaced) {
          const replacement = {
            root: { PI_DADDY_GRANT: "tool:read", PI_DADDY_DEPTH: "0", PI_DADDY_WORKSPACE_PIN: "" },
          };
          session.reconcileEnvironment(replacement.root, replacement);
          session.catalogReady = Promise.resolve(prior);
          assert.equal((await session.delegationContext()).catalog, prior);
        }
        allowClose.resolve();
        const result = await outcome;
        const leaf = errors.get(pending)!;
        assert.ok(leaf instanceof BoundedReadCleanupError);
        const failure = result.error;
        if (schedule === "typed registry") {
          assert.ok(failure instanceof CollectedBoundedReadCleanupError);
          assert.deepEqual(failure.errors, [leaf, errors.get("registry")]);
        } else assert.equal(failure, leaf, "singleton keeps exact error and recovery identity");
        assert.ok(failure instanceof BoundedReadCleanupError);
        assert.equal((await delegationOutcome).error, failure);
        assert.equal(initiatingOwner.discoveryCleanupFailure, failure);
        assert.equal(session.catalog, prior, "failed refresh cannot publish success");
        assert.deepEqual(
          notices,
          [],
          "explicit discovery propagates its error to its caller; it does not invent a provider notification",
        );
        assert.equal(session.discoveryCleanupFailure, replaced ? undefined : failure);
        if (replaced) {
          assert.equal(session.reloadLifecycle.discoveryCleanupFailure, undefined);
          assert.equal((await session.delegationContext()).catalog, prior);
        } else {
          // The initiating owner guard remains terminal independently of its replaceable catalog promise.
          session.catalogReady = Promise.resolve(prior);
          await assert.rejects(session.delegationContext(), (error) => error === failure);
        }
        for (const [kind, error] of errors) {
          assert.equal(error.cause, causes[kind as keyof typeof causes]);
          assert.equal(error.lastCause, error.cause);
          assert.equal(closes.get(kind), 1, "no implicit physical retry");
          fstatSync(handles.get(kind)!.fd);
        }
        await Promise.all([failure.cleanup(), failure.cleanup()]);
        for (const [kind, handle] of handles) {
          assert.equal(closes.get(kind), 2, "explicit concurrent recovery is serialized");
          assert.equal(handle.fd, -1);
          await assert.rejects(handle.stat(), { code: "EBADF" });
          assert.ok(!retainedBoundedReadCleanups().some((owner) => owner.handle === handle));
        }
        await assert.rejects(original, (error) => error === failure);
        await assert.rejects(delegation, (error) => error === failure);
        if (replaced) assert.equal((await session.delegationContext()).catalog, prior);
        else await assert.rejects(session.delegationContext(), (error) => error === failure);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(unhandled, [], "every independent branch rejection is observed by discovery");
      } finally {
        // Failed assertions still discharge their real fixture readers; this is not a discovery observer.
        const drained = Promise.allSettled(branches);
        allowOpen.resolve();
        allowClose.resolve();
        await drained;
        await Promise.all([...errors.values()].map((error) => error.cleanup()));
        process.off("unhandledRejection", observeUnhandled);
        if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = oldAgent;
        if (oldRegistry === undefined) delete process.env.PI_DADDY_WORKSPACE_REGISTRY;
        else process.env.PI_DADDY_WORKSPACE_REGISTRY = oldRegistry;
      }
    });
  }
}

test("ordinary synchronous registry failure remains an observable catalog refusal", async () => {
  const cwd = await tempDir("catalog-sync-refusal-");
  const ordinary = new Error("registry synchronously unavailable");
  const catalog = await buildCatalog(
    { cwd, observedTools: ["read"], registryPath: join(cwd, "registry.json") },
    {
      definitions: async () => new Map(),
      registry: () => {
        throw ordinary;
      },
    },
  );
  assert.deepEqual(catalog.byKind("workspace"), []);
  assert.equal(catalog.registryRefusal, ordinary.message);
  assert.ok(catalog.has("tool:read"), "ordinary refusal does not discard the usable catalog");
});
