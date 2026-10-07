import assert from "node:assert/strict";
import { fstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { createGrantsSession, loadProjectDefinitions } from "../extensions/session.ts";
import { GRANT_ENV_KEYS } from "../src/kernel/propagation.ts";
import { loadDefinitions } from "../src/kernel/definitions.ts";
import { buildCatalog } from "../src/kernel/catalog.ts";
import { loadWorkspaceRegistry } from "../src/kernel/workspace.ts";
import { readBoundedFile, BoundedReadCleanupError, retainedBoundedReadCleanups } from "../src/kernel/bounded-read.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

// Enduring requirement: a failed physical reader close cannot become successful pin/refresh state.
async function fixture(cause: unknown, targetKind: "registry" | "definition", failClose = true) {
  const cwd = await tempDir("session-reader-cleanup-");
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await tempDir("session-reader-cleanup-agent-");
  const skill = join(cwd, ".pi", "skills", "reader", "SKILL.md");
  await mkdir(join(cwd, ".pi", "skills", "reader"), { recursive: true });
  await writeFile(skill, "---\nname: reader\ndescription: reader\nallowed-tools: Read\n---\nRead.\n");
  const registry = join(cwd, "registry.json");
  await writeFile(registry, JSON.stringify({ version: 1, workspaces: { w: { path: cwd } } }));
  const target = targetKind === "registry" ? registry : skill;
  let held: FileHandle | undefined;
  let failure: BoundedReadCleanupError | undefined;
  let closes = 0;
  let armed = true;
  const reader: typeof readBoundedFile = async (path, limits) => {
    try {
      return await readBoundedFile(path, limits, {
        open: async (name, flags) => {
          const handle = await open(name, flags);
          if (name === target && armed) held = handle;
          return handle;
        },
        read: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: async (handle) => {
          if (handle === held) {
            closes++;
            if (armed) {
              armed = false;
              if (failClose) throw cause;
            }
          }
          await handle.close();
        },
      });
    } catch (error) {
      assert.ok(error instanceof BoundedReadCleanupError);
      failure = error;
      throw error;
    }
  };
  const definitionCalls: string[] = [];
  const loaders = {
    registry: (path: string) => loadWorkspaceRegistry(path, reader),
    definitions: (path: string, skipped?: (path: string, reason: string) => void) => {
      definitionCalls.push(path);
      return loadDefinitions(path, skipped, reader);
    },
  };
  const previousCwd = process.cwd();
  process.chdir(cwd);
  const session = createGrantsSession(
    undefined,
    { root: { PI_DADDY_GRANT: "tool:read,tool:delegate", PI_DADDY_DEPTH: "0" } },
    undefined,
    loaders,
  );
  session.cwd = cwd;
  process.chdir(previousCwd);
  const hooks = new Map<string, Function>();
  const notices: string[] = [];
  let registrations = 0;
  const api = {
    on: (name: string, handler: Function) => hooks.set(name, handler),
    registerTool: () => {
      registrations++;
    },
    registerCommand: () => {},
    getAllTools: () => [{ name: "read" }, { name: "delegate" }],
    getActiveTools: () => ["read"],
    setActiveTools: () => {},
  };
  grantsExtension(api as never, session);
  const ctx = {
    cwd,
    mode: "json",
    sessionManager: {},
    ui: { notify: (message: string) => notices.push(message), select: async () => undefined },
    modelRegistry: { find: () => undefined },
  };
  const previous = process.env.PI_DADDY_WORKSPACE_REGISTRY;
  process.env.PI_DADDY_WORKSPACE_REGISTRY = registry;
  return {
    session,
    hooks,
    ctx,
    notices,
    definitionCalls,
    registrations: () => registrations,
    failure: () => {
      assert.ok(failure);
      return failure;
    },
    async verifyPhysicalOwner() {
      const error = this.failure();
      assert.equal(error.cause, cause);
      assert.equal(closes, 1, "no implicit close retry");
      assert.ok(held);
      const fd = held.fd;
      fstatSync(fd);
      assert.ok(retainedBoundedReadCleanups().some((owner) => owner.handle === held));
      // A DIFFERENT descriptor reading the same file succeeds, but cannot repair the failed operation.
      assert.ok((await reader(target, { maxBytes: 1 << 20, timeoutMs: 2000 })).ok);
      assert.equal(closes, 1);
      await error.cleanup();
      assert.equal(closes, 2);
      assert.equal(held.fd, -1);
      await assert.rejects(held.stat(), { code: "EBADF" });
      const unrelated = await open(target, "r");
      try {
        await error.cleanup();
        fstatSync(unrelated.fd);
        assert.equal(closes, 2, "released owner never closes a recycled descriptor");
      } finally {
        await unrelated.close();
      }
      return error;
    },
    async dispose() {
      if (failure) await failure.cleanup();
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previous === undefined) delete process.env.PI_DADDY_WORKSPACE_REGISTRY;
      else process.env.PI_DADDY_WORKSPACE_REGISTRY = previous;
    },
  };
}

// Enduring requirement: an obsolete startup cannot discover its cwd or publish child authority on a replacement.
for (const failClose of [false, true]) {
  test(`startup suspended before discovery leaves replacement untouched (${failClose ? "failed" : "clean"} old close)`, async () => {
    const saved = Object.fromEntries(GRANT_ENV_KEYS.map((key) => [key, process.env[key]]));
    const f = await fixture(false, "definition", failClose);
    const legacy = join(f.ctx.cwd, ".pi", "grants.jsonl");
    execFileSync("mkfifo", [legacy]);
    // The real legacy import awaits EOF. Holding its writer makes this pre-discovery boundary deterministic.
    const startup = f.hooks.get("session_start")!({}, f.ctx);
    const writer = await open(legacy, "w");
    const initiating = f.session.reloadLifecycle;
    let resumed = false;
    try {
      assert.deepEqual(f.definitionCalls, [], "startup has not reached discovery");
      const cwd = await tempDir("startup-replacement-");
      await mkdir(join(cwd, ".pi", "skills", "replacement"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "skills", "replacement", "SKILL.md"),
        "---\nname: replacement\ndescription: replacement\nallowed-tools: Read\n---\nReplacement.\n",
      );
      const replacement = {
        root: { PI_DADDY_GRANT: "tool:read", PI_DADDY_DEPTH: "1", PI_DADDY_WORKSPACE_PIN: "" },
      };
      f.session.reconcileEnvironment({ ...process.env, ...replacement.root }, replacement);
      f.session.cwd = cwd;
      await loadProjectDefinitions(f.session, cwd, replacement);
      await f.session.delegationContext();
      const catalog = f.session.catalog;
      const ready = f.session.catalogReady;
      const definitions = f.session.definitions;
      const pin = f.session.workspacePin;
      const published = Object.fromEntries(GRANT_ENV_KEYS.map((key) => [key, process.env[key]]));
      const registered = f.registrations();
      let publications = 0;
      const publish = f.session.publishChildEnv;
      f.session.publishChildEnv = () => {
        publications++;
        publish();
      };
      await writer.close();
      resumed = true;
      await startup;
      assert.ok(
        f.definitionCalls.every((path) => path === cwd),
        "obsolete startup must not load its old cwd against B",
      );
      assert.equal(f.session.reloadLifecycle, replacement);
      assert.equal(f.session.catalog, catalog);
      assert.equal(f.session.catalogReady, ready);
      assert.equal(f.session.definitions, definitions);
      assert.ok(definitions.has("replacement"));
      assert.equal(f.session.workspacePin, pin);
      assert.equal(f.session.pinSettled, true);
      assert.equal(f.session.discoveryCleanupFailure, undefined);
      assert.equal(f.registrations(), registered, "no old spawnable refresh");
      assert.equal(publications, 0, "no obsolete child authority publication");
      assert.deepEqual(Object.fromEntries(GRANT_ENV_KEYS.map((key) => [key, process.env[key]])), published);
      await f.session.delegationContext();
      if (failClose) {
        // Force the still-armed real descriptor failure on A, not B; explicit physical recovery cannot revive A.
        const old = createGrantsSession(undefined, initiating, undefined, f.session.discovery);
        await assert.rejects(loadProjectDefinitions(old, f.ctx.cwd, initiating), (error) => error === f.failure());
        await assert.rejects(old.delegationContext(), (error) => error === f.failure());
        await f.verifyPhysicalOwner();
        await assert.rejects(loadProjectDefinitions(old, f.ctx.cwd, initiating), (error) => error === f.failure());
        await f.session.delegationContext();
        assert.equal(f.session.catalog, catalog);
        assert.equal(f.session.workspacePin, pin);
      }
    } finally {
      if (!resumed) await writer.close();
      await startup;
      await f.dispose();
      for (const key of GRANT_ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
}

// Enduring requirement: a broken UI cannot hide a retained cleanup failure or create a new rejected observer.
test("startup cleanup diagnostic independently retains the original close and notification errors", async (t) => {
  const primary = new Error("real startup close failed");
  const diagnostic = new Error("startup notification failed");
  const f = await fixture(primary, "registry");
  const messages: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => messages.push(args));
  f.ctx.ui.notify = () => {
    throw diagnostic;
  };
  const initiating = f.session.reloadLifecycle;
  try {
    await f.hooks.get("session_start")!({}, f.ctx);
    const failure = f.failure();
    assert.equal(failure.cause, primary);
    assert.equal(f.session.reloadLifecycle, initiating);
    assert.equal(initiating.discoveryCleanupFailure, failure);
    assert.equal(f.session.discoveryCleanupFailure, failure);
    await assert.rejects(f.session.catalogReady, (error) => error === failure);
    await assert.rejects(f.session.delegationContext(), (error) => error === failure);
    assert.ok(
      messages.some((args) => args.includes(failure) && args.includes(diagnostic)),
      "independent console diagnostic includes exact original cleanup and notify errors",
    );
    await f.verifyPhysicalOwner();
    await assert.rejects(f.session.delegationContext(), (error) => error === failure);
  } finally {
    await f.dispose();
  }
});

test("startup outer fallback reports both setup and notification failures independently", async (t) => {
  const primary = new Error("startup child publication failed");
  const diagnostic = new Error("outer startup notification failed");
  const f = await fixture(undefined, "definition", false);
  const messages: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => messages.push(args));
  f.session.publishChildEnv = () => {
    throw primary;
  };
  f.ctx.ui.notify = () => {
    throw diagnostic;
  };
  try {
    await f.hooks.get("session_start")!({}, f.ctx);
    assert.ok(
      messages.some((args) => args.includes(primary) && args.includes(diagnostic)),
      "outer broken-notify fallback is observable without losing its initiating error",
    );
  } finally {
    await f.dispose();
  }
});

for (const cause of [undefined, null, false]) {
  test(`root pin reports and retains ${String(cause)} close failure without settling an empty pin`, async () => {
    const f = await fixture(cause, "registry");
    try {
      await f.hooks.get("session_start")!({}, f.ctx);
      const error = f.failure();
      const original = f.session.catalogReady;
      assert.equal(f.session.discoveryCleanupFailure, error);
      assert.ok(
        f.notices.some((message) => message.includes(error.message)),
        "actual startup diagnostic",
      );
      await assert.rejects(f.session.catalogReady, (value) => value === error);
      await assert.rejects(f.session.delegationContext(), (value) => value === error);
      assert.equal(f.session.pinSettled, false);
      assert.equal(f.session.workspacePin, undefined);
      await f.verifyPhysicalOwner();
      await assert.rejects(loadProjectDefinitions(f.session, f.ctx.cwd), (value) => value === error);
      assert.equal(f.session.pinSettled, false, "explicit physical cleanup cannot remint this session's pin");
      await assert.rejects(original, (value) => value === error);
      await assert.rejects(f.session.catalogReady, (value) => value === error);
      const reload = createGrantsSession(undefined, f.session.reloadLifecycle, undefined, f.session.discovery);
      await assert.rejects(loadProjectDefinitions(reload, f.ctx.cwd), (value) => value === error);
      assert.equal(reload.pinSettled, false, "reload cannot erase the original owner's failed pin");
    } finally {
      await f.dispose();
    }
  });

  test(`wired provider refresh retains ${String(cause)} definition close failure rather than fulfilling stale catalog`, async () => {
    const f = await fixture(cause, "definition");
    try {
      // Establish a real prior catalog with a DIFFERENT clean descriptor, not the armed loader.
      const prior = await buildCatalog({ cwd: f.ctx.cwd, observedTools: null });
      f.session.catalog = prior;
      f.hooks.get("before_provider_request")!({ payload: { tools: [{ name: "read" }] } }, f.ctx);
      const original = f.session.catalogReady;
      await assert.rejects(original, (value) => value === f.failure());
      const error = f.failure();
      assert.ok(
        f.notices.some((message) => message.includes(error.message)),
        "actual refresh diagnostic",
      );
      await assert.rejects(f.session.delegationContext(), (value) => value === error);
      assert.equal(f.session.catalog, prior, "prior view is display only, not successful refresh");
      await f.verifyPhysicalOwner();
      assert.equal(f.session.catalogReady, original, "rejection observation must not replace the failed refresh");
      await assert.rejects(original, (value) => value === error);
    } finally {
      await f.dispose();
    }
  });
}
