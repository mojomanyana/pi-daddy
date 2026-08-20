/**
 * A refused delegation must not leave authority behind.
 *
 * `extensions/run-delegation.ts` documents this rule at length and moved the executor check *above* the
 * gate to honour it — an operator was being asked to approve `tool:bash`, answering *Always*, and then
 * refused anyway, with the answer still reaching `PI_GRANTS_APPROVED` and still writing a 30-day
 * project-wide entry for a child that never existed.
 *
 * The adjacent path kept the defect (R-113). The load-bearing ledger append happens AFTER the gate, and a
 * failure there denies the delegation — a lock timeout under fan-out is a documented condition, so this
 * needs no adversary. The banked authority survived the refusal, and nothing told the operator.
 *
 * **The production change that breaks this test:** delete the `unbankApprovals` call from the `!plan.ok`
 * branch in `run-delegation.ts`, or stop recording `banked` in `obtainApprovals`.
 *
 * A directory at the ledger path is the failure injection — `appendFile` gets EISDIR — which is the same
 * trick `test/workspace-runtime.test.ts` uses for R-90 and `test/file-lock.test.ts` for a non-EEXIST open.
 */

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { ENV_APPROVED, ENV_GATED, ENV_GRANT, ENV_LEDGER } from "../src/propagation.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { harness, restoreEnv } from "./chain-harness.ts";

after(cleanupTempDirs);
afterEach(restoreEnv);

test("a delegation refused AFTER the gate gives back the authority it banked", async () => {
  // Not a file: every append fails, so the decision is recorded nowhere and the delegation fails closed.
  const ledgerDirectory = await tempDir("unbank-bad-ledger-");
  const { tools, ctx } = await harness(
    {
      [ENV_GRANT]: "tool:read,tool:bash,tool:delegate",
      [ENV_GATED]: "tool:bash",
      [ENV_LEDGER]: ledgerDirectory,
    },
    undefined,
    "allow-session",
  );

  assert.equal(
    (process.env[ENV_APPROVED] ?? "").includes("tool:bash"),
    false,
    "precondition: nothing is approved before the gate runs",
  );

  await assert.rejects(
    () => tools.get("delegate")!.execute(
      "c",
      { task: "read one file and report", tools: ["read", "bash"] },
      undefined,
      undefined,
      ctx,
    ),
    /ledger write failed/,
    "an unrecorded provisioning decision must fail closed",
  );

  // The human said yes, the operation was refused, so the yes must not still be standing. Without the
  // unwind this reads `tool:bash@<delegate>` and every later child inherits it.
  assert.equal(
    (process.env[ENV_APPROVED] ?? "").includes("tool:bash"),
    false,
    "a refused delegation must not leave a session approval published to children",
  );
});
