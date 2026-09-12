import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, readFile, readdir, writeFile, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { beginExecutionRetention, ENV_EXECUTION_ARCHIVE, verifyRetainedBytes, type ExecutionRetentionManifest } from "../src/execution-retention.ts";
import { executePlannedChild } from "../extensions/execute-child.ts";
import { planDelegation } from "../src/delegate.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
import grantsExtension from "../extensions/grants.ts";
import { newExecutionId } from "../src/execution-id.ts";
import { runChild } from "../src/run-child.ts";
import { runHerdrPane } from "../src/run-herdr.ts";
import { runNamedCheck } from "../src/check-runner.ts";
const identity = { executionId: "execution:a", parentExecutionId: "execution:parent", childId: "same-name",
  toolCallId: "call:a", executor: "process" as const, taskDigest: "a".repeat(64), definitionDigest: null,
  configurationDigest: "b".repeat(64), workspaceId: null };
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
async function manifest(path: string): Promise<ExecutionRetentionManifest> { return JSON.parse(await readFile(path, "utf8")); }
const terminal = { code: 0, signal: null, timedOut: false, aborted: false, truncated: false, failed: false };

test("governed interruption publishes retention without changing the control outcome", async () => {
  const dir = await tempDir("p02-interruption-");
  const old = process.env[ENV_EXECUTION_ARCHIVE]; process.env[ENV_EXECUTION_ARCHIVE] = dir;
  try {
    const plan = planDelegation({ task: "fixture", tools: [] }, { ownGrant: [], depth: 0, maxDepth: 2, gated: [] });
    const outcome = await executePlannedChild({ session: { executor: { kind: "process" } } as never,
      plan, childId: "same-name", executionId: "execution:a", parentExecutionId: null,
      cwd: dir, signal: AbortSignal.abort() });
    assert.equal(outcome.refusal?.code, "CHILD_CANCELLED");
    assert.ok((outcome as any).retention?.manifestPath, "governed executor must expose its archive receipt");
    let found: ExecutionRetentionManifest | undefined;
    for (let i = 0; i < 100; i++) {
      try { found = await manifest((outcome as any).retention.manifestPath); } catch {}
      if (found?.state === "terminal") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(found?.outcome?.aborted, true);
    assert.equal(found?.native.pid, null);
    assert.equal(found?.content.stdout.status, "missing");
    assert.equal(found?.acceptance, "not-assessed");
  } finally { old === undefined ? delete process.env[ENV_EXECUTION_ARCHIVE] : process.env[ENV_EXECUTION_ARCHIVE] = old; }
});

test("public concurrent delegation calls retain distinct native attempts and exact call joins", async () => {
  const dir = await tempDir("p02-public-"); const bin = join(dir, "bin"); await mkdir(bin);
  await writeFile(join(bin, "pi"), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({type:'fixture',execution:process.env.PI_GRANTS_EXECUTION_ID,toolCallId:'forged'})+'\\n');process.stderr.write('diagnostic');\n`);
  await chmod(join(bin, "pi"), 0o700);
  const values = { PATH: bin, PI_GRANTS_HERDR: "0", PI_GRANTS_GRANT: "tool:delegate", PI_GRANTS_MAX_DEPTH: "2",
    PI_GRANTS_EXECUTION_ID: newExecutionId(), PI_GRANTS_EXECUTION_ARCHIVE: join(dir, "archive") };
  const prior = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]])); Object.assign(process.env, values);
  try {
    const tools = new Map<string, any>(); const hooks = new Map<string, any>();
    grantsExtension({ on: (n: string, fn: unknown) => hooks.set(n, fn), registerTool: (t: any) => tools.set(t.name, t),
      registerCommand: () => {}, getAllTools: () => [{ name: "delegate" }] } as never);
    const ctx = { cwd: dir, ui: { notify: () => {}, select: async () => undefined }, modelRegistry: { find: () => undefined } };
    await hooks.get("session_start")({}, ctx);
    const results = await Promise.all(["call:first", "call:second"].map(call => tools.get("delegate").execute(call,
      { task: "same task", tools: [] }, undefined, undefined, ctx)));
    const records: ExecutionRetentionManifest[] = [];
    for (const result of results) {
      const path = result.details.retention.manifestPath; assert.ok(path);
      let m: ExecutionRetentionManifest | undefined;
      for (let i = 0; i < 100; i++) { try { m = await manifest(path); } catch {} if (m?.state === "terminal") break; await new Promise(r => setTimeout(r, 10)); }
      assert.equal(m?.outcome?.code, 0, "fixture must really spawn, not pass on refusal");
      assert.ok(m!.native.pid! > 0); assert.equal(m!.native.sessionId, null);
      assert.equal(m!.identity.parentExecutionId, values.PI_GRANTS_EXECUTION_ID);
      const bytes = await readFile(join(path, "..", m!.content.stdout.path!));
      assert.equal(hash(bytes), m!.content.stdout.sha256);
      assert.equal(JSON.parse(bytes.toString()).execution, m!.identity.executionId);
      assert.equal(JSON.parse(bytes.toString()).toolCallId, "forged");
      assert.equal((await readFile(join(path, "..", m!.content.stderr.path!))).toString(), "diagnostic");
      records.push(m!);
    }
    assert.equal(records[0].identity.childId, records[1].identity.childId);
    assert.notEqual(records[0].identity.executionId, records[1].identity.executionId);
    assert.deepEqual(records.map(m => m.identity.toolCallId), ["call:first", "call:second"]);
  } finally { for (const[k,v]of Object.entries(prior)) v === undefined ? delete process.env[k] : process.env[k] = v; }
});

test("raw structured bytes survive interruption and throwing observers cannot cancel control", async () => {
  const dir = await tempDir("p02-raw-"); const h = beginExecutionRetention(identity, dir); const abort = new AbortController();
  const run = await runChild({ command: process.execPath, args: ["-e", "process.stdout.write('{\\\"partial\\\":true}\\n');setTimeout(()=>{},10000)"],
    cwd: dir, env: {}, signal: abort.signal, killGraceMs: 10,
    onObservation: (stream, bytes) => { h.capture(stream, bytes); abort.abort(); } });
  assert.equal(run.aborted, true); assert.equal(run.spawnError, undefined);
  h.finish({ code: run.code, signal: run.signal ?? null, timedOut: run.timedOut, aborted: run.aborted, truncated: run.truncated, failed: true });
  const path = (await h.flush()).manifestPath!; const m = await manifest(path);
  assert.equal((await readFile(join(path, "..", m.content.stdout.path!))).toString(), '{"partial":true}\n');
  const healthy = await runChild({ command: process.execPath, args: ["-e", "process.stdout.write('ok')"], cwd: dir, env: {},
    onObservation: () => { throw Error("observer"); } });
  assert.equal(healthy.code, 0); assert.equal(healthy.text, "ok");
});

test("named check producer retains its complete actual receipt with a synthetic Git identity fixture", async () => {
  // No Git commands/commits: this fixture fixes only the candidate identity transport. Real lease,
  // constrained executable, receipt builder and retention writer are exercised; not Git assurance.
  const dir = await tempDir("p02-check-"); const bin = join(dir, "bin"); await mkdir(bin);
  await writeFile(join(bin, "git"), `#!${process.execPath}\nconst a=process.argv.slice(2);if(a.includes('rev-parse'))console.log('${"a".repeat(40)}');else if(a.includes('write-tree'))console.log('${"b".repeat(40)}');else if(!a.includes('read-tree')&&!a.includes('add'))process.exit(91);\n`);
  await chmod(join(bin, "git"), 0o700);
  await symlink("/usr/bin/flock", join(bin, "flock"));
  const check = join(dir, "check"); await writeFile(check, `#!${process.execPath}\nprocess.stdout.write('complete check output');\n`); await chmod(check, 0o700);
  const prior = process.env.PATH; process.env.PATH = bin;
  try {
    const input = { checkId: "fixture", registry: { version: 1 as const, checks: { fixture: { executable: check, argv: [], workspace_access: "read" as const } } },
      workspace: { workspaceId: "fixture-workspace", root: dir } as never, leaseDir: join(dir, "leases"), retentionDirectory: join(dir, "archive"), toolCallId: "check-call" };
    const result = await runNamedCheck(input);
    assert.equal(result.exitCode, 0); assert.equal(result.output, "complete check output");
    const path = result.retention.manifestPath!; let m: ExecutionRetentionManifest | undefined;
    for (let i = 0; i < 100; i++) { try { m = await manifest(path); } catch {} if (m?.state === "terminal") break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(m?.identity.toolCallId, "check-call"); assert.equal(m?.outcome?.code, 0);
    const bytes = await readFile(join(path, "..", m!.content.checkReceipt.path!));
    assert.equal(bytes.toString(), JSON.stringify(result.receipt) + "\n");
    assert.equal(verifyRetainedBytes(m!.content.checkReceipt, bytes), "retained");
    assert.equal(verifyRetainedBytes(m!.content.checkReceipt), "missing");
    assert.equal(verifyRetainedBytes(m!.content.checkReceipt, Buffer.from("different")), "mismatch");
    const denied = join(dir, "ledger-directory"); await mkdir(denied);
    await assert.rejects(runNamedCheck({ ...input, ledgerPath: denied }), /EISDIR|directory|ledger/i);
    const archives = await readdir(join(dir, "archive"));
    assert.equal(archives.length, 2, "failed required receipt remains a distinct observation, not success");
  } finally { prior === undefined ? delete process.env.PATH : process.env.PATH = prior; }
});

test("herdr observations reuse existing native replies and snapshots without extra control calls", async () => {
  const dir = await tempDir("p02-herdr-"); const h = beginExecutionRetention({ ...identity, executor: "herdr" }, dir);
  const calls: string[] = []; let gets = 0;
  const run = await runHerdrPane({ args: ["--no-session"], prompt: "fixture", env: {}, cwd: dir, name: "reused", keepPane: true,
    onPane: (paneId, agentName) => h.native({ paneId, agentName }), onNativeTab: tabId => h.native({ tabId }),
    onObservation: bytes => h.capture("paneSnapshot", bytes, true),
    exec: async args => {
      const verb = args.slice(0, 2).join(" "); calls.push(verb);
      const result = verb === "tab create" ? { root_pane: { pane_id: "w1:p2", tab_id: "w1:t2" } }
        : verb === "agent start" ? { agent: { state_change_seq: 1 } }
        : verb === "agent get" ? { agent: { state_change_seq: ++gets + 1, agent_status: "idle", screen_detection_skipped: true } }
        : verb === "agent read" ? { output: "native pane bytes" } : { ok: true };
      return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
    } });
  assert.equal(run.code, 0); h.finish(terminal);
  const path = (await h.flush()).manifestPath!; const m = await manifest(path);
  assert.deepEqual(calls, ["tab create", "agent start", "agent get", "agent prompt", "agent get", "agent read"]);
  assert.equal(m.native.paneId, "w1:p2"); assert.equal(m.native.tabId, "w1:t2");
  assert.match(m.native.agentName!, /^reused/); assert.equal(m.native.sessionId, null); assert.equal(m.native.branchLeafId, null);
  assert.equal((await readFile(join(path, "..", m.content.paneSnapshot.path!))).toString(), "native pane bytes");
});

test("complete receipt bytes have reserved capacity and remain distinct from a reference", async () => {
  const dir = await tempDir("p02-receipt-"); const h = beginExecutionRetention(identity, dir);
  h.capture("stdout", Buffer.alloc(1024 * 1024));
  const bytes = Buffer.from('{"schema_version":"1.0","receipt_id":"fixture","complete":"all fields supplied by caller"}\n');
  h.capture("checkReceipt", bytes); h.finish(terminal);
  const path = (await h.flush()).manifestPath!; const m = await manifest(path);
  assert.deepEqual(await readFile(join(path, "..", m.content.checkReceipt.path!)), bytes);
  assert.equal(m.content.checkReceipt.sha256, hash(bytes));
  assert.equal(m.content.session.status, "missing"); assert.equal(m.coverage.complete, false);
});

test("retention publishes exact bytes and an independent manifest for reused names", async () => {
  const dir = await tempDir("p02-bytes-");
  const a = beginExecutionRetention(identity, dir);
  const b = beginExecutionRetention({ ...identity, executionId: "execution:b", toolCallId: "call:b" }, dir);
  const bytes = Buffer.from('{"toolCallId":"other-untrusted-call","text":"你好"}\n');
  a.capture("stdout", bytes); b.capture("stdout", Buffer.from("second"));
  a.native({ pid: 123 }); a.finish(terminal); b.finish({ ...terminal, code: 7, failed: true });
  const [ar, br] = await Promise.all([a.flush(), b.flush()]);
  assert.equal(ar.status, "retained"); assert.notEqual(ar.manifestPath, br.manifestPath);
  const m = await manifest(ar.manifestPath!);
  assert.equal(m.identity.toolCallId, "call:a"); assert.equal(m.native.pid, 123);
  assert.equal(m.content.stdout.sha256, hash(bytes));
  assert.deepEqual(await readFile(join(ar.manifestPath!, "..", m.content.stdout.path!)), bytes);
  assert.equal(m.content.checkReceipt.status, "missing"); assert.equal(m.native.branchLeafId, null);
  assert.equal(m.coverage.complete, false); assert.equal(m.acceptance, "not-assessed");
});

test("observation loss and missing receipt bytes never become complete evidence", async () => {
  const dir = await tempDir("p02-loss-");
  const h = beginExecutionRetention(identity, dir);
  h.capture("stdout", Buffer.alloc(1024 * 1024 + 1, 65));
  h.capture("checkReceipt", Buffer.alloc(1024 * 1024 + 1, 66));
  h.finish({ ...terminal, aborted: true });
  const m = await manifest((await h.flush()).manifestPath!);
  assert.equal(m.content.stdout.bytes, 1024 * 1024);
  assert.equal(m.content.checkReceipt.status, "missing");
  assert.ok(m.coverage.losses.includes("stdout-observation-dropped"));
  assert.ok(m.coverage.losses.includes("check-receipt-not-retained-capacity"));
  const file = join(dir, "not-directory"); await writeFile(file, "sentinel");
  const failed = beginExecutionRetention(identity, file); failed.finish(terminal);
  assert.equal((await failed.flush()).status, "lost");
  assert.equal(await readFile(file, "utf8"), "sentinel");
  assert.equal(beginExecutionRetention(identity, "relative").status().status, "lost");
});
