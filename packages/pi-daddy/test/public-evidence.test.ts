import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test, after } from "node:test";
import { publicEvidenceCall } from "../extensions/public-evidence.ts";
import { registerDefinitionDescribe } from "../extensions/definition-describe.ts";
import { planWithApprovals } from "../extensions/run-delegation.ts";
import { selectedDefinitions } from "../src/kernel/selected-definitions.ts";
import { ENV_PUBLIC_EVIDENCE_DIR, GOVERNANCE_ENV_KEYS } from "../src/kernel/env-names.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { bindReloadLifecycle } from "../extensions/reload-environment.ts";
import { GRANT_ENV_KEYS } from "../src/kernel/propagation.ts";
import { mergeChildEnv } from "../src/kernel/propagation.ts";
import {
  capturePublicEvidence,
  createPublicEvidenceOwner,
  MAX_PUBLIC_EVIDENCE_BYTES,
  MAX_PUBLIC_EVIDENCE_FILES,
} from "../src/products/public-evidence.ts";
import { providerToolOutput } from "./execution-evidence-fixture.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const response = () => ({
  isError: true,
  content: [{ type: "text" as const, text: "exact 🌱\r\n  final\n" }],
  details: { private: "NEVER_STORE_THIS_DETAIL" },
});
const captureStatus = (result: ReturnType<typeof response>) =>
  JSON.parse(result.content.at(-1)!.text.slice("Public evidence capture: ".length));
async function definitionFixture() {
  const root = await tempDir("public-source-");
  await mkdir(join(root, "plain"));
  const path = join(root, "plain", "SKILL.md");
  const bytes = Buffer.from(
    "\ufeff---\r\nname: plain\r\ndescription: test\r\nallowed-tools: read\r\n---\r\n  exact body  \r\n",
  );
  await writeFile(path, bytes);
  const commands = [{ source: "skill", name: "skill:plain", sourceInfo: { path } }];
  return { root, path, bytes, commands };
}
test("capture is off by default, performs no writes and leaves the original return object unchanged", async () => {
  const root = await tempDir("public-off-");
  assert.equal(createPublicEvidenceOwner(undefined), undefined);
  const result = response();
  assert.equal(publicEvidenceCall(undefined, "call", "delegate", []).finish(result), result);
  assert.deepEqual(await readdir(root), []);
  const fixture = await definitionFixture();
  const d = (await selectedDefinitions(fixture.commands)).definitions.get("plain")!;
  assert.equal(d.sourceSnapshot, undefined, "off must not retain source byte copies in memory");
});
test("exact public response survives capture and provider conversion; private details never enter files", async () => {
  const root = await tempDir("public-return-");
  const result = response();
  const output = publicEvidenceCall(
    createPublicEvidenceOwner(root),
    "call-exact",
    "delegate",
    [{ tools: [] } as never],
    ["execution-1"],
  ).finish(result);
  assert.equal(output.details, result.details);
  assert.equal(output.isError, result.isError);
  assert.deepEqual(output.content.slice(0, -1), result.content);
  const status = captureStatus(output);
  assert.equal(status.status, "captured");
  assert.ok(providerToolOutput(output).includes(status.ref.sha256));
  const bytes = await readFile(status.ref.path);
  assert.equal(hash(bytes), status.ref.sha256);
  const manifest = JSON.parse(bytes.toString());
  assert.equal(manifest.schema, "pi-daddy-public-evidence-v1");
  assert.equal(manifest.toolCallId, "call-exact");
  assert.equal(manifest.requested[0].executionId, "execution-1");
  assert.deepEqual(
    manifest.runtimeEvidence.outcomes,
    [],
    "an allocated identity does not establish a started execution",
  );
  const publicBytes = await readFile(manifest.response.path);
  assert.equal(hash(publicBytes), manifest.response.sha256);
  assert.deepEqual(JSON.parse(publicBytes.toString()), { isError: true, content: result.content });
  assert.doesNotMatch(publicBytes.toString(), /NEVER_STORE_THIS_DETAIL/);
  assert.equal((await stat(status.ref.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, manifest.captureId))).mode & 0o777, 0o700);
});
test("describe captures exact admitted source bytes and dispatched body despite later source replacement", async () => {
  const fixture = await definitionFixture(),
    root = await tempDir("public-describe-");
  const selected = await selectedDefinitions(fixture.commands, true);
  const definition = selected.definitions.get("plain")!;
  assert.ok(Object.isFrozen(definition.sourceSnapshot));
  assert.ok(Object.isFrozen(definition.sourceSnapshot!.resources));
  assert.equal(
    definition.sourceHash,
    hash(fixture.bytes.toString().slice(1)),
    "runtime digest preserves its existing BOM-decoding semantics",
  );
  await writeFile(fixture.path, "replaced AFTER selection");
  let tool: any;
  const session: any = {
    ownerBound: true,
    mayDelegate: true,
    ownGrant: ["agent:plain"],
    definitions: selected.definitions,
    publicEvidence: createPublicEvidenceOwner(root),
  };
  registerDefinitionDescribe(
    {
      registerTool: (value: unknown) => {
        tool = value;
      },
    } as never,
    session,
  );
  const result = await tool.execute("describe-1", { agent: "plain" });
  const status = captureStatus(result),
    manifest = JSON.parse(await readFile(status.ref.path, "utf8"));
  assert.equal(manifest.requested[0].definitionId, definition.definitionId);
  const source = manifest.definitions[0];
  assert.equal(source.sourceHash, definition.sourceHash);
  assert.equal(source.resources[0].path, fixture.path);
  assert.deepEqual(
    await readFile(source.resources[0].copy.path),
    fixture.bytes,
    "capture must not reread a changed source path",
  );
  assert.equal(source.resources[0].copy.sha256, hash(fixture.bytes));
  assert.equal(await readFile(source.body.path, "utf8"), "exact body");
  assert.equal(source.body.sha256, source.bodySha256);
  assert.deepEqual(JSON.parse(await readFile(manifest.response.path, "utf8")), {
    isError: false,
    content: result.content.slice(0, -1),
  });
  const entries = await readdir(root);
  session.ownGrant = [];
  await assert.rejects(tool.execute("denied", { agent: "plain" }), /outside this session/);
  assert.deepEqual(
    await readdir(root),
    entries,
    "typed pre-return refusals must not gain a fabricated returned capture",
  );
});
test("definition observation follows the actual planner context, not a stale session map", async () => {
  const fixture = await definitionFixture();
  const definition = (await selectedDefinitions(fixture.commands, true)).definitions.get("plain")!;
  const session: any = {
    publicEvidence: createPublicEvidenceOwner(await tempDir("public-plan-")),
    definitions: new Map(),
    delegationContext: async () => ({
      ownGrant: ["agent:plain", "tool:read"],
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: new Map([["plain", definition]]),
    }),
  };
  const result = await planWithApprovals(session, { task: "read", agent: "plain" }, {}, null);
  assert.equal(result.plan.ok, true);
  assert.equal(result.definition, definition);
  assert.equal(result.plan.definitionHash, definition.sourceHash);
});
test("capture errors preserve work/result and return a loud failed status without a success ref", async () => {
  const result = response();
  for (const path of ["relative", "", "/this-public-evidence-root-does-not-exist"]) {
    const output = publicEvidenceCall(createPublicEvidenceOwner(path), "call", "delegate", []).finish(result);
    assert.equal(output.isError, result.isError);
    assert.equal(output.details, result.details);
    assert.deepEqual(output.content.slice(0, -1), result.content);
    const status = captureStatus(output);
    assert.equal(status.status, "failed");
    assert.equal(status.ref, undefined);
  }
});
test("capture refuses symlinked, non-private and FIFO roots without blocking or following them", async () => {
  const root = await tempDir("public-paths-"),
    actual = join(root, "actual"),
    link = join(root, "link"),
    fifo = join(root, "fifo");
  await mkdir(actual, { mode: 0o700 });
  await symlink(actual, link);
  execFileSync("mkfifo", [fifo]);
  for (const path of [link, fifo, root + "/actual/../actual"]) {
    const output = publicEvidenceCall(createPublicEvidenceOwner(path), "call", "delegate", []).finish(response());
    assert.equal(captureStatus(output).status, "failed");
  }
  assert.deepEqual(await readdir(actual), []);
  await chmod(actual, 0o755);
  const failed = publicEvidenceCall(createPublicEvidenceOwner(actual), "call", "delegate", []).finish(response());
  assert.match(captureStatus(failed).reason, /private/);
});
test("bounded captures never publish a complete manifest after file or byte overflow", async () => {
  const root = await tempDir("public-bounds-"),
    owner = createPublicEvidenceOwner(root)!;
  const base = {
    toolCallId: "bounds",
    tool: "delegate" as const,
    response: response(),
    requested: [],
    runtimeEvidence: null,
    definitions: [],
    finals: [],
  };
  const snapshot = {
    resources: Array.from({ length: MAX_PUBLIC_EVIDENCE_FILES }, () => ({
      kind: "selected-skill" as const,
      path: "/observed/source",
      base64: "eA==",
    })),
    body: "x",
  };
  assert.throws(
    () =>
      capturePublicEvidence(owner, {
        ...base,
        definitions: [
          { agent: "a", definitionId: "id", sourceHash: null, bodySha256: hash("x"), binding: null, snapshot },
        ],
      }),
    /limit/,
  );
  assert.throws(
    () =>
      capturePublicEvidence(owner, {
        ...base,
        response: { isError: false, content: [{ type: "text", text: "x".repeat(MAX_PUBLIC_EVIDENCE_BYTES) }] },
      }),
    /limit/,
  );
  for (const dir of await readdir(root)) assert.ok(!(await readdir(join(root, dir))).includes("manifest.json"));
});
test("public capture opt-in cannot be inherited or supplied by a product child environment hook", () => {
  assert.equal(
    mergeChildEnv({ [ENV_PUBLIC_EVIDENCE_DIR]: "/private/captures" }, {})[ENV_PUBLIC_EVIDENCE_DIR],
    undefined,
  );
  assert.ok(GOVERNANCE_ENV_KEYS.includes(ENV_PUBLIC_EVIDENCE_DIR));
});

test("replanning clears an earlier observed definition identity while preserving the original requested identity", async () => {
  const fixture = await definitionFixture(),
    root = await tempDir("public-replan-");
  const d = (await selectedDefinitions(fixture.commands, true)).definitions.get("plain")!;
  const call = publicEvidenceCall(createPublicEvidenceOwner(root), "replanned", "delegate", [
    { agent: "plain", definitionId: "requested-original" },
  ]);
  call.selected(0, d);
  call.selected(0, undefined);
  const output = call.finish(response());
  const status = captureStatus(output),
    manifest = JSON.parse(await readFile(status.ref.path, "utf8"));
  assert.equal(manifest.requested[0].requestedDefinitionId, "requested-original");
  assert.equal(manifest.requested[0].definitionId, null);
  assert.deepEqual(manifest.definitions, []);
});

test("only complete attributed public finals receive byte-identical per-child copies", async () => {
  const root = await tempDir("public-finals-"),
    text = "exact final 🌱\r\n  ";
  const result = { isError: false, content: [{ type: "text" as const, text }], details: { never: "secret" } };
  const final = {
    state: "complete" as const,
    text,
    sessionId: "session",
    messageId: "message",
    leafId: "leaf",
    sha256: hash(text),
  };
  const outcome = { ok: true, text: "not the source of final bytes", granted: [], depth: 1, exitCode: 0, final };
  const call = () => publicEvidenceCall(createPublicEvidenceOwner(root), "final-call", "delegate", [{}], ["exec"]);
  const captured = call().finish(result, [outcome]),
    status = captureStatus(captured as any);
  assert.equal(status.status, "captured");
  const manifest = JSON.parse(await readFile(status.ref.path, "utf8")),
    saved = manifest.finals[0];
  assert.equal(saved.ordinal, 1);
  assert.equal(saved.executionId, "exec");
  const { text: _text, ...metadata } = final;
  const { content: _content, ...savedMetadata } = saved.final;
  assert.deepEqual(savedMetadata, metadata);
  assert.equal(await readFile(saved.final.content.path, "utf8"), text);
  assert.equal(saved.final.content.sha256, final.sha256);
  const mismatch = call().finish(result, [{ ...outcome, final: { ...final, sha256: "0".repeat(64) } }]);
  assert.equal(captureStatus(mismatch as any).status, "failed");
  assert.deepEqual(mismatch.content.slice(0, -1), result.content);
  const hidden = call().finish({ ...result, content: [{ type: "text", text: "different public output" }] }, [outcome]);
  assert.equal(captureStatus(hidden as any).status, "failed", "complete hidden details are not a public response");
  const unavailable = call().finish(result, [
    { ...outcome, final: { state: "unavailable", reason: "missing", diagnosticText: "PRIVATE_PARTIAL" } },
  ]);
  const absentManifest = JSON.parse(await readFile(captureStatus(unavailable as any).ref.path, "utf8"));
  assert.deepEqual(absentManifest.finals, [{ ordinal: 1, executionId: "exec", final: null }]);
});

test("owner-bound capture survives reload, stays isolated, and honors explicit replacement and off", async () => {
  const saved = new Map(GRANT_ENV_KEYS.map((key) => [key, process.env[key]]));
  const firstRoot = await tempDir("public-reload-first-"),
    nextRoot = await tempDir("public-reload-next-");
  const owner = {};
  const bound = (session: ReturnType<typeof createGrantsSession>, actualOwner: object) => {
    const binding = bindReloadLifecycle(actualOwner, session.reloadLifecycle);
    session.reconcileEnvironment(binding.environment, binding.lifecycle);
    return session;
  };
  try {
    for (const key of GRANT_ENV_KEYS) delete process.env[key];
    process.env[ENV_PUBLIC_EVIDENCE_DIR] = firstRoot;
    const first = bound(createGrantsSession(undefined), owner);
    assert.equal(first.publicEvidence?.directory, firstRoot);
    const pending = publicEvidenceCall(first.publicEvidence, "pending-original", "delegate", []);
    first.publishChildEnv();
    assert.equal(process.env[ENV_PUBLIC_EVIDENCE_DIR], undefined);
    const reloaded = bound(createGrantsSession(undefined), owner);
    assert.equal(reloaded.publicEvidence?.directory, firstRoot);
    assert.notEqual(reloaded.publicEvidence?.ownerId, first.publicEvidence?.ownerId);
    const unrelated = bound(createGrantsSession(undefined), {});
    assert.equal(unrelated.publicEvidence, undefined, "an unrelated owner must not acquire the first owner's opt-in");
    process.env[ENV_PUBLIC_EVIDENCE_DIR] = nextRoot;
    const replaced = bound(createGrantsSession(undefined), owner);
    assert.equal(replaced.publicEvidence?.directory, nextRoot);
    replaced.publishChildEnv();
    process.env[ENV_PUBLIC_EVIDENCE_DIR] = "off";
    const disabled = bound(createGrantsSession(undefined), owner);
    assert.equal(disabled.publicEvidence, undefined);
    disabled.publishChildEnv();
    assert.equal(bound(createGrantsSession(undefined), owner).publicEvidence, undefined);
    const original = captureStatus(pending.finish(response()));
    assert.equal(original.status, "captured");
    assert.ok(
      original.ref.path.startsWith(firstRoot + "/"),
      "pending calls retain their originally selected owner root",
    );
    assert.deepEqual(await readdir(nextRoot), []);
  } finally {
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
