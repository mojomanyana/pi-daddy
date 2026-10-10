/** Copied into an isolated prefix by smoke-diagnostics.mjs; every product import is from the actual tarball. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const root = process.cwd(), packageRoot = join(root, "node_modules", "pi-daddy");
const cli = join(packageRoot, "dist", "cli.js");
const requireFromPackage = createRequire(cli);
for (const name of ["typebox/compile", "@earendil-works/pi-coding-agent"])
  assert.throws(() => requireFromPackage.resolve(name), { code: "MODULE_NOT_FOUND" }, `host peer leaked into isolated prefix: ${name}`);
for (let parent = dirname(root); ; parent = dirname(parent)) {
  for (const name of ["typebox", "@earendil-works/pi-coding-agent"])
    assert.equal(existsSync(join(parent, "node_modules", name)), false, `ancestor contains ${name}`);
  if (dirname(parent) === parent) break;
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const session = Buffer.from([
  { type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", cwd: root, timestamp: "2026-10-10T00:00:00Z" },
  { type: "message", id: "a", parentId: null, timestamp: "2026-10-10T00:00:01Z", message: { role: "assistant", content: [
    { type: "thinking", thinking: "PRIVATE_THOUGHT" }, { type: "text", text: "Visible result" },
    { type: "toolCall", id: "call", name: "bash", arguments: { command: "npm test", env: { KEY: "PRIVATE_ENV" } } },
  ] } },
].map((value) => JSON.stringify(value)).join("\n") + "\n");
writeFileSync(join(root, "session.jsonl"), session, { mode: 0o600 });
writeFileSync(join(root, "copy.jsonl"), session);
const rawText = "OPENROUTER_API_KEY=PRIVATE_KEY\npostgresql://user:PRIVATE_PASSWORD@localhost/db\nVisible detail";
writeFileSync(join(root, "details.txt"), rawText);
function run(sources, name, expectedCode, retentionRoots = []) {
  const selection = join(root, `${name}-selection.json`), destination = join(root, name);
  const selected = JSON.stringify({ version: 1, sources, retentionRoots });
  writeFileSync(selection, selected);
  const result = spawnSync(process.execPath, [cli, "diagnostics", "export", selection, destination], {
    cwd: root, env: process.env, encoding: "utf8", timeout: 20000,
  });
  assert.equal(result.status, expectedCode, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  const bytes = readFileSync(receipt.inventory), inventory = JSON.parse(bytes);
  assert.equal(hash(bytes), receipt.sha256);
  assert.equal(inventory.selectionSha256, hash(selected));
  assert.equal(inventory.trainingEligible, false);
  assert.equal(inventory.exportEligible, false);
  assert.equal(inventory.acceptance, "not-assessed");
  assert.equal(statSync(destination).mode & 0o777, 0o700);
  assert.equal(statSync(receipt.inventory).mode & 0o777, 0o600);
  for (const entry of inventory.entries.filter((entry) => entry.status === "included")) {
    const payload = readFileSync(join(destination, entry.path));
    assert.equal(hash(payload), entry.sha256);
    assert.equal(payload.length, entry.bytes);
    assert.equal(statSync(join(destination, entry.path)).mode & 0o777, 0o600);
    assert.doesNotMatch(payload.toString(), /PRIVATE_THOUGHT|PRIVATE_ENV|PRIVATE_KEY|PRIVATE_PASSWORD/);
  }
  return { receipt, inventory, destination };
}
const simple = run([
  { path: "session.jsonl", format: "session", sha256: hash(session) },
  { path: "copy.jsonl", format: "session" },
  { path: "details.txt", format: "text" },
], "simple", 0);
assert.equal(simple.receipt.objects, 2);
assert.equal(simple.receipt.missing, 0);
const entry = simple.inventory.entries.find((entry) => entry.source.endsWith("/session.jsonl"));
assert.equal(entry.sourceSha256, hash(session));
assert.notEqual(entry.sha256, entry.sourceSha256);
assert.match(readFileSync(join(simple.destination, entry.path), "utf8"), /Visible result/);
assert.deepEqual(readFileSync(join(root, "session.jsonl")), session);
assert.equal(readFileSync(join(root, "details.txt"), "utf8"), rawText);

const { beginExecutionRetention } = await import("./node_modules/pi-daddy/dist/governance/execution-retention.js");
const archive = join(root, "archive");
const retention = beginExecutionRetention({
  executionId: "exec:offline-fixture", parentExecutionId: null, childId: "child", toolCallId: "call",
  executor: "process", taskDigest: null, definitionDigest: null, configurationDigest: "a".repeat(64), workspaceId: null,
}, archive);
retention.capture("result", Buffer.from("Visible retained result"));
retention.capture("stdout", Buffer.alloc(1024 * 1024 + 1, 65));
retention.finish({ code: 0, signal: null, timedOut: false, aborted: false, truncated: false, failed: false });
const retained = await retention.flush();
assert.ok(retained.manifestPath);
mkdirSync(join(archive, "invalid"));
writeFileSync(join(archive, "invalid", "manifest.json"), '{"version":"unsupported"}');
writeFileSync(join(root, "mismatch.txt"), "untrusted mismatch payload");
const incomplete = run([
  { path: "absent.txt", format: "text" },
  { path: "mismatch.txt", format: "text", sha256: "0".repeat(64) },
], "incomplete", 1, [archive]);
assert.ok(incomplete.receipt.missing > 0);
for (const reason of ["ENOENT", "source-digest-mismatch", "invalid-retention-manifest", "not-retained"])
  assert.ok(incomplete.inventory.entries.some((entry) => entry.reason === reason), `missing explicit gap: ${reason}`);
assert.ok(incomplete.inventory.entries.some((entry) => entry.reason === "raw-stream-or-pane"));
assert.ok(incomplete.inventory.captures.some((capture) => capture.currentLosses?.includes("stdout-observation-dropped")));
assert.ok(incomplete.inventory.entries.some((entry) => entry.status === "included" && /result-[a-f0-9]{64}\.bin$/.test(entry.source)));
const mismatch = incomplete.inventory.entries.find((entry) => entry.source.endsWith("/mismatch.txt"));
assert.equal(mismatch.path, undefined);
console.log("DIAGNOSTIC_STANDALONE_SMOKE_OK");
