import assert from "node:assert/strict";
import { fstatSync } from "node:fs";
import { access, mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { main } from "../src/cli.ts";
import { buildCatalog } from "../src/kernel/catalog.ts";
import { loadWorkspaceRegistry, registeredWorkspaceIds } from "../src/kernel/workspace.ts";
import { readBoundedFile, BoundedReadCleanupError, retainedBoundedReadCleanups } from "../src/kernel/bounded-read.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

// Enduring requirement: registry display/scaffolding may soften malformed data, never physical cleanup failure.
async function fixture(cause: unknown) {
  const cwd = await tempDir("registry-reader-cleanup-");
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await tempDir("registry-reader-cleanup-agent-");
  const registry = join(cwd, "registry.json");
  await writeFile(registry, JSON.stringify({ version: 1, workspaces: { w: { path: cwd } } }));
  const pkg = join(cwd, "node_modules", "reader-package");
  await mkdir(join(pkg, "reader"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "reader-package", version: "1.0.0", pi: { skills: ["reader"] } }),
  );
  await writeFile(
    join(pkg, "reader", "SKILL.md"),
    "---\nname: reader\ndescription: reader\nallowed-tools: Read\n---\nRead.\n",
  );
  let held: FileHandle | undefined;
  let failure: BoundedReadCleanupError | undefined;
  let closes = 0;
  let armed = true;
  const loader: typeof loadWorkspaceRegistry = async (path) => {
    try {
      return await loadWorkspaceRegistry(path, (name, limits) =>
        readBoundedFile(name, limits, {
          open: async (name, flags) => {
            const handle = await open(name, flags);
            if (armed) held = handle;
            return handle;
          },
          read: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async (handle) => {
            if (handle === held) {
              closes++;
              if (armed) {
                armed = false;
                throw cause;
              }
            }
            await handle.close();
          },
        }),
      );
    } catch (error) {
      assert.ok(error instanceof BoundedReadCleanupError);
      failure = error;
      throw error;
    }
  };
  const previous = process.env.PI_DADDY_WORKSPACE_REGISTRY;
  process.env.PI_DADDY_WORKSPACE_REGISTRY = registry;
  return {
    cwd,
    registry,
    loader,
    error() {
      assert.ok(failure);
      return failure;
    },
    async verify(original: Promise<unknown>) {
      const error = this.error();
      assert.equal(error.cause, cause);
      assert.equal(closes, 1);
      assert.ok(held);
      const fd = held.fd;
      fstatSync(fd);
      assert.ok(retainedBoundedReadCleanups().some((owner) => owner.handle === held));
      assert.deepEqual(await registeredWorkspaceIds(registry, undefined, loader), ["w"], "different clean read");
      assert.equal(closes, 1, "no implicit retry of the actual failed handle");
      await error.cleanup();
      assert.equal(held.fd, -1);
      await assert.rejects(held.stat(), { code: "EBADF" }); // A concurrent catalog read may reuse fd's number.
      await assert.rejects(original, (value) => value === error);
      const unrelated = await open(registry, "r");
      try {
        await error.cleanup();
        fstatSync(unrelated.fd);
      } finally {
        await unrelated.close();
      }
      assert.equal(closes, 2);
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

for (const cause of [undefined, null, false]) {
  for (const route of ["ids", "catalog", "ui-init", "cli-init"] as const) {
    test(`${route} preserves ${String(cause)} first registry-close failure and its exact owner`, async () => {
      const f = await fixture(cause);
      const notices: string[] = [];
      let original: Promise<unknown>;
      let session: ReturnType<typeof createGrantsSession> | undefined;
      try {
        if (route === "ids") original = registeredWorkspaceIds(f.registry, (reason) => notices.push(reason), f.loader);
        else if (route === "catalog")
          original = buildCatalog(
            { cwd: f.cwd, observedTools: null, registryPath: f.registry },
            { registry: f.loader },
          );
        else if (route === "cli-init") original = main(["node", "cli", "init", "--dir", f.cwd], f.loader);
        else {
          session = createGrantsSession(undefined, { root: {} }, undefined, { registry: f.loader });
          session.cwd = f.cwd;
          let command!: { handler: (args: string, ctx: unknown) => Promise<void> };
          const api = {
            on: () => {},
            registerTool: () => {},
            registerCommand: (_name: string, value: typeof command) => {
              command = value;
            },
          };
          grantsExtension(api as never, session);
          original = command.handler("init", {
            cwd: f.cwd,
            ui: {
              notify: (message: string) => notices.push(message),
              select: async () => "No",
            },
          });
        }
        await assert.rejects(original, (value) => value === f.error());
        assert.ok(
          !notices.some((message) => message.includes("registry unreadable")),
          "cleanup is not ordinary unreadability",
        );
        if (session) {
          assert.equal(session.discoveryCleanupFailure, f.error());
          assert.ok(
            notices.some((message) => message.includes(f.error().message)),
            "actual registered init diagnostic",
          );
          await assert.rejects(session.delegationContext(), (value) => value === f.error());
        }
        await assert.rejects(access(join(f.cwd, ".pi", "pi-daddy", "settings.json")), { code: "ENOENT" });
        await f.verify(original);
      } finally {
        await f.dispose();
      }
    });
  }
}

test("registered init keeps the exact cleanup rejection when UI notification itself throws", async () => {
  const f = await fixture(false);
  const diagnosticFailure = new Error("notification unavailable");
  const diagnostics: unknown[][] = [];
  const oldError = console.error;
  console.error = (...args: unknown[]) => diagnostics.push(args);
  const session = createGrantsSession(undefined, { root: {} }, undefined, { registry: f.loader });
  session.cwd = f.cwd;
  const grantBefore = [...session.ownGrant];
  let command!: { handler: (args: string, ctx: unknown) => Promise<void> };
  grantsExtension(
    {
      on: () => {},
      registerTool: () => {},
      registerCommand: (_name: string, value: typeof command) => {
        command = value;
      },
    } as never,
    session,
  );
  try {
    const original = command.handler("init", {
      cwd: f.cwd,
      ui: {
        notify: () => {
          throw diagnosticFailure;
        },
        select: async () => assert.fail("no grant dialog after cleanup failure"),
      },
    });
    await assert.rejects(original, (error) => error === f.error());
    assert.equal(session.discoveryCleanupFailure, f.error());
    assert.deepEqual(session.ownGrant, grantBefore);
    await assert.rejects(session.delegationContext(), (error) => error === f.error());
    assert.ok(
      diagnostics.some((args) => args.includes(diagnosticFailure) && args.includes(f.error())),
      "diagnostic failure visible separately",
    );
    await assert.rejects(access(join(f.cwd, ".pi", "pi-daddy", "settings.json")), { code: "ENOENT" });
    await f.verify(original);
  } finally {
    console.error = oldError;
    await f.dispose();
  }
});

for (const kind of ["malformed", "missing"] as const) {
  test(`${kind} registry remains an observable soft fallback in helper and catalog`, async () => {
    const cwd = await tempDir("registry-soft-");
    const registry = join(cwd, "registry.json");
    if (kind === "malformed") await writeFile(registry, "not JSON");
    const reasons: string[] = [];
    assert.deepEqual(await registeredWorkspaceIds(registry, (reason) => reasons.push(reason)), []);
    assert.equal(reasons.length, 1);
    const catalog = await buildCatalog({ cwd, observedTools: null, registryPath: registry });
    assert.deepEqual(catalog.byKind("workspace"), []);
    assert.ok(catalog.registryRefusal);
  });
}
