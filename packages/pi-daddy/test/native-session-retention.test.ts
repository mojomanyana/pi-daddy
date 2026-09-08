import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, readFile, writeFile, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { tempDir } from "./tmp.ts";
import { readNativeSession, parseNativeSessionBytes, ENV_NATIVE_SESSION_ROOT, herdrSessionReference } from "../src/native-session.ts";
import { beginExecutionRetention, drainExecutionRetention, parseExecutionRetentionManifest } from "../src/execution-retention.ts";
import { runHerdrPane } from "../src/run-herdr.ts";
import { executePlannedChild } from "../extensions/execute-child.ts";
import { planDelegation } from "../src/delegate.ts";
import { pathToFileURL } from "node:url";
const identity = { executionId: "exec:fixture", parentExecutionId: "exec:parent", childId: "reused", toolCallId: "call:exact",
  executor: "herdr" as const, taskDigest: "a".repeat(64), definitionDigest: null, configurationDigest: "b".repeat(64), workspaceId: null };
const outcome = { code: 0, signal: null, timedOut: false, aborted: false, truncated: false, failed: false };
function assistant() { return { role: "assistant" as const, content: [{ type: "text" as const, text: "native fixture; no model called" }],
  api: "openai-responses" as const, provider: "fixture", model: "fixture", stopReason: "stop" as const, timestamp: 1788888888000,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; }
async function native() {
  const root = await tempDir("native-session-"); await chmod(root, 0o700);
  const manager = SessionManager.create(root, root);
  const first = manager.appendMessage({ role: "user", content: "fixture", timestamp: 1788888888000 });
  const last = manager.appendMessage(assistant());
  return { root, manager, path: manager.getSessionFile()!, first, last };
}

test("installed SessionManager creates real header and parent linkage without any model runtime", async () => {
  const f = await native(); const raw = await readFile(f.path);
  const header = JSON.parse(raw.toString().split("\n")[0]); assert.deepEqual(header, JSON.parse(JSON.stringify(f.manager.getHeader())));
  const parsed = await readNativeSession({ path: f.path, source: "pi-session-file", allowedRoot: f.root });
  assert.equal(parsed.observation.status, "verified"); assert.equal(parsed.observation.sessionId, f.manager.getSessionId());
  assert.deepEqual(parsed.bytes, raw); assert.equal(parsed.observation.lastPersistedEntryId, f.last);
  assert.equal(parsed.observation.branchState, "unknown"); assert.equal(parsed.observation.branchLeafId, null);
  f.manager.newSession({ parentSession: f.path }); f.manager.appendMessage(assistant());
  const child = await readNativeSession({ path: f.manager.getSessionFile()!, source: "pi-session-manager", manager: f.manager, allowedRoot: f.root });
  assert.equal(child.observation.parentSessionPath, f.path); assert.notEqual(child.observation.sessionId, parsed.observation.sessionId);
});

test("a live native branch can differ from the identical persisted session bytes", async () => {
  const f = await native(), raw = await readFile(f.path);
  f.manager.branch(f.first);
  assert.deepEqual(await readFile(f.path), raw, "native branch() does not persist the leaf pointer");
  const unknown = await readNativeSession({ path: f.path, source: "pi-session-file", allowedRoot: f.root });
  assert.equal(unknown.observation.branchLeafId, null);
  const live = await readNativeSession({ path: f.path, source: "pi-session-manager", manager: f.manager, allowedRoot: f.root });
  assert.equal(live.observation.branchState, "observed"); assert.equal(live.observation.branchLeafId, f.first);
  assert.equal(live.observation.lastPersistedEntryId, f.last);
  f.manager.resetLeaf();
  const reset = await readNativeSession({ path: f.path, source: "pi-session-manager", manager: f.manager, allowedRoot: f.root });
  assert.equal(reset.observation.branchState, "observed"); assert.equal(reset.observation.branchLeafId, null);
});

test("missing, partial, invalid-parent and duplicate native bytes stay explicitly incomplete", async () => {
  const f = await native(), raw = await readFile(f.path);
  const missing = await readNativeSession({ path: join(f.root, "absent.jsonl"), source: "herdr-path", allowedRoot: f.root });
  assert.equal(missing.observation.status, "missing"); assert.equal(missing.bytes, undefined);
  const interruptedUtf8 = Buffer.concat([raw, Buffer.from('{"type":"message","text":"'), Buffer.from([0xe4, 0xbd])]);
  const interrupted = parseNativeSessionBytes(interruptedUtf8, { path: f.path, source: "herdr-path" });
  assert.deepEqual(interrupted.bytes, interruptedUtf8, "a valid native header admits the interrupted raw bytes without lossy decoding");
  assert.equal(interrupted.observation.status, "truncated");
  const partial = parseNativeSessionBytes(raw.subarray(0, -2), { path: f.path, source: "herdr-path" });
  assert.equal(partial.observation.status, "truncated"); assert.equal(partial.observation.branchLeafId, null); assert.ok(partial.bytes);
  const bad = Buffer.from(raw.toString() + JSON.stringify({ type: "message", id: "new", parentId: "absent", timestamp: new Date().toISOString() }) + "\n");
  assert.equal(parseNativeSessionBytes(bad, { path: f.path, source: "herdr-path" }).observation.status, "invalid");
  const duplicate = raw.toString().replace('"version":3', '"version":2,"version":3');
  assert.equal(parseNativeSessionBytes(Buffer.from(duplicate), { path: f.path, source: "herdr-path" }).bytes, undefined);
  assert.equal(parseNativeSessionBytes(raw, { path: f.path, source: "herdr-path", expectedSessionId: "other" }).observation.status, "changed");
});

test("private-root restrictions reject session aliases and do not harvest arbitrary files", async () => {
  const f = await native(); const outside = await tempDir("outside-session-");
  assert.equal((await readNativeSession({ path: f.path, source: "herdr-path", allowedRoot: outside })).observation.status, "unsupported");
  const alias = join(f.root, "alias.jsonl"); await symlink(f.path, alias);
  assert.equal((await readNativeSession({ path: alias, source: "herdr-path", allowedRoot: f.root })).observation.status, "unsupported");
  const auth = join(f.root, "not-a-session.jsonl"); await writeFile(auth, '{"access_token":"fixture-not-a-real-credential"}\n');
  assert.equal((await readNativeSession({ path: auth, source: "herdr-path", allowedRoot: f.root })).bytes, undefined);
  await chmod(f.root, 0o755);
  assert.equal((await readNativeSession({ path: f.path, source: "herdr-path", allowedRoot: f.root })).observation.status, "unsupported");
});

test("replaced native files quarantine the current reference while retaining previous blob bytes", async () => {
  const f = await native(); const archive = await tempDir("native-archive-");
  const prior = process.env[ENV_NATIVE_SESSION_ROOT]; process.env[ENV_NATIVE_SESSION_ROOT] = f.root;
  try {
    const h = beginExecutionRetention(identity, archive); h.observeSession({ source: "herdr-path", value: f.path });
    const firstPath = (await h.flush()).manifestPath!;
    const first = parseExecutionRetentionManifest(await readFile(firstPath, "utf8"));
    assert.equal(first.nativeSession.status, "verified");
    const bytes = await readFile(f.path); await rename(f.path, f.path + ".historical"); await writeFile(f.path, bytes);
    h.observeSession({ source: "herdr-path", value: f.path }); h.finish(outcome); await h.flush();
    const second = parseExecutionRetentionManifest(await readFile(firstPath, "utf8"));
    assert.equal(second.nativeSession.status, "changed"); assert.equal(second.content.session.status, "missing");
    assert.equal(second.native.sessionId, null); assert.equal(first.nativeSession.status, "verified");
    assert.deepEqual(await readFile(join(firstPath, "..", first.content.session.path!)), bytes);
  } finally { prior === undefined ? delete process.env[ENV_NATIVE_SESSION_ROOT] : process.env[ENV_NATIVE_SESSION_ROOT] = prior; }
});

test("native observation detaches queued references and explicitly records coalesced reference loss", async () => {
  const f = await native(), archive = await tempDir("queued-native-archive-");
  const prior = process.env[ENV_NATIVE_SESSION_ROOT]; process.env[ENV_NATIVE_SESSION_ROOT] = f.root;
  try {
    const h = beginExecutionRetention(identity, archive), reference = { source: "herdr-path" as const, value: f.path };
    h.observeSession(reference); reference.value = join(f.root, "absent.jsonl"); h.finish(outcome);
    const path = (await h.flush()).manifestPath!;
    const m = parseExecutionRetentionManifest(await readFile(path, "utf8"));
    assert.equal(m.nativeSession.status, "verified", "later caller mutation cannot redirect an already-observed reference");
    const dropped = beginExecutionRetention(identity, archive);
    dropped.observeSession({ source: "herdr-path", value: join(f.root, "absent.jsonl") });
    dropped.observeSession({ source: "herdr-path", value: f.path }); dropped.finish(outcome);
    const d = parseExecutionRetentionManifest(await readFile((await dropped.flush()).manifestPath!, "utf8"));
    assert.ok(d.coverage.losses.includes("native-session-reference-coalesced"));
  } finally { prior === undefined ? delete process.env[ENV_NATIVE_SESSION_ROOT] : process.env[ENV_NATIVE_SESSION_ROOT] = prior; }
});

test("the governed process seam retains actual private SessionManager bytes from an explicit host target", async () => {
  const f = await native(), archive = await tempDir("process-native-archive-");
  const bin = join(f.root, "bin"); await mkdir(bin);
  const module = pathToFileURL(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js")).href;
  await writeFile(join(bin, "pi"), `#!${process.execPath}\n(async()=>{const {SessionManager}=await import(${JSON.stringify(module)});const args=process.argv.slice(2);const file=args[args.indexOf('--session')+1];const sm=SessionManager.open(file);sm.appendMessage(${JSON.stringify(assistant())});process.stdout.write('fixture finished');})().catch(()=>process.exit(91));\n`);
  await chmod(join(bin, "pi"), 0o700);
  const values = { PATH: bin, PI_GRANTS_EXECUTION_ARCHIVE: archive, PI_GRANTS_NATIVE_SESSION_ROOT: f.root };
  const prior = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]])); Object.assign(process.env, values);
  try {
    const plan = planDelegation({ task: "fixture", tools: [] }, { ownGrant: [], depth: 0, maxDepth: 2, gated: [], sessionFile: f.path });
    assert.ok(plan.args.includes("--session")); assert.ok(!plan.args.includes("--no-session"));
    const result = await executePlannedChild({ session: { executor: { kind: "process" } } as never, plan,
      childId: "reused", executionId: "exec:fixture-process", parentExecutionId: "exec:parent", toolCallId: "call:process", cwd: f.root });
    assert.equal(result.ok, true); assert.equal(result.exitCode, 0); assert.equal(result.text, "fixture finished");
    await assert.rejects(drainExecutionRetention({ ...result.retention! }), /original live/);
    const drained = await drainExecutionRetention(result.retention!);
    assert.equal(drained.status, "retained");
    const path = drained.manifestPath!, m = parseExecutionRetentionManifest(await readFile(path, "utf8"));
    assert.equal(m?.native.sessionId, f.manager.getSessionId()); assert.equal(m?.identity.toolCallId, "call:process");
    assert.equal(m?.native.branchLeafId, null);
    assert.deepEqual(await readFile(join(path, "..", m!.content.session.path!)), await readFile(f.path));
  } finally { for (const[k,v]of Object.entries(prior)) v === undefined ? delete process.env[k] : process.env[k] = v; }
});

test("deterministic capture then append: terminal/verified is not the final-byte oracle", async () => {
  const f = await native(), archive = await tempDir("ordered-native-archive-");
  const prior = process.env[ENV_NATIVE_SESSION_ROOT]; process.env[ENV_NATIVE_SESSION_ROOT] = f.root;
  try {
    const before = await readFile(f.path), old = beginExecutionRetention(identity, archive);
    old.observeSession({ source: "pi-session-file", value: f.path }); await old.flush();
    f.manager.appendMessage(assistant()); const after = await readFile(f.path);
    assert.ok(after.length > before.length);
    old.finish(outcome); const status = await old.flush();
    const m = parseExecutionRetentionManifest(await readFile(status.manifestPath!, "utf8"));
    assert.equal(m.state, "terminal"); assert.equal(m.nativeSession.status, "verified");
    assert.equal(m.coverage.complete, false); assert.equal(m.nativeSession.branchLeafId, null);
    const retained = await readFile(join(status.manifestPath!, "..", m.content.session.path!));
    assert.deepEqual(retained, before); assert.notDeepEqual(retained, after);
    const final = beginExecutionRetention({ ...identity, executionId: "exec:ordered-final" }, archive);
    final.observeSession({ source: "pi-session-file", value: f.path }); final.finish(outcome);
    const settled = await drainExecutionRetention(final.status());
    const latest = parseExecutionRetentionManifest(await readFile(settled.manifestPath!, "utf8"));
    assert.deepEqual(await readFile(join(settled.manifestPath!, "..", latest.content.session.path!)), after);
  } finally { prior === undefined ? delete process.env[ENV_NATIVE_SESSION_ROOT] : process.env[ENV_NATIVE_SESSION_ROOT] = prior; }
});

test("existing Herdr native replies bind session bytes to the exact pane and execution", async () => {
  const f = await native(), archive = await tempDir("herdr-native-archive-");
  const prior = process.env[ENV_NATIVE_SESSION_ROOT]; process.env[ENV_NATIVE_SESSION_ROOT] = f.root;
  try {
    const h = beginExecutionRetention(identity, archive); const calls: string[] = [];
    const info = { pane_id: "w1:p2", agent: "pi", agent_session: { agent: "pi", source: "fixture-native-integration", kind: "path", value: f.path } };
    assert.equal(herdrSessionReference(info, "different-pane"), null);
    assert.equal(herdrSessionReference({ ...info, agent_session: { ...info.agent_session, agent: "other" } }, "w1:p2"), null);
    const run = await runHerdrPane({ args: ["--no-session"], prompt: "fixture", env: {}, cwd: f.root, name: "same-name", keepPane: true,
      onSessionReference: ref => h.observeSession(ref), exec: async args => {
        const verb = args.slice(0, 2).join(" "); calls.push(verb);
        const result = verb === "tab create" ? { root_pane: { pane_id: "w1:p2", tab_id: "w1:t2" } }
          : verb === "agent start" ? { agent: { ...info, state_change_seq: 1 } }
          : verb === "agent get" ? { agent: { ...info, state_change_seq: 2, agent_status: "idle" } }
          : verb === "agent read" ? { output: "output" } : { ok: true };
        return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
      } });
    assert.equal(run.code, 0); h.finish(outcome);
    const path = (await h.flush()).manifestPath!; const m = parseExecutionRetentionManifest(await readFile(path, "utf8"));
    assert.equal(m.native.sessionId, f.manager.getSessionId()); assert.equal(m.identity.toolCallId, "call:exact");
    assert.equal(m.native.branchLeafId, null); assert.equal(m.content.session.status, "retained");
    assert.deepEqual(calls, ["tab create", "agent start", "agent prompt", "agent get", "agent read"]);
  } finally { prior === undefined ? delete process.env[ENV_NATIVE_SESSION_ROOT] : process.env[ENV_NATIVE_SESSION_ROOT] = prior; }
});
