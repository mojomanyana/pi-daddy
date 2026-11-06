import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openOperationArtifacts } from "../src/governance/operation-artifacts.ts";
import { openOperationArtifactScan } from "../src/governance/operation-artifact-scan.ts";
import { registerArtifactBridge, OPERATION_ARTIFACTS_EVENT } from "../extensions/artifact-bridge.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
function fixture(root: string, owner: { sessionId: string; cwd: string }, id: string, complete = true) {
  const store = openOperationArtifacts(root, owner);
  const request = {
    operationId: id,
    executionId: `exec:${id}`,
    requestDigest: "a".repeat(64),
    cwd: owner.cwd,
    workspaceId: null,
  };
  store.admit(request);
  if (!complete) return;
  return store.finish(request, {
    operation: { ...request, state: "uncertain", startedAt: "today", updatedAt: "today", runtime: { work: "failed" } },
    partial: "visible interrupted output",
  });
}
test("bounded owner scan recovers missed references, distinguishes unfinished admission and never admits work", async () => {
  const root = await tempDir("artifact-scan-"),
    owner = { sessionId: "owner", cwd: root };
  const refs = [fixture(root, owner, "one"), fixture(root, owner, "two")];
  fixture(root, owner, "pending", false);
  fixture(root, { ...owner, sessionId: "foreign" }, "foreign");
  const scan = openOperationArtifactScan(root, owner);
  let seen: any[] = [],
    uncertain = 0,
    complete = false;
  for (let n = 0; n < 8 && !complete; n++) {
    const page = scan.next(1);
    assert.ok(page.scanned <= 1);
    seen.push(...page.references);
    uncertain += page.uncertain;
    complete = page.complete;
  }
  assert.equal(complete, true);
  assert.equal(uncertain, 1);
  assert.deepEqual(seen.map((x) => x.operationId).sort(), refs.map((x) => x!.operationId).sort());
  assert.throws(() => scan.next(100), /limit/);
  scan.close();
});
test("bridge binds current owner and requires rechecked trusted authorization for historical exact reads", async () => {
  const root = await tempDir("artifact-bridge-"),
    old = { sessionId: "old", cwd: root },
    current = { sessionId: "current", cwd: root };
  const reference = fixture(root, old, "historical")!;
  fixture(root, current, "current");
  const listeners = new Map<string, (v: any) => void>();
  const pi = {
    events: {
      on: (name: string, fn: any) => {
        listeners.set(name, fn);
        return () => listeners.delete(name);
      },
    },
  };
  const binding = { owner: current, agentDirectory: root };
  const bridge = registerArtifactBridge(pi as never, () => binding);
  const request = (args: any) =>
    new Promise<any>((reply) =>
      listeners.get(OPERATION_ARTIFACTS_EVENT)!({
        version: 1,
        requestId: "test",
        sessionId: current.sessionId,
        cwd: current.cwd,
        ...args,
        reply,
      }),
    );
  assert.equal((await request({ action: "list", sessionId: "old" })).ok, false);
  const page = await request({ action: "list", limit: 32 });
  assert.equal(page.references.length, 1);
  assert.equal(page.references[0].operationId, "current");
  assert.equal((await request({ action: "read", reference })).ok, false);
  let calls = 0;
  const read = await request({
    action: "read",
    reference,
    authorize: async () => {
      calls++;
    },
  });
  assert.equal(read.ok, true);
  assert.equal(calls, 2);
  assert.equal(read.partial.text, "visible interrupted output");
  calls = 0;
  const denied = await request({
    action: "read",
    reference,
    authorize: async () => {
      if (++calls === 2) throw Error("revoked-private-message");
    },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.partial, undefined);
  assert.equal(denied.code, "authority");
  assert.equal((await request({ action: "read", reference, producerInstance: "wrong" })).code, "source-changed");
  assert.ok(!JSON.stringify(denied).includes("private-message"));
  bridge.close();
});
