import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { after, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { markReload } from "../extensions/reload-environment.ts";
import { grantStorePath, projectLedgerPath, saveGrant } from "../src/grant-store.ts";
import { GRANT_ENV_KEYS } from "../src/propagation.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

/**
 * `/grants init` changes the running session as well as the next one.
 *
 * Breaks by: dropping the project-ledger argument in `runInit`, ignoring it in `adoptGrant`, or letting the
 * stored default replace an explicit PI_GRANTS_LEDGER value.
 */
test("an invalid project store creates a refused governed session instead of a wildcard session", async () => {
  const cwd = await tempDir("grants-invalid-session-");
  const agentDir = await tempDir("grants-invalid-agent-");
  const originalCwd = process.cwd();
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalGrant = process.env.PI_GRANTS_GRANT;
  const originalLedger = process.env.PI_GRANTS_LEDGER;
  try {
    process.chdir(cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_GRANTS_GRANT;
    delete process.env.PI_GRANTS_LEDGER;
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
    originalAgentDir === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    originalGrant === undefined ? delete process.env.PI_GRANTS_GRANT : process.env.PI_GRANTS_GRANT = originalGrant;
    originalLedger === undefined ? delete process.env.PI_GRANTS_LEDGER : process.env.PI_GRANTS_LEDGER = originalLedger;
  }
});

test("extension reload keeps a root at depth zero while a real child environment remains inherited", async () => {
  const cwd = await tempDir("grants-reload-root-"), agentDir = await tempDir("grants-reload-agent-");
  const originalCwd = process.cwd();
  const keys = [...GRANT_ENV_KEYS, "PI_CODING_AGENT_DIR"] as const;
  const original = new Map(keys.map(key => [key, process.env[key]]));
  try {
    process.chdir(cwd);
    for (const key of keys) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await saveGrant(cwd, ["tool:read"]);
    const first = createGrantsSession(undefined);
    assert.equal(first.depth, 0);
    first.publishChildEnv();
    assert.equal(process.env.PI_GRANTS_DEPTH, "1", "the first lifecycle publishes child-only state");

    markReload(first.reloadLifecycle);
    const reloaded = createGrantsSession(undefined);
    assert.equal(reloaded.depth, 0, "a same-owner extension reload must recover root identity");
    assert.equal(reloaded.maxDepth, 2);

    // An explicit root replacement must become the new baseline, including its inherited-approval provenance.
    process.env.PI_GRANTS_GRANT = "tool:read";
    delete process.env.PI_GRANTS_DEPTH;
    process.env.PI_GRANTS_MAX_DEPTH = "1";
    process.env.PI_GRANTS_APPROVED = "tool:read@<delegate>";
    const narrowed = createGrantsSession(undefined);
    assert.deepEqual(narrowed.inherited, ["tool:read"]);
    assert.equal(narrowed.maxDepth, 1);
    assert.ok(narrowed.inheritedApprovals.has("tool:read@<delegate>"));
    narrowed.publishChildEnv();
    markReload(narrowed.reloadLifecycle);
    const narrowedReload = createGrantsSession(undefined);
    assert.deepEqual(narrowedReload.inherited, ["tool:read"], "reload must not restore the earlier wider root grant");
    assert.equal(narrowedReload.maxDepth, 1);
    assert.ok(narrowedReload.inheritedApprovals.has("tool:read@<delegate>"));

    // A separately initialized SDK session has a distinct owner even in the same JavaScript realm.
    const child = createGrantsSession(undefined);
    assert.equal(child.depth, 1, "a genuine child retains the parent-published depth limit");
    assert.equal(child.maxDepth, 1);
    assert.ok(child.inheritedApprovals.has("tool:read@<delegate>"));
  } finally {
    process.chdir(originalCwd);
    for (const key of keys) {
      const value = original.get(key);
      value === undefined ? delete process.env[key] : process.env[key] = value;
    }
  }
});

test("actual extension reload is owned by its Pi API, not a same-process SDK child's environment", async () => {
  const cwd = await tempDir("grants-reload-lifecycle-"), agentDir = await tempDir("grants-reload-lifecycle-agent-");
  const originalCwd = process.cwd(), keys = [...GRANT_ENV_KEYS, "PI_CODING_AGENT_DIR", "PI_GRANTS_HERDR"] as const;
  const original = new Map(keys.map(key => [key, process.env[key]]));
  const makePi = () => {
    const hooks = new Map<string, any>();
    return { hooks, api: { on: (name: string, handler: any) => hooks.set(name, handler), registerTool: () => {}, registerCommand: () => {}, getAllTools: () => [{ name: "read" }, { name: "delegate" }] } };
  };
  const start = async (pi: ReturnType<typeof makePi>) => {
    const notices: string[] = [];
    grantsExtension(pi.api as never);
    await pi.hooks.get("session_start")({}, { cwd, mode: "json", ui: { notify: (message: string) => notices.push(message), select: async () => undefined }, modelRegistry: { find: () => undefined } });
    return notices.join("\n");
  };
  try {
    process.chdir(cwd); for (const key of keys) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_GRANTS_HERDR = "0";
    await saveGrant(cwd, ["tool:read", "tool:delegate"]);
    const root = makePi();
    await start(root); // publishes child depth 1
    await root.hooks.get("session_shutdown")({ reason: "reload" });
    const reloadedApi = makePi();
    const reload = await start(reloadedApi);
    assert.match(reload, /depth 0\/2/, "Pi's shutdown/reload lifecycle recovers root identity across a new API object");
    const child = makePi();
    const childStart = await start(child);
    assert.match(childStart, /depth 1\/2/, "a different same-process SDK Pi session remains an inherited child");
  } finally {
    process.chdir(originalCwd); for (const key of keys) { const value = original.get(key); value === undefined ? delete process.env[key] : process.env[key] = value; }
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
    assert.equal(process.env.PI_GRANTS_LEDGER, ledger, "the next child inherits the same absolute ledger");

    const movedCwd = await tempDir("grants-session-moved-");
    const movedLedger = projectLedgerPath(movedCwd);
    session.adoptGrant(["tool:read"], movedLedger);
    assert.equal(
      session.ledgerPath,
      movedLedger,
      "a default this session published itself is not an explicit env override when init chooses the new cwd",
    );
    assert.equal(process.env.PI_GRANTS_LEDGER, movedLedger);

    for (const key of GRANT_ENV_KEYS) delete process.env[key];
    const explicit = `${cwd}/operator.jsonl`;
    process.env.PI_GRANTS_LEDGER = explicit;
    const overridden = createGrantsSession(undefined);
    overridden.adoptGrant(["tool:read"], ledger);
    assert.equal(overridden.ledgerPath, explicit, "init cannot replace an explicit current-session choice");
    assert.equal(process.env.PI_GRANTS_LEDGER, explicit);

    for (const key of GRANT_ENV_KEYS) delete process.env[key];
    process.env.PI_GRANTS_LEDGER = "";
    const disabled = createGrantsSession(undefined);
    disabled.adoptGrant(["tool:read"], ledger);
    assert.equal(disabled.ledgerPath, "", "an explicit empty value remains a one-run opt-out through init");
    assert.equal(process.env.PI_GRANTS_LEDGER, "");
  } finally {
    process.chdir(originalCwd);
    for (const key of keys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
