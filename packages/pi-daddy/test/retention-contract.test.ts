import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Compile } from "typebox/compile";
import { buildRetentionContractFiles, writeRetentionContract, checkRetentionContract } from "../scripts/generate-retention-contract.ts";
import { buildExecutionRetentionManifest, parseExecutionRetentionManifest, RETENTION_SCHEMA } from "../src/retention-contract.ts";
import { verifyRetainedBytes } from "../src/execution-retention.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
const fixtures = buildRetentionContractFiles();
const example = () => JSON.parse(fixtures["fixtures/native-live-branch.json"]);

test("retention v2 source builder and published strict schema reject unknown or contradictory facts", () => {
  const validator = Compile(RETENTION_SCHEMA), m = example(); assert.equal(validator.Check(m), true);
  assert.equal(buildExecutionRetentionManifest(m).native.branchLeafId, "aaaaaaaa");
  for (const mutate of [
    (x: any) => x.version = "1.0",
    (x: any) => x.secret = "not-permitted",
    (x: any) => x.native.extra = true,
    (x: any) => x.nativeSession.extra = true,
    (x: any) => x.content.session.extra = true,
    (x: any) => x.acceptance = "accepted",
    (x: any) => x.coverage.complete = true,
    (x: any) => x.content.session.path = "../auth.json",
    (x: any) => x.state = "running",
    (x: any) => x.outcome = null,
  ]) { const bad = example(); mutate(bad); assert.equal(validator.Check(bad), false); assert.throws(() => buildExecutionRetentionManifest(bad)); }
  for (const mutate of [
    (x: any) => x.native.sessionId = "22222222-2222-4222-8222-222222222222",
    (x: any) => x.nativeSession.source = "herdr-path",
    (x: any) => x.content.session.sha256 = "e".repeat(64),
    (x: any) => x.content.session = { status: "missing", path: null, sha256: null, bytes: null },
  ]) { const bad = example(); mutate(bad); assert.throws(() => buildExecutionRetentionManifest(bad)); }
});

test("retention JSON and object builders reject duplicate keys, accessors and hidden array state", () => {
  const source = fixtures["fixtures/native-live-branch.json"];
  assert.throws(() => parseExecutionRetentionManifest(source.replace('"version": "2.0"', '"version":"1.0","version":"2.0"')));
  const accessor = example(); let invoked = false;
  Object.defineProperty(accessor.identity, "toolCallId", { enumerable: true, get() { invoked = true; return "call"; } });
  assert.throws(() => buildExecutionRetentionManifest(accessor)); assert.equal(invoked, false);
  const array = example(); array.coverage.losses.hidden = "unserialized";
  assert.throws(() => buildExecutionRetentionManifest(array), "strict JSON builder rejects extra own array fields");
  const numeric = example(); numeric.native.pid = 1;
  assert.throws(() => parseExecutionRetentionManifest(JSON.stringify(numeric).replace('"pid":1', '"pid":1.000000000000000000001')));
  const m = buildExecutionRetentionManifest(example()); assert.ok(Object.isFrozen(m.nativeSession));
  assert.ok(Object.isFrozen(m.content.session));
});

test("public P03 consumer verifies bytes and never substitutes a manifest digest for missing content", () => {
  const names = Object.keys(fixtures).filter(n => n.endsWith('.json') && n.startsWith('fixtures/'));
  assert.equal(names.length, 6);
  for (const name of names) {
    const m = parseExecutionRetentionManifest(fixtures[name]);
    for (const ref of Object.values(m.content)) {
      assert.equal(verifyRetainedBytes(ref), "missing");
      if (ref.path) {
        const bytes = Buffer.from(fixtures[`fixtures/${ref.path}`]);
        assert.equal(verifyRetainedBytes(ref, bytes), "retained");
        assert.equal(verifyRetainedBytes(ref, Buffer.concat([bytes, Buffer.from('!')])), "mismatch");
      }
    }
    assert.equal(m.acceptance, "not-assessed"); assert.equal(m.coverage.complete, false);
  }
  const live = parseExecutionRetentionManifest(fixtures['fixtures/native-live-branch.json']);
  const unknown = parseExecutionRetentionManifest(fixtures['fixtures/native-file-unknown-branch.json']);
  assert.equal(live.content.session.sha256, unknown.content.session.sha256);
  assert.equal(live.nativeSession.lastPersistedEntryId, "bbbbbbbb");
  assert.equal(live.nativeSession.branchLeafId, "aaaaaaaa"); assert.equal(unknown.nativeSession.branchLeafId, null);
});

test("retention contract generator is explicit and byte-reproducible including complete fixture inventories", async () => {
  const root = await tempDir("retention-contract-");
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL('../scripts/generate-retention-contract.ts', import.meta.url).href)})`],
    { cwd: root, env: { HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: root, PATH: "", PI_OFFLINE: "1" }, encoding: "utf8", timeout: 10000 });
  assert.equal(imported.status, 0, imported.stderr); assert.deepEqual(await readdir(root), []);
  const published = fileURLToPath(new URL('../contracts/execution-retention/v2', import.meta.url));
  await checkRetentionContract(published);
  const publicPath = import.meta.resolve('pi-daddy/contracts/execution-retention/v2/fixtures/native-live-branch.json');
  assert.equal(await readFile(new URL(publicPath), 'utf8'), fixtures['fixtures/native-live-branch.json']);
  const a = join(root, "a"), b = join(root, "b");
  await writeRetentionContract(a); await writeRetentionContract(b); await checkRetentionContract(a); await checkRetentionContract(b);
  for (const [name, bytes] of Object.entries(fixtures)) {
    assert.equal(await readFile(join(a, name), "utf8"), bytes); assert.equal(await readFile(join(b, name), "utf8"), bytes);
  }
  await mkdir(join(a, "fixtures", "unexpected")); await assert.rejects(checkRetentionContract(a), /inventory/);
  assert.deepEqual(await readdir(root), ["a", "b"]);
  await assert.rejects(writeRetentionContract(b), /EEXIST/, "never overwrite an existing target");
});
