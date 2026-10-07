import assert from "node:assert/strict";
import { access, mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { fstatSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { createGrantsSession, loadProjectDefinitions } from "../extensions/session.ts";
import { beginExtensionLifecycle, bindReloadLifecycle } from "../extensions/reload-environment.ts";
import { loadDefinitions } from "../src/kernel/definitions.ts";
import { loadWorkspaceRegistry } from "../src/kernel/workspace.ts";
import { BoundedReadCleanupError, readBoundedFile } from "../src/kernel/bounded-read.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function fixture() {
  const cwd = await tempDir("session-discovery-overlap-");
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  const savedRegistry = process.env.PI_DADDY_WORKSPACE_REGISTRY;
  process.env.PI_CODING_AGENT_DIR = await tempDir("session-discovery-overlap-agent-");
  const registry = join(cwd, "registry.json");
  await writeFile(registry, JSON.stringify({ version: 1, workspaces: { w: { path: cwd } } }));
  process.env.PI_DADDY_WORKSPACE_REGISTRY = registry;
  const pkg = join(cwd, "node_modules", "reader-package");
  await mkdir(join(pkg, "reader"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "reader-package", version: "1.0.0", pi: { skills: ["reader"] } }),
  );
  await mkdir(join(cwd, ".pi", "skills", "reader"), { recursive: true });
  const skillText = "---\nname: reader\ndescription: reader\nallowed-tools: Read\n---\nRead.\n";
  await writeFile(join(pkg, "reader", "SKILL.md"), skillText);
  await writeFile(join(cwd, ".pi", "skills", "reader", "SKILL.md"), skillText);
  const handles: FileHandle[] = [];
  const errors: BoundedReadCleanupError[] = [];
  function reader(beforeClose: () => Promise<void>, fail: boolean): typeof readBoundedFile {
    let armed = true;
    return async (path, limits) => {
      try {
        return await readBoundedFile(path, limits, {
          open: async (name, flags) => {
            const held = await open(name, flags);
            handles.push(held);
            return held;
          },
          read: (held, buffer, offset, length, position) => held.read(buffer, offset, length, position),
          close: async (held) => {
            if (armed) {
              armed = false;
              await beforeClose();
              if (fail) throw false;
            }
            await held.close();
          },
        });
      } catch (error) {
        assert.ok(error instanceof BoundedReadCleanupError);
        errors.push(error);
        throw error;
      }
    };
  }
  function wire(session: ReturnType<typeof createGrantsSession>) {
    session.cwd = cwd;
    const hooks = new Map<string, Function>();
    let command!: { handler(args: string, ctx: unknown): Promise<void> };
    const notices: string[] = [];
    const api = {
      on: (name: string, fn: Function) => hooks.set(name, fn),
      registerTool: () => {},
      registerCommand: (_name: string, value: typeof command) => {
        command = value;
      },
      getAllTools: () => [{ name: "read" }, { name: "delegate" }],
      getActiveTools: () => ["read"],
      setActiveTools: () => {},
    };
    grantsExtension(api as never, session);
    const ctx = {
      cwd,
      mode: "json",
      sessionManager: {},
      modelRegistry: { find: () => undefined },
      ui: { notify: (text: string) => notices.push(text), select: async () => "No" },
    };
    return { hooks, ctx, command, notices };
  }
  return {
    cwd,
    registry,
    reader,
    errors,
    handles,
    wire,
    async dispose() {
      await Promise.all(errors.map((error) => error.cleanup()));
      assert.ok(
        handles.every((held) => held.fd === -1),
        "every successful late read and failed owner released",
      );
      if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgent;
      if (savedRegistry === undefined) delete process.env.PI_DADDY_WORKSPACE_REGISTRY;
      else process.env.PI_DADDY_WORKSPACE_REGISTRY = savedRegistry;
    },
  };
}

// Enduring requirement: a clean operation admitted before a failed refresh cannot publish over that failure.
for (const route of ["startup", "registered-init"] as const) {
  test(`${route} late clean discovery cannot replace provider's failed catalog`, async () => {
    const f = await fixture();
    const entered = gate();
    const release = gate();
    let calls = 0;
    const session = createGrantsSession(
      undefined,
      { root: { PI_DADDY_GRANT: "tool:read,tool:delegate", PI_DADDY_DEPTH: "0", PI_DADDY_WORKSPACE_PIN: "" } },
      undefined,
      {
        definitions: (cwd, skipped) => {
          const index = ++calls;
          return loadDefinitions(
            cwd,
            skipped,
            f.reader(async () => {
              if (index === 1) {
                entered.resolve();
                await release.promise;
              }
            }, index === 2),
          );
        },
      },
    );
    const wired = f.wire(session);
    const original =
      route === "startup" ? wired.hooks.get("session_start")!({}, wired.ctx) : wired.command.handler("init", wired.ctx);
    const outcome = Promise.resolve(original).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      wired.hooks.get("before_provider_request")!({ payload: { tools: [{ name: "read" }] } }, wired.ctx);
      const failedCatalog = session.catalogReady;
      await assert.rejects(failedCatalog, (error) => error === f.errors[0]);
      const failure = f.errors[0];
      const failedHandle = f.handles.find((held) => held.fd !== -1 && held !== f.handles[0])!;
      fstatSync(failedHandle.fd);
      release.resolve();
      const result = await outcome;
      if (route === "registered-init") assert.equal(result, failure, "init refresh rejects the retained failure");
      await assert.rejects(session.catalogReady, (error) => error === failure);
      await assert.rejects(session.delegationContext(), (error) => error === failure);
      assert.equal(session.definitions.size, 0, "late definitions must not be published");
      assert.ok(wired.notices.some((text) => text.includes(failure.message)));
      await failure.cleanup();
      await assert.rejects(session.delegationContext(), (error) => error === failure);
      const reload = createGrantsSession(undefined, session.reloadLifecycle, undefined, session.discovery);
      await assert.rejects(loadProjectDefinitions(reload, f.cwd), (error) => error === failure);
    } finally {
      release.resolve();
      await outcome;
      await f.dispose();
    }
  });
}

test("delegation waiting on a real clean catalog rejects a later provider cleanup failure", async () => {
  const f = await fixture();
  const entered = gate();
  const release = gate();
  let definitions = 0;
  let registries = 0;
  const session = createGrantsSession(
    undefined,
    {
      root: { PI_DADDY_GRANT: "tool:read,tool:delegate", PI_DADDY_DEPTH: "0", PI_DADDY_WORKSPACE_PIN: "" },
    },
    undefined,
    {
      definitions: (cwd, skipped) =>
        loadDefinitions(
          cwd,
          skipped,
          f.reader(async () => {}, ++definitions === 3),
        ),
      registry: (path) => {
        const index = ++registries;
        return loadWorkspaceRegistry(
          path,
          f.reader(async () => {
            if (index === 1) {
              entered.resolve();
              await release.promise;
            }
          }, false),
        );
      },
    },
  );
  const wired = f.wire(session);
  const startup = wired.hooks.get("session_start")!({}, wired.ctx);
  let delegation: Promise<unknown> | undefined;
  try {
    await entered.promise;
    delegation = session.delegationContext().then(
      () => undefined,
      (error: unknown) => error,
    );
    wired.hooks.get("before_provider_request")!({ payload: { tools: [{ name: "read" }] } }, wired.ctx);
    await assert.rejects(session.catalogReady, (error) => error === f.errors[0]);
    release.resolve();
    await startup;
    assert.equal(await delegation, f.errors[0], "failure rechecked after the awaited clean catalog");
    assert.equal(session.definitions.size, 0);
    await assert.rejects(session.catalogReady, (error) => error === f.errors[0]);
    assert.deepEqual(session.ownGrant, ["tool:read"], "actual observation still narrows current grant");
  } finally {
    release.resolve();
    await startup;
    await delegation;
    await f.dispose();
  }
});

test("a distinct explicit root replacement cannot be poisoned by the old pending pin", async () => {
  const f = await fixture();
  const entered = gate();
  const release = gate();
  const owner = {};
  const savedGrant = process.env.PI_DADDY_GRANT;
  const provisional = beginExtensionLifecycle().lifecycle;
  // Trusted initial root differs from the current operator root, without clearing protected inputs.
  provisional.root = {
    ...provisional.root,
    PI_DADDY_GRANT: "tool:read,tool:delegate,workspace:old-root",
    PI_DADDY_DEPTH: "0",
    PI_DADDY_WORKSPACE_PIN: undefined,
  };
  const bound = bindReloadLifecycle(owner, provisional);
  const original = createGrantsSession(undefined, bound.lifecycle, undefined, {
    registry: (path) =>
      loadWorkspaceRegistry(
        path,
        f.reader(async () => {
          entered.resolve();
          await release.promise;
        }, true),
      ),
  });
  original.reconcileEnvironment(bound.environment, bound.lifecycle);
  const pending = loadProjectDefinitions(original, f.cwd);
  const outcome = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    process.env.PI_DADDY_GRANT = "tool:find"; // Explicit operator replacement, not any known child publication.
    const replacement = bindReloadLifecycle(owner, beginExtensionLifecycle().lifecycle);
    const next = createGrantsSession(undefined, replacement.lifecycle);
    next.reconcileEnvironment(replacement.environment, replacement.lifecycle);
    assert.notEqual(
      replacement.environment.PI_DADDY_GRANT,
      bound.environment.PI_DADDY_GRANT,
      "actual distinct root replacement",
    );
    await loadProjectDefinitions(next, f.cwd);
    const replacementPin = next.workspacePin;
    release.resolve();
    const failure = await outcome;
    assert.equal(failure, f.errors[0]);
    await assert.rejects(original.delegationContext(), (error) => error === failure);
    await loadProjectDefinitions(next, f.cwd);
    await next.delegationContext();
    assert.equal(next.workspacePin, replacementPin, "replacement's own pin stays fixed");
    assert.notEqual(
      next.reloadLifecycle,
      original.reloadLifecycle,
      "pending ownership is not rebound to a replacement",
    );
  } finally {
    release.resolve();
    await outcome;
    await f.dispose();
    if (savedGrant === undefined) delete process.env.PI_DADDY_GRANT;
    else process.env.PI_DADDY_GRANT = savedGrant;
  }
});

test("rebinding the same session preserves the pending old acquisition without poisoning the replacement", async () => {
  const f = await fixture();
  const entered = gate();
  const release = gate();
  const oldLifecycle = { root: { PI_DADDY_GRANT: "tool:read,tool:delegate", PI_DADDY_DEPTH: "0" } };
  let calls = 0;
  const session = createGrantsSession(undefined, oldLifecycle, undefined, {
    registry: (path) => {
      const index = ++calls;
      return loadWorkspaceRegistry(
        path,
        f.reader(async () => {
          if (index === 1) {
            entered.resolve();
            await release.promise;
          }
        }, index === 1),
      );
    },
  });
  session.reconcileEnvironment({ ...process.env, ...oldLifecycle.root }, oldLifecycle);
  const oldRead = loadProjectDefinitions(session, f.cwd);
  const outcome = oldRead.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    const replacement = { root: { PI_DADDY_GRANT: "tool:read", PI_DADDY_DEPTH: "1", PI_DADDY_WORKSPACE_PIN: "" } };
    session.reconcileEnvironment({ ...process.env, ...replacement.root }, replacement);
    await loadProjectDefinitions(session, f.cwd);
    release.resolve();
    assert.equal(await outcome, f.errors[0]);
    await loadProjectDefinitions(session, f.cwd);
    await session.delegationContext();
    const oldOwner = createGrantsSession(undefined, oldLifecycle, undefined, session.discovery);
    await assert.rejects(oldOwner.delegationContext(), (error) => error === f.errors[0]);
  } finally {
    release.resolve();
    await outcome;
    await f.dispose();
  }
});

test("actual startup and reentrant reload join one failed pin acquisition", async () => {
  const f = await fixture();
  const entered = gate();
  const release = gate();
  let calls = 0;
  let nested: Promise<void> | undefined;
  let nestedOutcome: Promise<unknown> | undefined;
  let reload!: ReturnType<typeof createGrantsSession>;
  const lifecycle = { root: { PI_DADDY_GRANT: "tool:read,tool:delegate", PI_DADDY_DEPTH: "0" } };
  const session = createGrantsSession(undefined, lifecycle, undefined, {
    registry: (path) => {
      const index = ++calls;
      if (index === 1) {
        nested = loadProjectDefinitions(reload, f.cwd);
        nestedOutcome = nested.then(
          () => undefined,
          (error: unknown) => error,
        );
      }
      return loadWorkspaceRegistry(
        path,
        f.reader(async () => {
          if (index === 1) {
            entered.resolve();
            await release.promise;
          }
        }, index === 1),
      );
    },
  });
  reload = createGrantsSession(undefined, lifecycle, undefined, session.discovery);
  reload.reconcileEnvironment({ ...process.env, ...lifecycle.root }, lifecycle);
  assert.equal(reload.depth, 0, "the overlap must exercise a root acquisition, not descendant refusal");
  const wired = f.wire(session);
  const startup = wired.hooks.get("session_start")!({}, wired.ctx);
  try {
    await entered.promise;
    // A reentrant loader starts the second operation before the first acquisition has even opened.
    assert.equal(calls, 1, "one physically owned acquisition per actual lifecycle");
    release.resolve();
    await startup;
    const failure = f.errors[0];
    assert.equal(await nestedOutcome, failure);
    for (const owner of [session, reload]) {
      assert.equal(owner.pinSettled, false);
      assert.equal(owner.workspacePin, undefined);
      await assert.rejects(owner.delegationContext(), (error) => error === failure);
    }
    await failure.cleanup();
    await assert.rejects(loadProjectDefinitions(reload, f.cwd), (error) => error === failure);
    assert.equal(calls, 1, "physical recovery cannot remint");
    await assert.rejects(access(join(f.cwd, ".pi", "pi-daddy", "settings.json")), { code: "ENOENT" });
  } finally {
    release.resolve();
    await startup;
    await nestedOutcome;
    await f.dispose();
  }
});
