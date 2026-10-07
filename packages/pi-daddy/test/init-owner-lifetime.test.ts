import assert from "node:assert/strict";
import { fstatSync } from "node:fs";
import { access, mkdir, open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { assertDiscoveryHealthy, createGrantsSession, loadProjectDefinitions } from "../extensions/session.ts";
import type { ReloadLifecycle } from "../extensions/reload-environment.ts";
import { grantStorePath } from "../src/governance/grant-store.ts";
import {
  BoundedReadCleanupError,
  readBoundedBytes,
  readBoundedFile,
  retainedBoundedReadCleanups,
} from "../src/kernel/bounded-read.ts";
import { discoverSkillPackages } from "../src/kernel/skill-packages.ts";
import { loadWorkspaceRegistry } from "../src/kernel/workspace.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

// Enduring requirement: an init command owns its initiating lifetime, not whichever owner is current later.
async function fixture(cause: unknown, fail: boolean, target: "registry" | "legacy" | "configured" = "registry") {
  const cwd = await tempDir("init-owner-lifetime-");
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  const savedRegistry = process.env.PI_DADDY_WORKSPACE_REGISTRY;
  process.env.PI_CODING_AGENT_DIR = await tempDir("init-owner-lifetime-agent-");
  const registry = join(cwd, "registry.json");
  await writeFile(registry, JSON.stringify({ version: 1, workspaces: { w: { path: cwd } } }));
  process.env.PI_DADDY_WORKSPACE_REGISTRY = registry;
  const pkg = join(cwd, "node_modules", "reader-package");
  await mkdir(join(pkg, "reader"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "reader-package", version: "1.0.0", pi: { skills: ["reader"] } }),
  );
  const skill = "---\nname: reader\ndescription: reader\nallowed-tools: Read, Write\n---\nRead.\n";
  await writeFile(join(pkg, "reader", "SKILL.md"), skill);
  await mkdir(join(cwd, ".pi", "skills", "reader"), { recursive: true });
  await writeFile(join(cwd, ".pi", "skills", "reader", "SKILL.md"), skill);
  const entered = gate();
  const release = gate();
  let held: FileHandle | undefined;
  let failure: BoundedReadCleanupError | undefined;
  let calls = 0;
  let closes = 0;
  const oldLifecycle: ReloadLifecycle = { root: { PI_DADDY_GRANT: "tool:read,tool:delegate", PI_DADDY_DEPTH: "0" } };
  const packagePath =
    target === "legacy" ? join(pkg, "reader", "SKILL.md") : join(cwd, ".pi", "skills", "reader", "SKILL.md");
  const session = createGrantsSession(undefined, oldLifecycle, undefined, {
    packages: (path) =>
      discoverSkillPackages(path, async (name, limits) => {
        if (target === "registry" || name !== packagePath || ++calls !== 1) return readBoundedBytes(name, limits);
        try {
          return await readBoundedBytes(name, limits, {
            open: async (name, flags) => (held = await open(name, flags)),
            read: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
            close: async (handle) => {
              if (++closes === 1) {
                entered.resolve();
                await release.promise;
                if (fail) throw cause;
              }
              await handle.close();
            },
          });
        } catch (error) {
          if (error instanceof BoundedReadCleanupError) failure = error;
          throw error;
        }
      }),
    registry: async (path) => {
      if (target !== "registry" || ++calls !== 1) return loadWorkspaceRegistry(path);
      try {
        return await loadWorkspaceRegistry(path, (name, limits) =>
          readBoundedFile(name, limits, {
            open: async (name, flags) => (held = await open(name, flags)),
            read: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
            close: async (handle) => {
              if (++closes === 1) {
                entered.resolve();
                await release.promise;
                if (fail) throw cause;
              }
              await handle.close();
            },
          }),
        );
      } catch (error) {
        if (error instanceof BoundedReadCleanupError) failure = error;
        throw error;
      }
    },
  });
  session.cwd = cwd;
  session.reconcileEnvironment({ ...process.env, ...oldLifecycle.root }, oldLifecycle);
  let command!: { handler(args: string, ctx: unknown): Promise<void> };
  let registrations = 0;
  grantsExtension(
    {
      on: () => {},
      registerTool: () => registrations++,
      registerCommand: (_name: string, value: typeof command) => (command = value),
    } as never,
    session,
  );
  const initialRegistrations = registrations;
  const notices: string[] = [];
  let dialogs = 0;
  const ctx = {
    cwd,
    ui: {
      notify: (message: string) => notices.push(message),
      select: async () => {
        dialogs++;
        return "Yes";
      },
    },
  };
  return {
    cwd,
    registry,
    session,
    oldLifecycle,
    entered,
    release,
    command,
    ctx,
    notices,
    held: () => {
      assert.ok(held);
      return held;
    },
    failure: () => {
      assert.ok(failure);
      return failure;
    },
    closes: () => closes,
    calls: () => calls,
    async replacement() {
      const next: ReloadLifecycle = { root: { PI_DADDY_GRANT: "tool:read", PI_DADDY_DEPTH: "0" } };
      session.reconcileEnvironment({ ...process.env, ...next.root }, next);
      assert.notEqual(session.reloadLifecycle, oldLifecycle);
      await loadProjectDefinitions(session, cwd);
      const pin = session.workspacePin;
      const catalog = session.catalog;
      const ready = session.catalogReady;
      const definitions = session.definitions;
      const grant = [...session.ownGrant];
      assert.ok(pin?.has("w"), "replacement completed its actual clean root pin");
      assert.ok(definitions.has("reader"));
      await session.delegationContext();
      return {
        next,
        async healthy() {
          assert.equal(next.discoveryCleanupFailure, undefined);
          assert.equal(session.discoveryCleanupFailure, undefined);
          assert.equal(session.workspacePin, pin);
          assert.equal(session.catalog, catalog);
          assert.equal(session.catalogReady, ready);
          assert.equal(session.definitions, definitions);
          assert.deepEqual(session.ownGrant, grant);
          assert.equal((await session.delegationContext()).catalog, catalog);
        },
      };
    },
    async untouched() {
      assert.equal(dialogs, 0, "old init cannot ask a grant question");
      assert.equal(registrations, initialRegistrations, "old init cannot refresh tool publication");
      await assert.rejects(access(join(cwd, ".pi", "pi-daddy", "settings.json")), { code: "ENOENT" });
      await assert.rejects(access(grantStorePath(cwd)), { code: "ENOENT" });
    },
    async dispose() {
      release.resolve();
      if (failure) await failure.cleanup();
      assert.ok(!held || held.fd === -1, "original actual handle released before fixture deletion");
      if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgent;
      if (savedRegistry === undefined) delete process.env.PI_DADDY_WORKSPACE_REGISTRY;
      else process.env.PI_DADDY_WORKSPACE_REGISTRY = savedRegistry;
    },
  };
}

// First package reads must retain the same terminal owner policy as registry/refresh reads.
for (const target of ["configured", "legacy"] as const) {
  for (const replaced of [false, true]) {
    test(`registered init ${target} package cleanup faults only its initiating owner (replaced=${replaced})`, async () => {
      const f = await fixture(false, true, target);
      const original = f.command.handler("init", f.ctx);
      const outcome = original.catch((error: unknown) => error);
      try {
        await f.entered.promise;
        const replacement = replaced ? await f.replacement() : undefined;
        f.release.resolve();
        const error = await outcome;
        assert.equal(error, f.failure());
        assert.equal(error.cause, false);
        assert.equal(f.oldLifecycle.discoveryCleanupFailure, error);
        const oldOwner = replaced
          ? createGrantsSession(undefined, f.oldLifecycle, undefined, f.session.discovery)
          : f.session;
        await assert.rejects(oldOwner.delegationContext(), (value) => value === error);
        assert.equal(f.closes(), 1);
        assert.ok(retainedBoundedReadCleanups().some((owner) => owner.handle === f.held()));
        fstatSync(f.held().fd);
        await replacement?.healthy();
        await f.untouched();
        assert.ok(f.notices.some((text) => text.includes(error.message)));
        await Promise.all([error.cleanup(), error.cleanup()]);
        assert.equal(f.closes(), 2);
        assert.equal(f.held().fd, -1);
        await assert.rejects(original, (value) => value === error);
        await assert.rejects(oldOwner.delegationContext(), (value) => value === error);
        await replacement?.healthy();
        await f.untouched();
      } finally {
        f.release.resolve();
        await outcome;
        await f.dispose();
      }
    });
  }

  test(`registered init ${target} package cleanup survives a broken diagnostic`, async () => {
    const f = await fixture(null, true, target);
    const diagnostic = new Error("notification unavailable");
    const logs: unknown[][] = [];
    const saved = console.error;
    console.error = (...values) => logs.push(values);
    f.ctx.ui.notify = () => {
      throw diagnostic;
    };
    try {
      f.release.resolve();
      await assert.rejects(f.command.handler("init", f.ctx), (error) => error === f.failure());
      assert.equal(f.oldLifecycle.discoveryCleanupFailure, f.failure());
      assert.ok(logs.some((values) => values.includes(diagnostic) && values.includes(f.failure())));
      await assert.rejects(f.session.delegationContext(), (error) => error === f.failure());
      await f.untouched();
    } finally {
      console.error = saved;
      await f.dispose();
    }
  });
}

for (const cause of [undefined, null, false]) {
  test(`registered init retains late ${String(cause)} close failure only on its initiating owner`, async () => {
    const f = await fixture(cause, true);
    const unhandled: unknown[] = [];
    const observer = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", observer);
    const original = f.command.handler("init", f.ctx);
    const outcome = original.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await f.entered.promise;
      const held = f.held();
      fstatSync(held.fd);
      const replacement = await f.replacement();
      await replacement.healthy();
      f.release.resolve();
      assert.equal(await outcome, f.failure(), "actual command rejects its exact typed cleanup error");
      const error = f.failure();
      assert.equal(error.cause, cause);
      assert.equal(f.oldLifecycle.discoveryCleanupFailure, error, "failure belongs to old initiating lifecycle");
      const oldOwner = createGrantsSession(undefined, f.oldLifecycle, undefined, f.session.discovery);
      await assert.rejects(oldOwner.delegationContext(), (value) => value === error);
      assert.throws(
        () => assertDiscoveryHealthy(f.session, f.oldLifecycle),
        (value) => value === error,
      );
      assert.equal(f.closes(), 1, "no implicit physical retry");
      assert.ok(retainedBoundedReadCleanups().some((owner) => owner.handle === held));
      fstatSync(held.fd);
      await replacement.healthy();
      await f.untouched();
      assert.ok(
        f.notices.some((text) => text.includes(error.message)),
        "actual init diagnostic",
      );
      const calls = f.calls();
      await Promise.all([error.cleanup(), error.cleanup()]);
      assert.equal(f.closes(), 2, "serialized exact-handle recovery");
      assert.equal(held.fd, -1);
      await assert.rejects(held.stat(), { code: "EBADF" });
      await assert.rejects(original, (value) => value === error);
      await assert.rejects(oldOwner.delegationContext(), (value) => value === error);
      assert.throws(
        () => assertDiscoveryHealthy(f.session, f.oldLifecycle),
        (value) => value === error,
      );
      await replacement.healthy();
      await f.untouched();
      assert.equal(f.calls(), calls, "cleanup cannot trigger discovery retry");
      await new Promise<void>((done) => setImmediate(done));
      assert.deepEqual(unhandled, []);
    } finally {
      f.release.resolve();
      await outcome;
      process.off("unhandledRejection", observer);
      await f.dispose();
    }
  });
}

test("registered init refresh cannot recapture a replacement introduced during grant adoption", async () => {
  const f = await fixture(undefined, false);
  const adopt = f.session.adoptGrant;
  const next: ReloadLifecycle = { root: { PI_DADDY_GRANT: "tool:read", PI_DADDY_DEPTH: "0" } };
  let callsAtReplacement = 0;
  f.session.adoptGrant = (grant, ledger) => {
    adopt(grant, ledger);
    f.session.reconcileEnvironment({ ...process.env, ...next.root }, next);
    callsAtReplacement = f.calls();
  };
  try {
    f.release.resolve();
    await assert.rejects(f.command.handler("init", f.ctx), /discovery owner replaced before publication/);
    assert.equal(f.calls(), callsAtReplacement, "old refresh must not start replacement registry acquisition");
    assert.equal(f.session.definitions.size, 0, "old refresh cannot publish replacement definitions");
    assert.equal(f.session.pinSettled, false);
    assert.deepEqual(f.session.ownGrant, ["tool:read"]);
    assert.equal(next.discoveryCleanupFailure, undefined);
    // The old save/adoption already happened; guards refuse continuation, not undo completed work.
    await access(grantStorePath(f.cwd));
    await loadProjectDefinitions(f.session, f.cwd);
    await f.session.delegationContext();
  } finally {
    await f.dispose();
  }
});

for (const kind of ["normal", "missing", "malformed"] as const) {
  test(`registered init preserves ${kind} registry scaffolding and current grant validation`, async () => {
    const f = await fixture(undefined, false);
    try {
      if (kind === "missing") await unlink(f.registry);
      if (kind === "malformed") await writeFile(f.registry, "not JSON");
      f.release.resolve();
      await f.command.handler("init", f.ctx);
      const stored = JSON.parse(await readFile(grantStorePath(f.cwd), "utf8"));
      assert.deepEqual(f.session.ownGrant, stored.grant);
      assert.ok(stored.grant.includes("tool:write"), "explicit human Yes still confers the withheld tool");
      assert.ok(!stored.grant.some((capability: string) => capability.startsWith("workspace:")));
      await access(join(f.cwd, ".pi", "pi-daddy", "settings.json"));
      await f.session.delegationContext();
      assert.equal(f.session.discoveryCleanupFailure, undefined);
      assert.equal(f.oldLifecycle.discoveryCleanupFailure, undefined);
      assert.ok(f.notices.some((text) => text.includes("live now")));
      assert.equal(
        f.notices.some((text) => text.includes("registry unreadable")),
        kind !== "normal",
      );
    } finally {
      await f.dispose();
    }
  });
}

test("registered init refuses a late clean registry result after the same session is rebound", async () => {
  const f = await fixture(undefined, false);
  const original = f.command.handler("init", f.ctx);
  const outcome = original.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await f.entered.promise;
    const replacement = await f.replacement();
    await replacement.healthy();
    f.release.resolve();
    const error = await outcome;
    assert.ok(error instanceof Error);
    assert.match(error.message, /discovery owner replaced before publication/);
    assert.equal(f.oldLifecycle.discoveryCleanupFailure, undefined, "clean close is not a cleanup failure");
    assert.equal(f.held().fd, -1, "late clean resource still closed");
    assert.equal(f.closes(), 1);
    await replacement.healthy();
    await f.untouched();
  } finally {
    f.release.resolve();
    await outcome;
    await f.dispose();
  }
});
