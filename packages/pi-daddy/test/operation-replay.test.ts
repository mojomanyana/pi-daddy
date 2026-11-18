/** Optional owner retry evidence must survive reconstruction without turning missing/foreign data into permission. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { openOperationArtifacts } from "../src/governance/operation-artifacts.ts";
import { readOperationRecovery } from "../src/governance/operation-recovery.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

async function fixture() {
  const root = await tempDir("operation-replay-");
  const owner = { sessionId: "owner", cwd: root };
  const request = {
    operationId: "investigate:one",
    executionId: "exec:one",
    requestDigest: "a".repeat(64),
    cwd: root,
    workspaceId: null,
  };
  const store = openOperationArtifacts(root, owner);
  store.admit(request);
  const operation = {
    operationId: request.operationId,
    executionId: request.executionId,
    cwd: root,
    workspaceId: null,
    state: "settled" as const,
    startedAt: "2026-11-18",
    updatedAt: "2026-11-18",
    runtime: {
      work: "failed" as const,
      final: { state: "unavailable" },
      cleanup: { state: "settled", executionId: request.executionId },
    },
  };
  const reference = store.finish(request, { operation, partial: "Incomplete response" });
  const proof = {
    version: 1 as const,
    eligible: true as const,
    operationId: request.operationId,
    executionId: request.executionId,
    definitionId: "b".repeat(64),
  };
  return { root, owner, request, store, operation, reference, proof };
}

test("replay eligibility is optional private evidence, retained across owner reconstruction without changing the manifest", async () => {
  const f = await fixture();
  const before = await readFile(f.reference.manifest.path, "utf8");
  assert.equal(f.store.history(f.request.operationId)?.operation.runtime?.automaticRetryEligibility, undefined);
  f.store.retainAutomaticRetry(f.request, f.proof);
  const reopened = openOperationArtifacts(f.root, f.owner);
  assert.deepEqual(reopened.history(f.request.operationId)?.operation.runtime?.automaticRetryEligibility, f.proof);
  const recovered = await readOperationRecovery(f.root, { owner: f.owner, operationId: f.request.operationId });
  assert.deepEqual(recovered.operation?.runtime?.automaticRetryEligibility, f.proof);
  assert.equal(await readFile(f.reference.manifest.path, "utf8"), before);
  assert.equal(
    openOperationArtifacts(f.root, { ...f.owner, sessionId: "foreign" }).history(f.request.operationId),
    null,
  );
});

test("wrong owner proof, definition shape and incomplete admissions never become replay eligibility", async () => {
  const f = await fixture();
  for (const bad of [
    { ...f.proof, executionId: "exec:foreign" },
    { ...f.proof, operationId: "other" },
    { ...f.proof, definitionId: "not-a-definition" },
    { ...f.proof, definitionId: [f.proof.definitionId] },
  ])
    assert.throws(() => f.store.retainAutomaticRetry(f.request, bad as never), /retry evidence/);
  const pending = { ...f.request, operationId: "pending", executionId: "exec:pending" };
  f.store.admit(pending);
  assert.throws(
    () =>
      f.store.retainAutomaticRetry(pending, {
        ...f.proof,
        operationId: pending.operationId,
        executionId: pending.executionId,
      }),
    /exact retained owner/,
  );
  assert.equal(f.store.history(f.request.operationId)?.operation.runtime?.automaticRetryEligibility, undefined);
});

test("corrupt or foreign optional retry metadata disables automatic replay while preserving original evidence", async () => {
  const f = await fixture();
  f.store.retainAutomaticRetry(f.request, f.proof);
  const path = join(dirname(f.reference.manifest.path), "automatic-retry.json");
  const good = JSON.parse(await readFile(path, "utf8"));
  for (const text of [
    "not JSON",
    JSON.stringify({ ...good, requestDigest: "f".repeat(64) }),
    JSON.stringify({ ...good, owner: { ...f.owner, sessionId: "foreign" } }),
    JSON.stringify({ ...good, eligibility: { ...f.proof, executionId: "exec:other" } }),
  ]) {
    await writeFile(path, text);
    const history = f.store.history(f.request.operationId)!;
    assert.equal(history.operation.runtime?.automaticRetryEligibility, undefined);
    assert.equal(history.partial?.text, "Incomplete response");
  }
});
