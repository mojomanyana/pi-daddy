import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { ensureDashboardSessionServer } from "../extensions/dashboard-session-server.ts";
import { closeSessionAutoMode } from "../extensions/session-auto-mode.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { grantStorePath, saveGrant } from "../src/governance/grant-store.ts";
import { projectSettingsPath } from "../src/kernel/project-paths.ts";
import { resolveDefinitionRuntime } from "../extensions/definition-runtime.ts";
import { GRANT_ENV_KEYS } from "../src/kernel/propagation.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
const sessions: ReturnType<typeof createGrantsSession>[] = [];

// Removing ctx.cwd from the startup reconciliation makes the first test load A's grant in B.
// Reading B's store for a descendant, or ignoring an explicit empty grant, breaks the other controls.
async function fixture(run: (a: string, b: string, agent: string) => Promise<void>) {
  const a = await tempDir("grant-process-cwd-"),
    b = await tempDir("grant-selected-cwd-"),
    agent = await tempDir("grant-cwd-agent-");
  const cwd = process.cwd(),
    keys = [...GRANT_ENV_KEYS, "PI_CODING_AGENT_DIR", "PI_DADDY_ACTIVITY_TIMELINE"];
  const env = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.chdir(a);
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.PI_DADDY_HERDR = "0";
    process.env.PI_DADDY_ACTIVITY_TIMELINE = "off";
    await saveGrant(a, ["tool:read"]);
    await saveGrant(b, ["tool:read", "tool:delegate", "workspace:b"]);
    await run(a, b, agent);
  } finally {
    for (const session of sessions.splice(0)) {
      await (await ensureDashboardSessionServer(session)).close();
      await closeSessionAutoMode(session);
    }
    process.chdir(cwd);
    for (const [key, value] of env) value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
}
async function start(cwd: string, owner = {}, prepare = (_session: ReturnType<typeof createGrantsSession>) => {}) {
  const session = createGrantsSession(undefined),
    hooks = new Map<string, any>(),
    registered: string[] = [],
    active = new Set(["read"]);
  sessions.push(session);
  prepare(session);
  grantsExtension(
    {
      on: (name: string, fn: any) => hooks.set(name, fn),
      registerCommand() {},
      registerTool(tool: { name: string }) {
        registered.push(tool.name);
      },
      getAllTools: () => [{ name: "read" }, { name: "delegate" }],
      getActiveTools: () => [...active],
      setActiveTools(names: string[]) {
        active.clear();
        names.forEach((name) => active.add(name));
      },
    } as never,
    session,
  );
  await hooks.get("session_start")(
    {},
    {
      cwd,
      mode: "json",
      sessionManager: owner,
      ui: { notify() {}, select: async () => undefined },
      modelRegistry: { find: () => undefined },
    },
  );
  return { session, registered, active };
}
test("actual selected cwd reuses its existing grant before registration and again on reload", async () =>
  fixture(async (a, b) => {
    const originals = await Promise.all([a, b].map((cwd) => readFile(grantStorePath(cwd), "utf8"))),
      owner = {};
    const first = await start(b, owner);
    assert.deepEqual(first.session.ownGrant, ["tool:delegate", "tool:read", "workspace:b"]);
    assert.equal(first.session.storeCwd, b);
    assert.ok(first.active.has("delegate"));
    const reload = await start(b, owner);
    assert.deepEqual(reload.session.ownGrant, first.session.ownGrant);
    assert.equal(reload.session.depth, 0);
    assert.deepEqual(
      await Promise.all([a, b].map((cwd) => readFile(grantStorePath(cwd), "utf8"))),
      originals,
      "reuse never rewrites either grant",
    );
  }));
test("explicit and empty environment grants take precedence in another selected cwd", async () =>
  fixture(async (_a, b) => {
    for (const grant of ["tool:read", ""]) {
      process.env.PI_DADDY_GRANT = grant;
      process.env.PI_DADDY_DEPTH = "0";
      const { session } = await start(b);
      assert.deepEqual(session.ownGrant, grant ? ["tool:read"] : []);
    }
  }));
test("a descendant never adopts a broader target store, including missing inherited grant", async () =>
  fixture(async (_a, b) => {
    for (const grant of ["tool:read", undefined]) {
      process.env.PI_DADDY_DEPTH = "1";
      grant === undefined ? delete process.env.PI_DADDY_GRANT : (process.env.PI_DADDY_GRANT = grant);
      const { session } = await start(b, {}, (provisional) => {
        assert.deepEqual(
          provisional.ownGrant,
          grant ? ["tool:read"] : [],
          "factory state also cannot borrow a root store",
        );
      });
      assert.equal(session.depth, 1);
      assert.deepEqual(session.ownGrant, grant ? ["tool:read"] : []);
      assert.equal(session.mayDelegate, false);
    }
  }));
test("an explicit directory alias uses only the grant stored for that exact selected spelling", async () =>
  fixture(async (a, b) => {
    const alias = join(a, "b-alias");
    await symlink(b, alias, "dir");
    await saveGrant(alias, ["tool:read", "workspace:alias"]);
    const { session } = await start(alias);
    assert.deepEqual(session.ownGrant, ["tool:read", "workspace:alias"]);
    assert.equal(session.storeCwd, alias, "no implicit migration or widening through a canonical alias");
  }));

test("runtime defaults bind to the selected directory while session and explicit choices keep precedence", async () =>
  fixture(async (a, b) => {
    for (const [cwd, model] of [
      [a, "fixture:process"],
      [b, "fixture:selected"],
    ]) {
      await mkdir(dirname(projectSettingsPath(cwd)), { recursive: true });
      await writeFile(projectSettingsPath(cwd), JSON.stringify({ defaults: { model, thinking: "low" } }));
    }
    const { session } = await start(b, {}, (s) =>
      s.definitionRuntimeOverrides.set("review", { model: "fixture/session", thinking: "high" }),
    );
    assert.deepEqual(session.definitionRuntimeSettings.defaults, { model: "fixture/selected", thinking: "low" });
    const inputs = {
      definition: "review",
      session: session.definitionRuntimeOverrides,
      settings: session.definitionRuntimeSettings,
    };
    assert.equal(resolveDefinitionRuntime({ ...inputs, explicit: {} }).model, "fixture/session");
    assert.equal(
      resolveDefinitionRuntime({ ...inputs, explicit: { model: "fixture/explicit" } }).model,
      "fixture/explicit",
    );
  }));

test("malformed selected grant refuses instead of retaining the process directory's valid grant", async () =>
  fixture(async (_a, b) => {
    await writeFile(grantStorePath(b), "malformed selected grant");
    const { session, active } = await start(b);
    assert.deepEqual(session.ownGrant, []);
    assert.equal(session.grantStoreRefusal?.reason, "malformed");
    assert.equal(session.grantStoreRefusal?.path, grantStorePath(b));
    assert.equal(active.has("delegate"), false);
  }));
test("malformed selected runtime defaults retain the existing depth refusal", async () =>
  fixture(async (_a, b) => {
    await mkdir(dirname(projectSettingsPath(b)), { recursive: true });
    await writeFile(projectSettingsPath(b), JSON.stringify({ defaults: { model: "unqualified-model" } }));
    const { session } = await start(b);
    assert.equal(session.maxDepth, 0);
    assert.ok(session.malformedBounds.includes("settings.json model"));
    assert.deepEqual(session.definitionRuntimeSettings.defaults, {});
  }));
