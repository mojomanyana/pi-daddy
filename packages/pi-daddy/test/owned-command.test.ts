/** Actual helper regression for accidental ancestor matches; all signals stay inside this fixture's session. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAutoModeAuthority, connectAutoMode } from "../src/governance/auto-mode-policy.ts";
import { runOwnedChild } from "../src/executors/owned-worker.ts";
import { ownedCleanupFixture } from "./owned-cleanup-fixture.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);

test("private command transport preserves literal arguments while the gated helper argv excludes them", async () => {
  const root = await tempDir("owned-command-");
  const values = ["", "@not-a-file", "--not-a-flag", "line one\nline two", "literal ' \" $() 🙂"];
  const code = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
  const result = await runOwnedChild({
    command: process.execPath,
    args: ["-e", code, "--", ...values],
    executionId: "literal-command",
    ownershipDir: join(root, "owner"),
    cwd: root,
    env: process.env,
    async onOwnership(identity) {
      const argv = await readFile(`/proc/${identity.helperPid}/cmdline`, "utf8");
      assert(!argv.includes(code));
      assert(!argv.includes("@not-a-file"));
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.cleanup.state, "settled");
  assert.deepEqual(JSON.parse(result.text), values);
});

for (const mode of ["pattern", "pid"] as const)
  test(`${mode} service cleanup keeps the owned worker/helper alive until an eligible final`, async () => {
    const observed = await ownedCleanupFixture(await tempDir("owned-cleanup-"), mode);
    const selection = observed.events.find((event) => event.event === "cleanup-selection");
    assert.equal(selection.helperArgvContainsSelector, false);
    assert.equal(selection.workerArgvContainsSelector, false);
    assert.deepEqual(selection.matched, [selection.servicePid]);
    assert.equal(
      observed.events.some((event) => event.event === "worker-signal"),
      false,
    );
    assert.equal(observed.events.find((event) => event.event === "worker-continued").helperAlive, true);
    assert.equal(observed.result.code, 0);
    assert.equal(observed.result.final.state, "complete");
    assert.equal(observed.result.cleanup.state, "settled");
    if (observed.result.cleanup.state === "settled")
      assert.equal(observed.result.cleanup.receipt.reason, "worker-exit");
  });

test("interrupted exit-zero child remains unavailable; reconnecting the same operation does not repeat work", async () => {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  const root = await tempDir("owned-interruption-");
  const input = {
    operationId: "cleanup:interrupted",
    requestDigest: "a".repeat(64),
    executionId: "exec:interrupted",
    cwd: root,
    workspaceId: null,
  };
  let launches = 0;
  async function attempt(client: Pick<typeof owner, "operations">) {
    const claim = await client.operations!.claim(input);
    if (claim.reused) return claim;
    launches++;
    await claim.started!(root, null);
    const observed = await ownedCleanupFixture(root, "interrupt", claim.operation.executionId);
    assert.equal(observed.result.code, 0);
    assert.equal(observed.result.final.state, "unavailable");
    assert.equal(observed.result.cleanup.state, "settled");
    if (observed.result.cleanup.state !== "settled") assert.fail("missing cleanup");
    assert.equal(observed.result.cleanup.receipt.reason, "helper-signal");
    assert.equal(observed.result.cleanup.receipt.reapedAll, true);
    assert(observed.events.some((event) => event.event === "worker-signal" && event.signal === "SIGTERM"));
    await claim.finish!("settled", {
      work: "unknown",
      final: { state: "unavailable" },
      cleanup: {
        state: "settled",
        executionId: claim.operation.executionId,
        receiptPath: observed.result.cleanup.identity.receiptPath,
      },
    });
    return claim;
  }
  const reconnect = connectAutoMode(owner.reference);
  try {
    const first = await attempt(owner);
    const again = await attempt(reconnect);
    assert.equal(launches, 1);
    assert.equal(again.reused, true);
    assert.equal(again.operation.executionId, first.operation.executionId);
    assert.equal(again.operation.runtime?.work, "unknown");
    assert.equal(again.operation.runtime?.final?.state, "unavailable");
    assert.equal(again.finish, undefined);
  } finally {
    await reconnect.close();
    await owner.close();
  }
});

for (const args of [["contains\0nul"], ["x".repeat(2 * 1024 * 1024)], Array(65536).fill("")])
  test(`invalid command payload refuses before ownership (${args.length} args, ${args[0].length} first bytes)`, async () => {
    const root = await tempDir("owned-invalid-command-");
    const result = await runOwnedChild({
      command: process.execPath,
      args,
      cwd: root,
      env: process.env,
      executionId: "invalid-command",
      ownershipDir: join(root, "owner"),
    });
    assert.equal(result.cleanup.state, "not-started");
    assert.match(result.spawnError!, /worker command/);
  });
