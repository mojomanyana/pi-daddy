import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { after, test } from "node:test";
import { createGrantsSession } from "../extensions/session.ts";
import { grantStorePath, projectLedgerPath } from "../src/grant-store.ts";
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
