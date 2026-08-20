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

/**
 * Unbanking must take back only what THIS call created.
 *
 * `unbankApprovals` revoked by `capability@subject` with no ownership check, so a refused delegation could
 * destroy an approval a live sibling was running under. Two reachable shapes: a joined gate — one human
 * answer shared by concurrent waiters, each recording it as its own — and a legacy-then-bound sequence,
 * where a bound call re-prompts over a plain key that already exists and then deletes both on refusal.
 *
 * Driven directly because the sequence needs one delegation to SUCCEED while another is refused, which the
 * wiring harness cannot stage without spawning. The production change that breaks it: deleting the
 * `if (!entry.owned) continue;` guard.
 */
test("unbanking leaves alone the authority another delegation banked", async () => {
  const { unbankApprovals } = await import("../extensions/approval-banking.ts");
  const notes: string[] = [];
  const sessionApprovals = new Set<string>(["tool:bash@reviewer", "tool:write@reviewer"]);
  const sessionApprovalBindings = new Map<string, never>();
  let republished = 0;
  const session = {
    cwd: await tempDir("unbank-ownership-"),
    sessionApprovals,
    sessionApprovalBindings,
    definitions: new Map(),
    publishChildEnv: () => { republished += 1; },
  };

  await unbankApprovals(
    session as never,
    { ui: { notify: (message: string) => notes.push(message) } },
    [
      // Ours: created by this call, so it comes back.
      { key: "tool:bash@reviewer", capability: "tool:bash", subject: "reviewer", persisted: false, owned: true },
      // Not ours: a joined dialog, or a key that was already standing. Must survive.
      { key: "tool:write@reviewer", capability: "tool:write", subject: "reviewer", persisted: false, owned: false },
    ],
  );

  assert.equal(sessionApprovals.has("tool:bash@reviewer"), false, "authority this call banked is taken back");
  assert.equal(
    sessionApprovals.has("tool:write@reviewer"),
    true,
    "authority another delegation banked must survive this one's refusal",
  );
  assert.equal(republished, 1, "children must be re-published from the narrowed set exactly once");
  assert.deepEqual(notes, [], "nothing was stranded, so nothing is reported");
});
