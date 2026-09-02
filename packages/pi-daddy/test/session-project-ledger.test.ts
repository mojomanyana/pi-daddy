import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createGrantsSession } from "../extensions/session.ts";
import { projectLedgerPath } from "../src/grant-store.ts";
import { GRANT_ENV_KEYS } from "../src/propagation.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

/**
 * `/grants init` changes the running session as well as the next one.
 *
 * Breaks by: dropping the project-ledger argument in `runInit`, ignoring it in `adoptGrant`, or letting the
 * stored default replace an explicit PI_GRANTS_LEDGER value.
 */
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
