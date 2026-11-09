import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { retainedInitiativeHandoff } from "../extensions/initiative-handoff.ts";
import { openOperationArtifacts, readOperationArtifact } from "../src/governance/operation-artifacts.ts";
import type { OperationArtifactOutcome } from "../src/kernel/operation-artifact.ts";
after(cleanupTempDirs);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const identity = (cwd: string) => ({
  operationId: "role:one",
  executionId: "exec:one",
  requestDigest: "a".repeat(64),
  cwd,
  workspaceId: null,
});
function outcome(cwd: string, text = "Exact authored result\n"): OperationArtifactOutcome {
  const final = {
    state: "complete" as const,
    text,
    sessionId: "child",
    messageId: "message",
    leafId: "leaf",
    sha256: hash(text),
  };
  return {
    operation: {
      operationId: "role:one",
      executionId: "exec:one",
      cwd,
      workspaceId: null,
      state: "settled",
      startedAt: "2026-11-04T00:00:00.000Z",
      updatedAt: "2026-11-04T00:01:00.000Z",
      runtime: { work: "succeeded", final: { ...final, text: undefined } as never, cleanup: { state: "settled" } },
    },
    final,
  };
}
const moduleUrl = new URL("../src/governance/operation-artifacts.ts", import.meta.url).href;
test("generic exact result resolves in a fresh process without Principal; references and reads never grant authority", async () => {
  const root = await tempDir("operation-artifact-");
  const owner = { sessionId: "parent", cwd: root },
    request = identity(root);
  const store = openOperationArtifacts(root, owner);
  assert.equal(store.admit(request).created, true);
  const ref = store.finish(request, outcome(root));
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {readOperationArtifact} from ${JSON.stringify(moduleUrl)}; const r=readOperationArtifact(${JSON.stringify(ref)},{agentDirectory:${JSON.stringify(root)}}); console.log(JSON.stringify(r));`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  const recovered = JSON.parse(child.stdout);
  assert.equal(recovered.final.text, outcome(root).final!.text);
  assert.equal(recovered.manifest.operation.runtime.work, "succeeded");
  assert.equal(recovered.approval, undefined);
  assert.equal(recovered.qualified, undefined);
  assert.deepEqual(store.finish(request, outcome(root)), ref, "same exact publication reuses immutable content");
  assert.equal(store.admit(request).created, false);
  assert.throws(() => store.admit({ ...request, requestDigest: "b".repeat(64) }), /identity conflict/);
});
test("interrupted admission remains uncertain; concurrent processes elect one immutable attempt", async () => {
  const root = await tempDir("operation-interrupt-"),
    owner = { sessionId: "parent", cwd: root };
  const script = (executionId: string) =>
    `import {openOperationArtifacts} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(openOperationArtifacts(${JSON.stringify(root)},${JSON.stringify(owner)}).admit(${JSON.stringify({ ...identity(root), executionId })})));`;
  const run = (id: string) =>
    new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script(id)]);
      let out = "",
        err = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.on("data", (b) => (err += b));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(Error(err))));
    });
  const results = await Promise.all([run("exec:one"), run("exec:two")]);
  assert.equal(results.filter((r) => r.created).length, 1);
  const history = openOperationArtifacts(root, owner).history("role:one")!;
  assert.equal(history.operation.state, "uncertain");
  assert.equal(history.artifact, undefined);
  assert.match(history.reason!, /no retry or no-start proof/);
  assert.equal(history.final, undefined);
  assert.equal(openOperationArtifacts(root, { ...owner, sessionId: "fork" }).history("role:one"), null);
});
test("failed and cancelled work preserves its evidence without promoting partial output to a final", async () => {
  const root = await tempDir("operation-partial-"),
    owner = { sessionId: "parent", cwd: root },
    request = identity(root);
  const store = openOperationArtifacts(root, owner);
  store.admit(request);
  const failed = outcome(root);
  failed.operation.runtime!.work = "failed";
  const ref = store.finish(request, failed);
  assert.equal(readOperationArtifact(ref, { agentDirectory: root }).manifest.operation.runtime!.work, "failed");
  const cancelled = { ...request, operationId: "cancelled", executionId: "exec:cancelled" };
  store.admit(cancelled);
  const partial = {
    operation: {
      ...failed.operation,
      ...cancelled,
      state: "uncertain" as const,
      runtime: { work: "unknown" as const },
    },
    partial: "Stopped before the final.",
  };
  const stopped = store.finish(cancelled, partial);
  const read = readOperationArtifact(stopped, { agentDirectory: root });
  assert.equal(read.final, undefined);
  assert.equal(read.partial!.text, partial.partial);
  assert.equal(read.manifest.operation.state, "uncertain");
});
test("exact reads reject mutation, wrong owners, symlink substitutions and byte-limit violations", async () => {
  const root = await tempDir("operation-invalid-"),
    owner = { sessionId: "parent", cwd: root },
    request = identity(root);
  const store = openOperationArtifacts(root, owner);
  store.admit(request);
  const ref = store.finish(request, outcome(root));
  assert.throws(() => readOperationArtifact(ref, { agentDirectory: root, maxBytes: 2 }), /oversized/);
  assert.throws(
    () => readOperationArtifact({ ...ref, owner: { ...owner, sessionId: "other" } }, { agentDirectory: root }),
    /path does not match/,
  );
  const bytes = await readFile(ref.manifest.path, "utf8");
  await writeFile(ref.manifest.path, bytes + " ");
  assert.throws(() => readOperationArtifact(ref, { agentDirectory: root }), /identity mismatch/);
  await writeFile(ref.manifest.path, bytes);
  const manifest = JSON.parse(bytes);
  await writeFile(manifest.final.content.path, "changed");
  assert.throws(() => readOperationArtifact(ref, { agentDirectory: root }), /identity mismatch/);
  const target = join(root, "alias");
  await symlink(root, target);
  assert.throws(
    () =>
      readOperationArtifact(
        { ...ref, manifest: { ...ref.manifest, path: join(target, "unrelated") } },
        { agentDirectory: root },
      ),
    /path does not match/,
  );
});

test("routed scope is immutable and historical uncertainty keeps its admitted workspace", async () => {
  const root = await tempDir("operation-scope-"),
    child = await tempDir("operation-child-"),
    owner = { sessionId: "parent", cwd: root },
    request = { ...identity(root), workspaceId: "pilot" };
  const store = openOperationArtifacts(root, owner);
  store.admit(request);
  store.started(request, child, "pilot");
  const uncertain = store.history(request.operationId)!;
  assert.equal(uncertain.operation.cwd, child);
  assert.equal(uncertain.operation.workspaceId, "pilot");
  assert.equal(uncertain.operation.state, "uncertain");
  assert.equal(uncertain.operation.runtime, undefined);
  assert.throws(() => store.started(request, root, "pilot"), /identity mismatch/);
  assert.throws(() => store.started(request, child, "other"), /admitted request/);
  const completed = outcome(child);
  completed.operation.workspaceId = "pilot";
  assert.throws(
    () => store.finish(request, { ...completed, operation: { ...completed.operation, cwd: root } }),
    /result scope/,
  );
  assert.throws(
    () => store.finish(request, { ...completed, operation: { ...completed.operation, workspaceId: "other" } }),
    /result scope/,
  );
  const reordered = {
    workspaceId: request.workspaceId,
    cwd: request.cwd,
    requestDigest: request.requestDigest,
    executionId: request.executionId,
    operationId: request.operationId,
  };
  const reference = store.finish(reordered, completed);
  assert.equal(readOperationArtifact(reference, { agentDirectory: root }).manifest.operation.cwd, child);
  assert.deepEqual(store.finish(request, completed), reference);

  const local = { ...identity(root), operationId: "local", executionId: "exec:local" };
  store.admit(local);
  assert.throws(() => store.started(local, child, null), /admitted request/);
  assert.throws(
    () => store.finish(local, { operation: { ...completed.operation, ...local, cwd: child } }),
    /result scope/,
  );
});

test("a reviewable handoff pins a successful final, checks the selection on every read and withholds bodies from metadata", async () => {
  const root = await tempDir("handoff-final-");
  const owner = { sessionId: "parent", cwd: root },
    request = identity(root);
  const store = openOperationArtifacts(root, owner);
  const attempt = { ...request, owner, state: "pending" as const };
  let allowed = true;
  const authorize = async (scope: { cwd: string; workspaceId: string | null }) => {
    assert.equal(scope.cwd, root);
    assert.equal(scope.workspaceId, null);
    if (!allowed) throw Error("selection revoked");
  };
  store.admit(request);
  assert.equal(await retainedInitiativeHandoff(root, attempt, authorize), undefined);
  const result = outcome(root);
  result.operation.runtime!.cleanup!.executionId = request.executionId;
  const ref = store.finish(request, result);
  const access = await retainedInitiativeHandoff(root, attempt, authorize);
  assert.ok(access);
  assert.equal(await access.readText(), result.final!.text);
  assert.equal(access.reference.reference.manifestSha256, ref.manifest.sha256);
  assert.equal(access.reference.reference.finalSha256, result.final!.sha256);
  assert.ok(!JSON.stringify(access.reference).includes(result.final!.text.trim()));
  assert.ok(!JSON.stringify(access.reference).includes(root));
  assert.equal(
    await retainedInitiativeHandoff(root, { ...attempt, requestDigest: "c".repeat(64) }, authorize),
    undefined,
  );
  allowed = false;
  await assert.rejects(access.readText, /revoked/);
  allowed = true;
  const raw = readOperationArtifact(ref, { agentDirectory: root });
  await writeFile(raw.manifest.final!.content.path, "changed after retention");
  await assert.rejects(access.assertCurrent);
});

test("settlement with a failed job, incomplete cleanup, or partial answer never supplies a reviewable handoff", async () => {
  for (const kind of ["failed", "control", "cleanup", "partial"]) {
    const root = await tempDir("handoff-invalid-");
    const owner = { sessionId: "parent", cwd: root },
      request = identity(root);
    const store = openOperationArtifacts(root, owner),
      result = outcome(root);
    result.operation.runtime!.cleanup!.executionId = request.executionId;
    if (kind === "failed") result.operation.runtime!.work = "failed";
    if (kind === "control") result.operation.runtime!.control = "failed";
    if (kind === "cleanup") result.operation.runtime!.cleanup!.executionId = "exec:other";
    if (kind === "partial") {
      delete result.final;
      delete result.operation.runtime!.final;
      result.partial = "draft";
    }
    store.admit(request);
    store.finish(request, result);
    assert.equal(
      await retainedInitiativeHandoff(root, { ...request, owner, state: "pending" }, async () => {}),
      undefined,
      kind,
    );
  }
});
