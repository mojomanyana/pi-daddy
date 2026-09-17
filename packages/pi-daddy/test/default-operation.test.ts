import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createGrantsSession, ENV_GOVERNANCE } from "../extensions/session.ts";
import { ENV_GRANT } from "../src/propagation.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("extension defaults to a bounded observed-root governance mode and makes its opt-out explicit", async () => {
  const cwd = await tempDir("default-operation-"), oldCwd = process.cwd();
  const prior = new Map([ENV_GRANT, ENV_GOVERNANCE].map(key => [key, process.env[key]]));
  try {
    process.chdir(cwd); delete process.env[ENV_GRANT]; delete process.env[ENV_GOVERNANCE];
    const defaulted = createGrantsSession(undefined);
    assert.equal(defaulted.governed, true); assert.deepEqual(defaulted.inherited, ["tool:*"]);
    process.env[ENV_GOVERNANCE] = "off";
    const optedOut = createGrantsSession(undefined);
    assert.equal(optedOut.governed, false);
  } finally { process.chdir(oldCwd); for (const [key, value] of prior) value === undefined ? delete process.env[key] : process.env[key] = value; }
});
