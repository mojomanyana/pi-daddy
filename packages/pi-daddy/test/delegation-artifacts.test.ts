import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { claimWithArtifact } from "../extensions/delegation-artifacts.ts";
import {
  bindOperationFinals,
  finishDelegationOperation,
  operationFinalScope,
} from "../extensions/delegation-operations.ts";
import { createAutoModeAuthority } from "../src/governance/auto-mode-policy.ts";
import {
  registerRuntimeSnapshot,
  OPERATION_HISTORY_EVENT,
  OPERATION_STATUS_EVENT,
} from "../extensions/runtime-snapshot.ts";
import type { GrantsSession } from "../extensions/session.ts";
after(cleanupTempDirs);
const requestFor = (cwd: string) => ({
  operationId: "generic:one",
  requestDigest: "a".repeat(64),
  executionId: "exec:one",
  cwd,
  workspaceId: null,
});
test("restart cannot dispatch a retained uncertain attempt or rewrite its changed request", async () => {
  const root = await tempDir("durable-election-"),
    prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const first = await createAutoModeAuthority({ enabled: false, source: "default" });
  const next = await createAutoModeAuthority({ enabled: false, source: "default" });
  const session = (auto: typeof first) =>
    ({ autoMode: auto, reloadLifecycle: { root: {} } }) as unknown as GrantsSession;
  try {
    const original = session(first);
    bindOperationFinals(original, "parent", root);
    const request = requestFor(root);
    assert.equal((await claimWithArtifact(original, request, () => first.operations!.claim(request))).reused, false);
    await first.close();
    const restarted = session(next);
    bindOperationFinals(restarted, "parent", root);
    let attempts = 0;
    const elect = () => {
      attempts++;
      return next.operations!.claim(request);
    };
    const recovered = await claimWithArtifact(restarted, { ...request, executionId: "exec:replacement" }, elect);
    assert.equal(recovered.reused, true);
    assert.equal(recovered.operation.executionId, "exec:one");
    assert.equal(recovered.operation.state, "uncertain");
    assert.equal(recovered.finish, undefined);
    assert.equal(attempts, 0);
    assert.equal(await next.operations!.read(request.operationId), null);
    await assert.rejects(
      claimWithArtifact(restarted, { ...request, requestDigest: "b".repeat(64) }, elect),
      /identity conflict/,
    );
    assert.equal(attempts, 0);
  } finally {
    await first.close();
    await next.close();
    prior === undefined ? delete process.env.PI_CODING_AGENT_DIR : (process.env.PI_CODING_AGENT_DIR = prior);
  }
});
test("live status carries a durable ref; history remains explicit after owner loss and Pi receives only the ref", async () => {
  const root = await tempDir("durable-bridge-"),
    prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const auto = await createAutoModeAuthority({ enabled: false, source: "default" });
  const listeners = new Map<string, (value: any) => void>(),
    entries: any[] = [];
  const pi = {
    events: {
      on: (name: string, fn: any) => {
        listeners.set(name, fn);
        return () => listeners.delete(name);
      },
    },
    appendEntry: (kind: string, value: any) => entries.push({ kind, value }),
  };
  const session = {
    autoMode: auto,
    ownerBound: true,
    reloadLifecycle: { root: {} },
    executor: { kind: "process" },
    capacity: { reserved: 0 },
  } as unknown as GrantsSession;
  const query = (event: string, sessionId = "parent") =>
    new Promise<any>((reply) =>
      listeners.get(event)!({
        version: 1,
        requestId: "lookup",
        sessionId,
        cwd: root,
        operationId: "generic:one",
        includeFinal: true,
        reply,
      }),
    );
  try {
    await registerRuntimeSnapshot(pi as never, session).bind({
      cwd: root,
      sessionManager: { getSessionId: () => "parent" },
    } as never);
    const request = requestFor(root),
      claim = await claimWithArtifact(
        session,
        request,
        () => auto.operations!.claim(request),
        session.reloadLifecycle.operationFinals,
        { agent: "review", summary: "Check the customer update" },
      );
    const text = "The useful authored result. ".repeat(200);
    const final = {
      state: "complete",
      text,
      sessionId: "child",
      messageId: "message",
      leafId: "leaf",
      sha256: createHash("sha256").update(text).digest("hex"),
    };
    await finishDelegationOperation(
      claim,
      {
        ok: true,
        work: "succeeded",
        text,
        final,
        cwd: root,
        cleanup: { state: "settled", identity: { executionId: request.executionId, receiptPath: "/tmp/receipt" } },
      } as never,
      session,
      operationFinalScope(session),
    );
    const live = await query(OPERATION_STATUS_EVENT);
    assert.equal(live.qualified, true);
    assert.equal(live.final.text, text);
    assert.equal(live.operation.artifact.producer, "pi-daddy");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "pi-daddy:operation-artifact:v1");
    assert.equal(session.dashboardArtifacts?.[0]?.description?.summary, "Check the customer update");
    assert.equal(session.dashboardArtifacts?.[0]?.description?.content, "answer");
    assert.equal(session.dashboardArtifacts?.[0]?.executionId, request.executionId);
    assert.equal(JSON.stringify(entries).includes("Check the customer update"), false);
    assert.ok(JSON.stringify(entries).length < 2000);
    assert.equal(JSON.stringify(entries).includes(text), false);
    const history = await query(OPERATION_HISTORY_EVENT);
    assert.equal(history.history, true);
    assert.equal(history.qualified, undefined);
    assert.equal(history.final.text, text);
    assert.equal(history.operation.artifact.manifest.sha256, live.operation.artifact.manifest.sha256);
    assert.equal((await query(OPERATION_HISTORY_EVENT, "foreign")).operation, null);
    await auto.close();
    assert.equal((await query(OPERATION_STATUS_EVENT)).qualified, false);
    assert.equal((await query(OPERATION_HISTORY_EVENT)).final.text, text);
  } finally {
    await auto.close();
    prior === undefined ? delete process.env.PI_CODING_AGENT_DIR : (process.env.PI_CODING_AGENT_DIR = prior);
  }
});

test("admission race cannot turn the original uncertain attempt into a later local no-start proof", async () => {
  const root = await tempDir("durable-race-"),
    prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const auto = await createAutoModeAuthority({ enabled: false, source: "default" });
  const session = { autoMode: auto, reloadLifecycle: { root: {} } } as unknown as GrantsSession;
  try {
    bindOperationFinals(session, "parent", root);
    const request = { ...requestFor(root), executionId: "exec:loser" };
    const store = session.reloadLifecycle!.operationFinals!.artifacts!;
    let claims = 0;
    const raced = () => {
      claims++;
      return auto.operations!.claim(request).then((claim) => {
        assert.equal(store.admit({ ...request, executionId: "exec:winner" }).created, true);
        return claim;
      });
    };
    await assert.rejects(claimWithArtifact(session, request, raced), /already owns this attempt/);
    assert.equal((await auto.operations!.read(request.operationId))!.state, "not-started");
    const retry = await claimWithArtifact(session, { ...request, executionId: "exec:retry" }, raced);
    assert.equal(retry.operation.executionId, "exec:winner");
    assert.equal(retry.operation.state, "uncertain");
    assert.equal(retry.reused, true);
    assert.equal(retry.finish, undefined);
    assert.equal(claims, 1);
    assert.equal(store.history(request.operationId)!.operation.state, "uncertain");
  } finally {
    await auto.close();
    prior === undefined ? delete process.env.PI_CODING_AGENT_DIR : (process.env.PI_CODING_AGENT_DIR = prior);
  }
});
test("session ownership captured before admission cannot move across an awaited live election", async () => {
  const root = await tempDir("durable-owner-switch-"),
    prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const auto = await createAutoModeAuthority({ enabled: false, source: "default" });
  const session = { autoMode: auto, reloadLifecycle: { root: {} } } as unknown as GrantsSession;
  try {
    bindOperationFinals(session, "parent", root);
    const request = requestFor(root),
      original = session.reloadLifecycle!.operationFinals!;
    await assert.rejects(
      claimWithArtifact(session, request, async () => {
        const claim = await auto.operations!.claim(request);
        bindOperationFinals(session, "new-parent", root);
        return claim;
      }),
      /owner changed during admission/,
    );
    assert.equal((await auto.operations!.read(request.operationId))!.state, "not-started");
    const retained = original.artifacts!.history(request.operationId)!;
    assert.equal(retained.operation.state, "not-started");
    assert.equal(retained.operation.runtime?.cleanup?.state, "not-started");
    assert.equal(retained.artifact?.owner.sessionId, "parent", "cleanup stays with original owner");
    assert.equal(retained.operation.executionId, request.executionId);
    assert.equal(session.reloadLifecycle!.operationFinals!.artifacts!.history(request.operationId), null);
  } finally {
    await auto.close();
    prior === undefined ? delete process.env.PI_CODING_AGENT_DIR : (process.env.PI_CODING_AGENT_DIR = prior);
  }
});
