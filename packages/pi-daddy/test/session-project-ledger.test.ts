import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { after, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { createGrantsSession, reconcileAdvisorSession, type GrantsSession } from "../extensions/session.ts";
import { bindReloadLifecycle } from "../extensions/reload-environment.ts";
import { grantStorePath, projectLedgerPath, saveGrant } from "../src/governance/grant-store.ts";
import { GRANT_ENV_KEYS } from "../src/kernel/propagation.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

/**
 * `/grants init` changes the running session as well as the next one.
 *
 * Breaks by: dropping the project-ledger argument in `runInit`, ignoring it in `adoptGrant`, or letting the
 * stored default replace an explicit PI_DADDY_LEDGER value.
 */
test("an invalid project store creates a refused governed session instead of a wildcard session", async () => {
  const cwd = await tempDir("grants-invalid-session-");
  const agentDir = await tempDir("grants-invalid-agent-");
  const originalCwd = process.cwd();
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalGrant = process.env.PI_DADDY_GRANT;
  const originalLedger = process.env.PI_DADDY_LEDGER;
  try {
    process.chdir(cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_DADDY_GRANT;
    delete process.env.PI_DADDY_LEDGER;
    const path = grantStorePath(cwd);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 99, cwd, grant: ["tool:read"] }));
    const session = createGrantsSession(undefined);
    assert.equal(session.governed, true);
    assert.deepEqual(session.inherited, []);
    assert.equal(session.mayDelegate, false);
    assert.equal(session.grantStoreRefusal?.reason, "unsupported-version");
    assert.equal(session.ledgerPath, projectLedgerPath(cwd), "the refusal itself has a durable project trail");
  } finally {
    process.chdir(originalCwd);
    originalAgentDir === undefined
      ? delete process.env.PI_CODING_AGENT_DIR
      : (process.env.PI_CODING_AGENT_DIR = originalAgentDir);
    originalGrant === undefined ? delete process.env.PI_DADDY_GRANT : (process.env.PI_DADDY_GRANT = originalGrant);
    originalLedger === undefined ? delete process.env.PI_DADDY_LEDGER : (process.env.PI_DADDY_LEDGER = originalLedger);
  }
});

test("advisor recording can be rebound to the owner-reconciled episode", async () => {
  const cwd = await tempDir("advisor-episode-rebind-");
  const ledgerPath = projectLedgerPath(cwd);
  const session = {
    episodeId: "episode:00000000-0000-4000-8000-000000000002",
    storeCwd: cwd,
    ledgerPath,
  } as GrantsSession;
  reconcileAdvisorSession(session, {});
  await session.advisorSession.advisor.ask("child-effort", { state: { task: "PRIVATE" }, questions: {} });
  const record = JSON.parse((await readFile(ledgerPath, "utf8")).trim()).body;
  assert.equal(record.episodeId, session.episodeId);
  assert.equal(JSON.stringify(record).includes("PRIVATE"), false);
});

test("owner-bound reload restores its root while a distinct owner keeps inherited child state", async () => {
  const cwd = await tempDir("grants-reload-root-"),
    agentDir = await tempDir("grants-reload-agent-");
  const originalCwd = process.cwd();
  const keys = [...GRANT_ENV_KEYS, "PI_CODING_AGENT_DIR"] as const;
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.chdir(cwd);
    for (const key of keys) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await saveGrant(cwd, ["tool:read"]);
    const owner = {},
      first = createGrantsSession(undefined);
    let bound = bindReloadLifecycle(owner, first.reloadLifecycle);
    first.reconcileEnvironment(bound.environment, bound.lifecycle);
    first.publishChildEnv();
    assert.equal(process.env.PI_DADDY_DEPTH, "1", "the first owner publishes child-only state");
    assert.equal(process.env.PI_DADDY_EPISODE_ID, first.episodeId);

    const reloaded = createGrantsSession(undefined);
    bound = bindReloadLifecycle(owner, reloaded.reloadLifecycle);
    reloaded.reconcileEnvironment(bound.environment, bound.lifecycle);
    assert.equal(reloaded.depth, 0, "the same owner recovers its root rather than its child publication");
    assert.equal(reloaded.maxDepth, 2);
    assert.equal(reloaded.episodeId, first.episodeId, "a reload stays in the same episode");

    // A root replacement is accepted only when it is not a package publication from any owner.
    process.env.PI_DADDY_GRANT = "tool:read";
    delete process.env.PI_DADDY_DEPTH;
    process.env.PI_DADDY_MAX_DEPTH = "1";
    process.env.PI_DADDY_APPROVED = "tool:read@<delegate>";
    const narrowed = createGrantsSession(undefined);
    bound = bindReloadLifecycle(owner, narrowed.reloadLifecycle);
    narrowed.reconcileEnvironment(bound.environment, bound.lifecycle);
    assert.deepEqual(narrowed.inherited, ["tool:read"]);
    assert.equal(narrowed.maxDepth, 1);
    assert.ok(narrowed.inheritedApprovals.has("tool:read@<delegate>"));
    narrowed.publishChildEnv();

    const narrowedReload = createGrantsSession(undefined);
    bound = bindReloadLifecycle(owner, narrowedReload.reloadLifecycle);
    narrowedReload.reconcileEnvironment(bound.environment, bound.lifecycle);
    assert.deepEqual(narrowedReload.inherited, ["tool:read"], "reload keeps the explicit narrowing");
    assert.equal(narrowedReload.maxDepth, 1);
    assert.ok(narrowedReload.inheritedApprovals.has("tool:read@<delegate>"));

    process.env.PI_DADDY_EPISODE_ID = "malformed-child-value";
    const child = createGrantsSession(undefined);
    bound = bindReloadLifecycle({}, child.reloadLifecycle);
    child.reconcileEnvironment(bound.environment, bound.lifecycle);
    assert.equal(child.depth, 1, "a distinct owner starts from the published child state");
    assert.equal(child.maxDepth, 1);
    assert.match(child.episodeId, /^episode:[0-9a-f-]{36}$/i, "malformed inherited identity is never propagated");
  } finally {
    process.chdir(originalCwd);
    for (const key of keys) {
      const value = original.get(key);
      value === undefined ? delete process.env[key] : (process.env[key] = value);
    }
  }
});

test("actual extension reload is owned by its Pi API, not a same-process SDK child's environment", async () => {
  const cwd = await tempDir("grants-reload-lifecycle-"),
    agentDir = await tempDir("grants-reload-lifecycle-agent-");
  const originalCwd = process.cwd(),
    keys = [...GRANT_ENV_KEYS, "PI_CODING_AGENT_DIR", "PI_DADDY_HERDR"] as const;
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  const makePi = (sessionManager: object) => {
    const hooks = new Map<string, any>(),
      active = new Set(["read", "bash", "edit", "write"]);
    return {
      hooks,
      api: {
        on: (name: string, handler: any) => hooks.set(name, handler),
        registerTool: () => {},
        registerCommand: () => {},
        getAllTools: () => [{ name: "read" }, { name: "delegate" }],
        getActiveTools: () => [...active],
        setActiveTools: (names: string[]) => {
          active.clear();
          names.forEach((name) => active.add(name));
        },
      },
      sessionManager,
    };
  };
  const start = async (pi: ReturnType<typeof makePi>) => {
    const notices: string[] = [];
    grantsExtension(pi.api as never);
    await pi.hooks.get("session_start")(
      {},
      {
        cwd,
        mode: "json",
        sessionManager: pi.sessionManager,
        ui: { notify: (message: string) => notices.push(message), select: async () => undefined },
        modelRegistry: { find: () => undefined },
      },
    );
    return notices.join("\n");
  };
  try {
    process.chdir(cwd);
    for (const key of keys) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_DADDY_HERDR = "0";
    await saveGrant(cwd, ["tool:read", "tool:delegate"]);
    const manager = {},
      root = makePi(manager);
    await start(root); // publishes child depth 1
    // Reload identity is keyed to pi's SessionManager, not to a shutdown hook; the extension registers no shutdown
    // hook since 0.31.0, so a reload is exercised by starting a new API object against the same manager.
    const reloadedApi = makePi(manager);
    const reload = await start(reloadedApi);
    assert.match(reload, /depth 0\/2/, "Pi's stable SessionManager recovers root identity across a new API object");
    const child = makePi({});
    const childStart = await start(child);
    assert.match(childStart, /depth 1\/2/, "a different same-process SDK Pi session remains an inherited child");
  } finally {
    process.chdir(originalCwd);
    for (const key of keys) {
      const value = original.get(key);
      value === undefined ? delete process.env[key] : (process.env[key] = value);
    }
  }
});

test("adopting init's project ledger is live now, while an explicit environment value still wins", async () => {
  const cwd = await tempDir("grants-session-ledger-");
  const agentDir = await tempDir("grants-session-agent-");
  const originalCwd = process.cwd();
  const keys = [...GRANT_ENV_KEYS, "PI_CODING_AGENT_DIR"] as const;
  const original = new Map(keys.map((key) => [key, process.env[key]]));

  try {
    process.chdir(cwd);
    for (const key of GRANT_ENV_KEYS) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const session = createGrantsSession(undefined);
    const ledger = projectLedgerPath(cwd);
    session.adoptGrant(["tool:read"], ledger);
    assert.equal(session.ledgerPath, ledger);
    assert.equal(process.env.PI_DADDY_LEDGER, ledger, "the next child inherits the same absolute ledger");

    const movedCwd = await tempDir("grants-session-moved-");
    const movedLedger = projectLedgerPath(movedCwd);
    session.adoptGrant(["tool:read"], movedLedger);
    assert.equal(
      session.ledgerPath,
      movedLedger,
      "a default this session published itself is not an explicit env override when init chooses the new cwd",
    );
    assert.equal(process.env.PI_DADDY_LEDGER, movedLedger);

    for (const key of GRANT_ENV_KEYS) delete process.env[key];
    const explicit = `${cwd}/operator.jsonl`;
    process.env.PI_DADDY_LEDGER = explicit;
    const overridden = createGrantsSession(undefined);
    overridden.adoptGrant(["tool:read"], ledger);
    assert.equal(overridden.ledgerPath, explicit, "init cannot replace an explicit current-session choice");
    assert.equal(process.env.PI_DADDY_LEDGER, explicit);

    for (const key of GRANT_ENV_KEYS) delete process.env[key];
    process.env.PI_DADDY_LEDGER = "";
    const disabled = createGrantsSession(undefined);
    disabled.adoptGrant(["tool:read"], ledger);
    assert.equal(disabled.ledgerPath, "", "an explicit empty value remains a one-run opt-out through init");
    assert.equal(process.env.PI_DADDY_LEDGER, "");
  } finally {
    process.chdir(originalCwd);
    for (const key of keys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
