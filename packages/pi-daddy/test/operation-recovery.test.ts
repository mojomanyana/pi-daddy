import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openOperationArtifacts, readOperationHistory } from "../src/governance/operation-artifacts.ts";
import { readOperationRecovery } from "../src/governance/operation-recovery.ts";
import { openRuntimeSettlement } from "../src/governance/runtime-settlement.ts";
import { runOwnedChild } from "../src/executors/owned-worker.ts";
import { registerOperationRecoveryBridge, OPERATION_RECOVERY_EVENT } from "../extensions/operation-recovery-bridge.ts";
import type { OperationArtifactOutcome } from "../src/kernel/operation-artifact.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture(root: string, id: string, outcome?: Partial<OperationArtifactOutcome>) {
  const owner = { sessionId: "original", cwd: root },
    source = { owner, operationId: id };
  const request = {
    operationId: id,
    executionId: `exec:${id}`,
    requestDigest: "a".repeat(64),
    cwd: root,
    workspaceId: null,
  };
  const store = openOperationArtifacts(root, owner);
  store.admit(request);
  const operation = {
    ...request,
    state: "not-started" as const,
    startedAt: "today",
    updatedAt: "today",
    runtime: { cleanup: { state: "not-started" } },
  };
  const artifact = outcome ? store.finish(request, { operation, ...outcome }) : undefined;
  return { source, request, store, operation, artifact };
}
test("exact historical absence reads create no directories and are not proof of no execution", async () => {
  const root = await tempDir("recovery-absent-");
  const source = { owner: { sessionId: "original", cwd: root }, operationId: "absent" };
  assert.deepEqual(await readdir(root), []);
  assert.equal(readOperationHistory(root, source.owner, source.operationId), null);
  const observation = await readOperationRecovery(root, source);
  assert.equal(observation.admission, "absent");
  assert.equal(observation.result, "absent");
  assert.equal(observation.noStartProven, false);
  assert.equal(observation.cleanup.state, "unknown");
  assert.match(observation.reason!, /absence is not no-start proof/);
  assert.deepEqual(await readdir(root), []);
});
test("only an exact immutable not-started result proves no start and remains a terminal duplicate guard", async () => {
  const root = await tempDir("recovery-no-start-"),
    f = fixture(root, "no-start", {});
  const before = await readFile(f.artifact!.manifest.path, "utf8");
  const observation = await readOperationRecovery(root, f.source);
  assert.equal(observation.admission, "present");
  assert.equal(observation.result, "present");
  assert.equal(observation.noStartProven, true);
  assert.equal(observation.cleanup.state, "not-started");
  assert.deepEqual(observation.artifact, f.artifact);
  assert.equal(observation.operation!.executionId, f.request.executionId);
  assert.equal(f.store.admit(f.request).created, false);
  assert.throws(() => f.store.admit({ ...f.request, requestDigest: "b".repeat(64) }), /identity conflict/);
  assert.equal(await readFile(f.artifact!.manifest.path, "utf8"), before);
});
test("unfinished admission and a cleanup-only no-start journal never prove operation nonexecution", async () => {
  const root = await tempDir("recovery-admission-"),
    f = fixture(root, "pending");
  const journal = await openRuntimeSettlement(root, f.source.owner.sessionId, root);
  {
    journal.begin(f.request.executionId);
    await journal.finish(f.request.executionId, { state: "not-started", reason: "prelaunch interruption" });
    const observation = await readOperationRecovery(root, f.source);
    assert.equal(observation.result, "absent");
    assert.equal(observation.operation!.state, "uncertain");
    assert.equal(observation.cleanup.state, "not-started");
    assert.equal(observation.noStartProven, false);
    assert.equal(observation.final, undefined);
  }
});
test("settled native cleanup preserves interrupted work as uncertain without inventing a final", async () => {
  const root = await tempDir("recovery-cleanup-"),
    f = fixture(root, "interrupted");
  const journal = await openRuntimeSettlement(root, f.source.owner.sessionId, root);
  {
    journal.begin(f.request.executionId);
    const result = await runOwnedChild({
      executionId: f.request.executionId,
      ownershipDir: join(root, "worker"),
      cwd: root,
      command: process.execPath,
      args: ["-e", "process.stdout.write('partial')"],
      env: process.env,
      onOwnership: (identity) => journal.bind(identity),
      timeoutMs: 1000,
    });
    assert.equal(result.cleanup.state, "settled");
    await journal.finish(f.request.executionId, result.cleanup);
    const observation = await readOperationRecovery(root, f.source);
    assert.equal(observation.cleanup.state, "settled");
    assert.equal(observation.operation!.state, "uncertain");
    assert.equal(observation.noStartProven, false);
    assert.equal(observation.final, undefined);
  }
});
test("completed historical final keeps its original attribution and does not imply current cleanup or approval", async () => {
  const root = await tempDir("recovery-final-"),
    text = "Delivered the existing backend; browser work remains open.";
  const f = fixture(root, "complete");
  const final = {
    state: "complete" as const,
    sessionId: "original-child",
    messageId: "answer",
    leafId: "leaf",
    sha256: hash(text),
    text,
  };
  const artifact = f.store.finish(f.request, {
    operation: {
      ...f.operation,
      state: "settled",
      runtime: { work: "succeeded", final, cleanup: { state: "settled", executionId: f.request.executionId } },
    },
    final,
  });
  const observation = await readOperationRecovery(root, f.source);
  assert.equal(observation.result, "present");
  assert.deepEqual(observation.final, final);
  assert.deepEqual(observation.artifact, artifact);
  assert.equal(observation.cleanup.state, "unknown", "recorded settlement alone is not a current receipt check");
  assert.equal(observation.noStartProven, false);
  assert.equal((observation as any).approval, undefined);
  await writeFile(artifact.manifest.path.replace("result.json", "final.txt"), "changed", { mode: 0o600 });
  await assert.rejects(readOperationRecovery(root, f.source), /identity mismatch/);
});
test("conflicting no-start result fields cannot be promoted into no-start proof", async () => {
  const root = await tempDir("recovery-conflict-");
  const conflicting = [
    { work: "succeeded" },
    { work: "failed" },
    { final: { state: "incomplete" } },
    { cleanup: { state: "not-started", executionId: "exec:other" } },
    { cleanup: { state: "not-started", receiptPath: "/tmp/not-authority" } },
  ];
  for (let i = 0; i < conflicting.length; i++) {
    const f = fixture(root, `conflict-${i}`);
    f.store.finish(f.request, {
      operation: { ...f.operation, runtime: { ...f.operation.runtime, ...conflicting[i] } } as any,
    });
    const observation = await readOperationRecovery(root, f.source);
    assert.equal(observation.noStartProven, false);
    assert.equal(observation.cleanup.state, "unknown");
  }
  const partial = fixture(root, "partial", { partial: "Some existing output" });
  assert.equal((await readOperationRecovery(root, partial.source)).noStartProven, false);
});
function bridgeHarness(root: string) {
  const listeners = new Map<string, (v: any) => void>();
  let binding: { owner: { sessionId: string; cwd: string }; agentDirectory: string } | undefined = {
    owner: { sessionId: "current", cwd: root },
    agentDirectory: root,
  };
  const pi = {
    events: {
      on: (name: string, fn: any) => {
        listeners.set(name, fn);
        return () => listeners.delete(name);
      },
    },
  };
  const bridge = registerOperationRecoveryBridge(pi as never, () => binding);
  return {
    bridge,
    listeners,
    change: () => {
      binding = { owner: { sessionId: "replacement", cwd: root }, agentDirectory: root };
    },
    request: (args: any) =>
      new Promise<any>((reply) =>
        listeners.get(OPERATION_RECOVERY_EVENT)!({
          version: 1,
          requestId: "request",
          sessionId: "current",
          cwd: root,
          ...args,
          reply,
        }),
      ),
  };
}
test("historical bridge requires current native binding, same workspace and rechecked trusted authorization", async () => {
  const root = await tempDir("recovery-bridge-"),
    f = fixture(root, "old", {}),
    h = bridgeHarness(root);
  const args = { source: f.source, authorize: async () => {} };
  assert.equal((await h.request({ source: f.source })).code, "authority");
  assert.equal((await h.request({ ...args, sessionId: "original" })).code, "owner-unavailable");
  assert.equal(
    (await h.request({ ...args, source: { ...f.source, owner: { ...f.source.owner, cwd: "/other" } } })).code,
    "invalid-source",
  );
  assert.equal((await h.request({ ...args, authorize: async () => false })).code, "authority");
  let calls = 0;
  const success = await h.request({
    ...args,
    authorize: async () => {
      calls++;
    },
  });
  assert.equal(success.qualified, true);
  assert.equal(calls, 2);
  assert.deepEqual(success.source, f.source);
  assert.equal(success.sessionId, "current");
  assert.equal(success.observation.artifact.owner.sessionId, "original");
  assert.equal(success.observation.noStartProven, true);
  calls = 0;
  const revoked = await h.request({
    ...args,
    authorize: async () => {
      if (++calls === 2) throw Error("private-revocation-detail");
    },
  });
  assert.equal(revoked.code, "authority");
  assert.equal(revoked.observation, undefined);
  assert.doesNotMatch(JSON.stringify(revoked), /private-revocation-detail/);
  const replaced = await h.request({
    ...args,
    authorize: async () => {
      h.change();
    },
  });
  assert.equal(replaced.code, "owner-unavailable");
  assert.equal(replaced.observation, undefined);
  h.bridge.close();
  assert.equal(h.listeners.size, 0);
});
test("a late admission or modified immutable record during authorization cannot disclose a stale recovery observation", async () => {
  const root = await tempDir("recovery-race-"),
    h = bridgeHarness(root);
  const source = { owner: { sessionId: "original", cwd: root }, operationId: "late" };
  let calls = 0;
  const late = await h.request({
    source,
    authorize: async () => {
      if (++calls === 2) fixture(root, "late");
    },
  });
  assert.equal(late.qualified, false);
  assert.equal(late.code, "source-changed");
  assert.equal(late.observation, undefined);
  const f = fixture(root, "modified", {});
  calls = 0;
  const changed = await h.request({
    source: f.source,
    authorize: async () => {
      if (++calls === 2) await writeFile(f.artifact!.manifest.path, "{}", { mode: 0o600 });
    },
  });
  assert.equal(changed.qualified, false);
  assert.equal(changed.code, "source-changed");
  assert.equal(changed.observation, undefined);
  h.bridge.close();
});

test("closing the historical bridge withdraws an in-flight observation", async () => {
  const root = await tempDir("recovery-close-"),
    f = fixture(root, "old", {}),
    h = bridgeHarness(root);
  let calls = 0;
  const result = await h.request({
    source: f.source,
    authorize: async () => {
      if (++calls === 2) h.bridge.close();
    },
  });
  assert.equal(result.qualified, false);
  assert.equal(result.code, "owner-unavailable");
  assert.equal(result.observation, undefined);
});
test("historical routed work cannot disclose content from a different selected workspace", async () => {
  const root = await tempDir("recovery-routed-"),
    h = bridgeHarness(root);
  const owner = { sessionId: "original", cwd: root },
    store = openOperationArtifacts(root, owner);
  const request = {
    operationId: "routed",
    executionId: "exec:routed",
    requestDigest: "c".repeat(64),
    cwd: root,
    workspaceId: "elsewhere",
  };
  store.admit(request);
  store.started(request, "/another-workspace", "elsewhere");
  const result = await h.request({ source: { owner, operationId: "routed" }, authorize: async () => {} });
  assert.equal(result.qualified, false);
  assert.equal(result.code, "invalid-source");
  assert.equal(result.observation, undefined);
  h.bridge.close();
});
