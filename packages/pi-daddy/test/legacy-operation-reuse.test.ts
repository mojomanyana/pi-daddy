/** Old request digests are read compatibility, never permission to dispatch another execution. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { claimDelegationOperation, existingOperationOutcome } from "../extensions/delegation-operations.ts";
import { openOperationArtifacts, readOperationHistory } from "../src/governance/operation-artifacts.ts";
import { registerOperationRecoveryBridge, OPERATION_RECOVERY_EVENT } from "../extensions/operation-recovery-bridge.ts";
import { digestDefinition, type SkillDefinition } from "../src/kernel/definitions.ts";
import type { OperationReference } from "../src/kernel/dispatch-operation.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const canonical = (value: any): any => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
};

async function fixture(state: "complete" | "uncertain" | "failed" = "complete") {
  const dir = await tempDir("legacy-operation-");
  const owner = { sessionId: "original-owner", cwd: dir };
  const store = openOperationArtifacts(dir, owner);
  const definition: SkillDefinition = {
    name: "notes",
    description: "Read project notes",
    allowedTools: "read",
    body: "Read the notes.",
    source: `${dir}/notes/SKILL.md`,
    definitionId: "a".repeat(64),
  };
  const spec = { operation_id: "notes:once", agent: "notes", task: "Read the project notes" };
  const grant = ["tool:read", "tool:delegate", "agent:notes"];
  // Exact pre-#139 layout: no definitionId property in the request; all the other identity fields remain.
  const requestDigest = sha(
    JSON.stringify(
      canonical({
        request: { agent: spec.agent, task: spec.task },
        cwd: dir,
        definitionDigest: digestDefinition(definition),
        grant: [...grant].sort(),
        gated: [],
        depth: 0,
        maxDepth: 2,
        executor: "process",
        definition: definition.body,
        runtimeOverrides: [],
        workspaceRoot: null,
      }),
    ),
  );
  const request = {
    operationId: spec.operation_id,
    executionId: "exec:old",
    requestDigest,
    cwd: dir,
    workspaceId: null,
  };
  store.admit(request);
  const final = {
    state: "complete" as const,
    text: "The previously delivered project note.",
    sessionId: "old-child",
    messageId: "old-message",
    leafId: "old-leaf",
    sha256: sha("The previously delivered project note."),
  };
  const operation: OperationReference = {
    operationId: spec.operation_id,
    executionId: request.executionId,
    cwd: dir,
    workspaceId: null,
    state: "settled",
    startedAt: "2026-11-17T00:00:00Z",
    updatedAt: "2026-11-17T00:01:00Z",
    runtime: { work: "succeeded", final, cleanup: { state: "settled", executionId: request.executionId } },
  };
  if (state === "complete") store.finish(request, { operation, final });
  if (state === "failed")
    store.finish(request, {
      operation: {
        ...operation,
        runtime: { work: "failed", final: { state: "unavailable" }, cleanup: operation.runtime!.cleanup },
      },
      partial: "Partial only",
    });
  let claims = 0;
  let live: OperationReference | null = null;
  const lifecycle: any = {};
  lifecycle.operationFinals = {
    artifacts: store,
    owner: JSON.stringify([owner.sessionId, dir]),
    lifecycle,
    bytes: 0,
    entries: new Map(),
  };
  const session: any = {
    ownerBound: true,
    mayDelegate: true,
    ownGrant: grant,
    gated: [],
    depth: 0,
    maxDepth: 2,
    definitions: new Map([["notes", definition]]),
    definitionRuntimeOverrides: new Map(),
    executor: { kind: "process" },
    reloadLifecycle: lifecycle,
    autoMode: {
      operations: {
        read: async () => live,
        claim: async () => {
          claims++;
          throw Error("unexpected new admission");
        },
      },
    },
    delegationContext: async () => ({
      ownGrant: session.ownGrant,
      gated: session.gated,
      depth: session.depth,
      maxDepth: session.maxDepth,
      definitions: session.definitions,
    }),
  };
  const call = (args: Record<string, any> = spec) =>
    claimDelegationOperation(
      session,
      args as never,
      { executionId: "exec:new", parentId: "d0", childId: "d0.0" } as never,
      { cwd: dir } as never,
    );
  return {
    dir,
    owner,
    store,
    request,
    operation,
    final,
    definition,
    spec,
    session,
    call,
    claims: () => claims,
    setLive: (v: OperationReference) => {
      live = v;
    },
  };
}

test("updating reuses an exact completed legacy ordinary operation without claiming work", async () => {
  const f = await fixture();
  for (const args of [f.spec, { ...f.spec, definitionId: f.definition.definitionId }]) {
    const claim = await f.call(args);
    assert.equal(claim?.reused, true);
    assert.equal(claim?.started, undefined);
    assert.equal(claim?.finish, undefined);
    assert.equal(claim?.operation.executionId, "exec:old");
    assert.equal(claim?.legacyResult?.text, f.final.text);
    const result = existingOperationOutcome(claim!, 1);
    assert.match(result.text, /Historical completed result/);
    assert.match(result.text, /did not capture the full definition identity/);
    assert.equal(result.work, "unknown", "historical delivery is not current acceptance");
  }
  assert.equal(f.claims(), 0);
  assert.equal(
    f.store.history(f.spec.operation_id)?.requestDigest,
    f.request.requestDigest,
    "the old record stays immutable",
  );
});

test("legacy reuse rejects changed requests, foreign scope, failed and uncertain records", async () => {
  const f = await fixture();
  await assert.rejects(f.call({ ...f.spec, task: "Different task" }), /identity conflict/);
  f.session.definitions.set("notes", { ...f.definition, body: "Changed instructions" });
  await assert.rejects(f.call(), /identity conflict/);
  f.session.definitions.set("notes", f.definition);
  f.session.ownGrant = ["tool:read", "tool:delegate"];
  await assert.rejects(f.call());
  assert.equal(f.claims(), 0);
  assert.equal(readOperationHistory(f.dir, { ...f.owner, sessionId: "foreign" }, f.spec.operation_id), null);
  for (const state of ["failed", "uncertain"] as const) {
    const other = await fixture(state);
    await assert.rejects(other.call(), /no complete settled result/);
    assert.equal(other.claims(), 0);
  }
});

test("a live active or conflicting owner cannot be replaced by a legacy completed record", async () => {
  const f = await fixture();
  for (const live of [
    { ...f.operation, state: "running" as const },
    { ...f.operation, state: "uncertain" as const },
    { ...f.operation, executionId: "exec:foreign" },
    { ...f.operation, runtime: { ...f.operation.runtime, control: "failed" as const } },
  ]) {
    f.setLive(live);
    await assert.rejects(f.call(), /owner or live state changed/);
  }
  assert.equal(f.claims(), 0);
});

test("after a new session exact authorized recovery keeps the old completed result and does no work", async () => {
  const f = await fixture();
  const current = { owner: { sessionId: "new-session", cwd: f.dir }, agentDirectory: f.dir };
  const handlers = new Map<string, (r: any) => void>();
  const bridge = registerOperationRecoveryBridge(
    {
      events: {
        on: (name: string, fn: any) => {
          handlers.set(name, fn);
          return () => handlers.delete(name);
        },
      },
    } as never,
    () => current,
  );
  try {
    let authorized = 0;
    const response: any = await new Promise((reply) =>
      handlers.get(OPERATION_RECOVERY_EVENT)!({
        version: 1,
        requestId: "recover-old",
        sessionId: current.owner.sessionId,
        cwd: f.dir,
        source: { owner: f.owner, operationId: f.spec.operation_id },
        authorize: async () => {
          authorized++;
        },
        reply,
      }),
    );
    assert.equal(response.qualified, true);
    assert.equal(response.observation.final.text, f.final.text);
    assert.equal(response.observation.operation.executionId, "exec:old");
    assert.equal(authorized, 2);
    assert.equal(f.claims(), 0);
  } finally {
    bridge.close();
  }
});
