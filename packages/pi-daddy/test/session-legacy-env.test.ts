import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { createGrantsSession } from "../extensions/session.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

/**
 * ADR-0076 PR 3b review finding: legacy adoption ran AFTER the session had read the grant, so an operator who
 * still exports PI_GRANTS_GRANT got an ungoverned wildcard root and a warning saying the rename worked. The
 * session constructor must adopt legacy names before its first environment read.
 *
 * Production change that breaks this: moving adoptLegacyEnvironment below the first `environment[...]` read
 * in createGrantsSession, or dropping it from the constructor.
 */
test("a session started with only legacy PI_GRANTS_* names is governed by them, not by a wildcard", async () => {
  const cwd = await tempDir("grants-legacy-env-");
  const saved = { ...process.env };
  const originalCwd = process.cwd();
  try {
    process.chdir(cwd);
    for (const key of Object.keys(process.env))
      if (key.startsWith("PI_DADDY_") || key.startsWith("PI_GRANTS_")) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
    process.env.PI_GRANTS_GRANT = "tool:read,tool:grep";
    process.env.PI_GRANTS_MAX_DEPTH = "1";
    const session = createGrantsSession(undefined);
    assert.deepEqual(session.inherited, ["tool:read", "tool:grep"], "legacy grant governs the root");
    assert.equal(session.maxDepth, 1, "legacy depth bound governs the root");
    assert.ok(session.adoptedLegacyEnv.includes("PI_GRANTS_GRANT"), "the session reports what it adopted");
    assert.equal(process.env.PI_DADDY_GRANT, "tool:read,tool:grep");
  } finally {
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
