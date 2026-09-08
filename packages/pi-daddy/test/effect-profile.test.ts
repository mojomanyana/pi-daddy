import { test, mock } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile, watch } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { tempDir } from "./tmp.ts";
import { createResourceBudget, openResourceBudget } from "../src/resource-budget.ts";
import { prepareDigestProfile, runDigestProfile, type DigestProfile } from "../src/effect-profile.ts";
import { digestNamespaceArgs, digestRuntime } from "../src/effect-profile-runtime.ts";
import { runChild } from "../src/run-child.ts";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const root = await tempDir("effect-profile-"); await chmod(root, 0o700);
  const binding = await createResourceBudget({ directory: join(root, "budget"), authorityDigest: hash("fixed-host-authority"),
    limits: { maxAttempts: 4, maxInputBytes: 65536, maxConcurrent: 2 } });
  return { root, binding };
}
const attempt = (attemptId: string) => ({ attemptId, orderId: "order", experimentId: "experiment", kind: "primary" as const, parentAttemptId: null });

test("real probed digest profile uses the existing launcher, exact byte input and durable admission", async () => {
  const { binding } = await fixture(), profile = await prepareDigestProfile(binding);
  const bytes = Buffer.from("abc"); const execution = runDigestProfile(profile, { attempt: attempt("one"), bytes }); bytes.fill(0);
  const result = await execution;
  assert.equal(result.output.code, 0); assert.equal(result.digest, hash("abc"));
  const state = await openResourceBudget(binding).inspect();
  assert.equal(state.attempts, 1); assert.equal(state.inputBytes, 3); assert.equal(state.active, 0);
  assert.equal(state.reservations[0].inputDigest, hash("abc"));
  await assert.rejects(runDigestProfile(profile, { attempt: attempt("one"), bytes: Buffer.from("abc") }), { code: "DUPLICATE" });
});

test("unsupported, receipt-shaped and mutable-destination routes fail before workload launch", async () => {
  const { root, binding } = await fixture();
  await assert.rejects(runDigestProfile({ profile: "shell" } as unknown as DigestProfile, { attempt: attempt("no"), bytes: Buffer.from("x") }), /unsupported or unprobed/);
  const profile = await prepareDigestProfile(binding);
  await assert.rejects(runDigestProfile(JSON.parse(JSON.stringify(profile)), { attempt: attempt("forged"), bytes: Buffer.from("x") }), /unsupported or unprobed/);
  const marker = join(root, "outside-denied");
  await assert.rejects(runDigestProfile(profile, { attempt: attempt("destination"), bytes: Buffer.from("x"), destination: marker } as never), /byte-only/);
  await assert.rejects(runDigestProfile(profile, { attempt: attempt("money"), bytes: Buffer.from("x"), moneyCap: 1 } as never), /byte-only/);
  await assert.rejects(runDigestProfile(profile, { attempt: attempt("large"), bytes: Buffer.alloc(16385) }), /byte-only/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.equal((await openResourceBudget(binding).inspect()).attempts, 0);
});

test("unsupported routes make zero actual spawn calls, and a post-spawn accounting failure still rejects", async () => {
  const { binding } = await fixture(), profile = await prepareDigestProfile(binding), original = childProcess.spawn;
  let calls = 0, replace = false;
  const spy = mock.method(childProcess, "spawn", (...args: any[]) => {
    calls++;
    const child = Reflect.apply(original, childProcess, args);
    if (replace && child.pid) {
      const path = join(binding.directory, "budget.jsonl"), bytes = readFileSync(path);
      renameSync(path, path + ".retained-before-replacement"); writeFileSync(path, bytes, { mode: 0o600 });
    }
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(runDigestProfile({ ...profile }, { attempt: attempt("unsupported"), bytes: Buffer.from("abc") }));
    await assert.rejects(runDigestProfile(profile, { attempt: attempt("writable"), bytes: Buffer.from("abc"), workspace: binding.directory } as never));
    assert.equal(calls, 0, "forwarding spy observes the real spawn seam, not a fake executable");
    replace = true;
    await assert.rejects(runDigestProfile(profile, { attempt: attempt("lost"), bytes: Buffer.from("abc") }), { code: "AUTHORITY_CHANGED" });
    assert.equal(calls, 1, "actual native worker spawned before mandatory accounting rejected");
    const old = await readFile(join(binding.directory, "budget.jsonl.retained-before-replacement"), "utf8");
    assert.ok(old.includes('"type":"reserve"')); assert.ok(!old.includes('"type":"settle"'));
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
});

test("cancellation after durable reservation is charged, settled, and cannot be retried under the same identity", async () => {
  const { binding } = await fixture(), profile = await prepareDigestProfile(binding), budget = openResourceBudget(binding);
  const early = AbortSignal.abort();
  await assert.rejects(runDigestProfile(profile, { attempt: attempt("early"), bytes: Buffer.from("abc") }, early), /before reservation/);
  assert.equal((await budget.inspect()).attempts, 0);
  const controller = new AbortController(), watching = new AbortController();
  const observer = (async () => { try { for await (const _ of watch(join(binding.directory, "budget.jsonl"), { signal: watching.signal })) {
    if ((await readFile(join(binding.directory, "budget.jsonl"), "utf8")).includes('"type":"reserve"')) { controller.abort(); break; }
  } } catch (e) { if ((e as Error).name !== "AbortError") throw e; } })();
  try {
    const result = await runDigestProfile(profile, { attempt: attempt("cancelled"), bytes: Buffer.from("abc") }, controller.signal);
    assert.equal(result.output.aborted, true); assert.equal(result.digest, null);
  } finally { watching.abort(); await observer; }
  const state = await budget.inspect(); assert.equal(state.active, 0); assert.equal(state.attempts, 1); assert.equal(state.inputBytes, 3);
  await assert.rejects(runDigestProfile(profile, { attempt: attempt("cancelled"), bytes: Buffer.from("abc") }), { code: "DUPLICATE" });
});

test("actual namespace denies owned outside read/write, read-only mutation, host network and process creation", async () => {
  const { root } = await fixture(), input = join(root, "input"); await mkdir(input);
  await writeFile(join(root, "outside"), "outside"); await writeFile(join(input, "allowed"), "allowed");
  let connections = 0; const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port, runtime = await digestRuntime();
  try {
    const code = `const fs=require('node:fs');let denied=[];for(const [k,fn]of Object.entries({outsideRead:()=>fs.readFileSync(${JSON.stringify(join(root, "outside"))}),outsideWrite:()=>fs.writeFileSync(${JSON.stringify(join(root, "denied"))},'x'),readOnlyWrite:()=>fs.writeFileSync('/input/denied','x')})){try{fn()}catch(e){denied.push(k+':'+e.code)}}const socket=require('node:net').connect(${port},'127.0.0.1');socket.on('connect',()=>process.exit(91));socket.on('error',()=>{console.log(JSON.stringify({allowed:fs.readFileSync('/input/allowed','utf8'),denied}));});socket.setTimeout(1000,()=>process.exit(92));`;
    const output = await runChild({ command: "/usr/bin/bwrap", args: digestNamespaceArgs(runtime, code, [], input), cwd: root, env: {}, timeoutMs: 3000, killGraceMs: 50 });
    assert.equal(output.code, 0, output.text);
    assert.deepEqual(JSON.parse(output.text), { allowed: "allowed", denied: ["outsideRead:ENOENT", "outsideWrite:ENOENT", "readOnlyWrite:EROFS"] });
    assert.equal(connections, 0); await assert.rejects(readFile(join(root, "denied")), { code: "ENOENT" });
    await assert.rejects(readFile(join(input, "denied")), { code: "ENOENT" });
    const child = await runChild({ command: "/usr/bin/bwrap", args: digestNamespaceArgs(runtime,
      `try{require('node:child_process').spawnSync('/runtime/node',['-e','process.exit(90)']);process.exit(91)}catch(e){console.log(e.code)}`, []), cwd: root, env: {}, timeoutMs: 3000 });
    assert.equal(child.code, 0, child.text); assert.equal(child.text.trim(), "ERR_ACCESS_DENIED");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("cancelling the actual namespace stops the owned worker, not just its output collector", async () => {
  const runtime = await digestRuntime(), controller = new AbortController(); let pid = 0; const owned = new Set<number>();
  const collect = async (parent: number): Promise<void> => {
    owned.add(parent);
    let children = ""; try { children = await readFile(`/proc/${parent}/task/${parent}/children`, "utf8"); } catch { return; }
    for (const child of children.trim().split(/\s+/).filter(Boolean).map(Number)) await collect(child);
  };
  let ready: Promise<void> | undefined;
  const result = await runChild({ command: "/usr/bin/bwrap", args: digestNamespaceArgs(runtime, `console.log('ready');setInterval(()=>{},1000);`, []),
    env: {}, cwd: "/", timeoutMs: 3000, killGraceMs: 50, signal: controller.signal, onSpawn: value => { pid = value; },
    onOutput: text => { if (text.includes("ready") && !ready) ready = collect(pid).then(() => controller.abort()); } });
  await ready; assert.equal(result.aborted, true); assert.ok(owned.size >= 2, "actual owned namespace worker was observed before cancellation");
  const live = async (id: number) => { try { return !/^State:\s+Z/m.test(await readFile(`/proc/${id}/status`, "utf8")); } catch { return false; } };
  for (let i = 0; i < 100 && (await Promise.all([...owned].map(live))).some(Boolean); i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(await Promise.all([...owned].map(live)), [...owned].map(() => false));
});
