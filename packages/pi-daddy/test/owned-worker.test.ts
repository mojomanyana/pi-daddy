/** Actual owned-process tests. Every kill targets this fixture's own ChildProcess handle. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
import { setTimeout as delay } from "node:timers/promises";
import { runOwnedChild } from "../src/executors/owned-worker.ts";
import { readCapturedWorkerReceipt } from "../src/governance/captured-worker-record.ts";
import { acquireWorkspaceLease } from "../src/governance/workspace-lease.ts";
import { leasePaths } from "../src/governance/lease-record.ts";
import type { CapturedWorkerIdentity } from "../src/kernel/captured-worker-contract.ts";

async function eventually(check: () => Promise<boolean>, message: string) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(message);
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function fixture(t: import("node:test").TestContext) {
  const root = await tempDir("pi-owned-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function request(root: string, code: string, suffix = "") {
  return {
    executionId: "execution-fixture" + suffix,
    ownershipDir: join(root, "owner" + suffix),
    cwd: root,
    command: process.execPath,
    args: ["-e", code],
    env: process.env,
    timeoutMs: 3000,
    killGraceMs: 80,
  };
}
const processRecord = `const fs=require('node:fs'); fs.appendFileSync(process.env.P07_MARKER,JSON.stringify({pid:process.pid,start:fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19]})+'\\n');`;
function daemonRoot(late = false) {
  const lateCode = processRecord + "setInterval(()=>{},1000);";
  const childCode =
    processRecord +
    (late
      ? `let once=false; process.on('SIGTERM',()=>{if(once)return;once=true;require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(lateCode)}],{detached:true,stdio:'ignore',env:process.env}).unref();setTimeout(()=>process.exit(0),40);});`
      : "") +
    "setInterval(()=>{},1000);";
  return `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore',env:process.env}).unref();setTimeout(()=>process.exit(0),150);`;
}
async function assertWorkersGone(marker: string) {
  const records = (await readFile(marker, "utf8"))
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  assert.ok(records.length > 0);
  for (const record of records) {
    const stat = await readFile(`/proc/${record.pid}/stat`, "utf8").catch(() => "");
    assert.ok(!stat || stat.split(") ")[1].split(" ")[19] !== record.start, `owned process ${record.pid} remains`);
  }
  return records;
}

test("ownership persistence gate precedes execution; success settles and exact stdout can be observed without capture", async (t) => {
  const root = await fixture(t);
  let observed = "";
  const marker = join(root, "ran");
  const result = await runOwnedChild({
    ...request(
      root,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write('exact final');process.stderr.write('diagnostic');`,
    ),
    captureStdout: false,
    onObservation(stream, bytes) {
      if (stream === "stdout") observed += Buffer.from(bytes).toString();
    },
    async onOwnership(identity) {
      assert.equal(await exists(marker), false);
      assert.equal(await exists(identity.ownershipPath), true);
      await delay(40);
      assert.equal(await exists(marker), false);
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.cleanup.state, "settled");
  assert.equal(observed, "exact final");
  assert.equal(result.text, "diagnostic");
});

test("failed ownership persistence never releases the command gate", async (t) => {
  const root = await fixture(t);
  const marker = join(root, "ran");
  const result = await runOwnedChild({
    ...request(root, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`),
    onOwnership() {
      throw new Error("fixture persistence failed");
    },
  });
  assert.match(result.spawnError!, /persistence failed/);
  assert.equal(await exists(marker), false);
  assert.equal(result.cleanup.state, "settled");
});

for (const late of [false, true])
  test(`success reaps detached/orphan ${late ? "late-fork" : "preview"} descendants and leaves unrelated sentinel`, async (t) => {
    const root = await fixture(t);
    const marker = join(root, "pids");
    const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    t.after(async () => {
      sentinel.kill("SIGKILL");
      await once(sentinel, "close");
    });
    const result = await runOwnedChild({
      ...request(root, daemonRoot(late)),
      env: { ...process.env, P07_MARKER: marker },
    });
    assert.equal(result.code, 0);
    assert.equal(result.cleanup.state, "settled");
    const records = await assertWorkersGone(marker);
    if (late) assert.ok(records.length >= 2);
    assert.equal(sentinel.exitCode, null);
    assert.equal(sentinel.signalCode, null);
  });

for (const stop of ["timeout", "abort"] as const)
  test(`${stop} kills TERM-resistant owned worker and reaps it`, async (t) => {
    const root = await fixture(t);
    const controller = new AbortController();
    let identity: CapturedWorkerIdentity | undefined;
    const result = await runOwnedChild({
      ...request(root, `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`),
      timeoutMs: stop === "timeout" ? 150 : 3000,
      signal: controller.signal,
      onOwnership(value) {
        identity = value;
        if (stop === "abort") setTimeout(() => controller.abort(), 150);
      },
    });
    assert.equal(result.cleanup.state, "settled");
    assert.equal(result.signal, "SIGKILL");
    assert.equal(await exists(`/proc/${identity!.workerPid}`), false);
    assert.equal(result.timedOut, stop === "timeout");
    assert.equal(result.aborted, stop === "abort");
  });

test("controller SIGKILL closes ownership pipe and native helper independently settles descendants", async (t) => {
  const root = await fixture(t);
  const marker = join(root, "pids");
  const ownershipDir = join(root, "owner");
  const module = new URL("../src/executors/owned-worker.ts", import.meta.url).href;
  const code = `import {runOwnedChild} from ${JSON.stringify(module)}; await runOwnedChild(${JSON.stringify({ ...request(root, daemonRoot()), args: ["-e", daemonRoot().replace("process.exit(0),150", "process.exit(0),100000")], env: { ...process.env, P07_MARKER: marker } })});`;
  const controller = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
  t.after(() => controller.kill("SIGKILL"));
  await eventually(() => exists(marker), "fixture worker never started");
  const identity = JSON.parse(await readFile(join(ownershipDir, "ownership.json"), "utf8"))
    .identity as CapturedWorkerIdentity;
  controller.kill("SIGKILL");
  await once(controller, "close");
  await eventually(async () => (await readCapturedWorkerReceipt(identity)) !== null, "owner-loss receipt missing");
  const receipt = await readCapturedWorkerReceipt(identity);
  assert.equal(receipt!.reason, "owner-loss");
  await assertWorkersGone(marker);
});

test("helper death is unknown, and a missing or wrong predecessor receipt blocks the next writer despite a free lock", async (t) => {
  const root = await fixture(t);
  const leaseDir = join(root, "leases");
  await mkdir(leaseDir);
  const workspace = { root, workspaceId: "fixture", gitCommonDir: root };
  const lease = await acquireWorkspaceLease({ workspace, access: "write", ownerId: "owner", leaseDir });
  let identity: CapturedWorkerIdentity | undefined;
  const result = await runOwnedChild({
    ...request(root, "process.exit(0)"),
    async onOwnership(value) {
      identity = value;
      await lease.attachCapturedWorker(value);
      // Helper is our live child, still holding the worker behind its gate. Worker exits when gate closes.
      process.kill(value.helperPid, "SIGKILL");
    },
  });
  assert.equal(result.cleanup.state, "unknown");
  assert.equal(await lease.release(), "retained");
  const metadataPath = leasePaths(leaseDir, root).metadata;
  const original = await readFile(metadataPath, "utf8");
  const metadata = JSON.parse(original);
  // Terminate only the recorded lease helper which this test just created; exact PID birth is checked below.
  const status = await readFile(`/proc/${metadata.pid}/stat`, "utf8");
  assert.ok(status.includes(") "));
  process.kill(metadata.pid, "SIGTERM");
  // Retention deliberately unrefs the helper and its streams. This explicit observation needs its own
  // finite event-loop reference: awaiting a Promise alone can let Node exit before the close event.
  let lossTimeout: NodeJS.Timeout | undefined;
  try {
    const loss = await Promise.race([
      lease.lost,
      new Promise<never>((_resolve, reject) => {
        lossTimeout = setTimeout(() => reject(new Error("retained lease helper did not report loss")), 5000);
      }),
    ]);
    assert.match(loss.message, /workspace writer lease helper exited/);
  } finally {
    clearTimeout(lossTimeout);
  }
  // A refused acquisition ends its temporary helper's stdin before that helper necessarily drops flock.
  // Prove the free-lock precondition before each receipt assertion; a busy refusal proves a different fact.
  const waitForFreeLock = () =>
    eventually(async () => {
      const probe = spawn(
        "flock",
        ["--exclusive", "--nonblock", "--conflict-exit-code", "73", leasePaths(leaseDir, root).lock, "true"],
        { stdio: "ignore", timeout: 1000, killSignal: "SIGKILL" },
      );
      const [code, signal] = await once(probe, "close");
      assert.equal(signal, null, "fixture lock probe did not finish");
      assert.ok(code === 0 || code === 73, `fixture lock probe failed with ${code}`);
      return code === 0;
    }, "fixture kernel lock did not become free");
  await waitForFreeLock();
  await assert.rejects(
    acquireWorkspaceLease({ workspace, access: "write", ownerId: "second", leaseDir }),
    /unresolved/,
  );
  assert.equal(await readFile(metadataPath, "utf8"), original);
  await writeFile(
    identity!.receiptPath,
    JSON.stringify({
      state: "settled",
      identity: { ...identity!, nonce: "wrong" },
      reapedAll: true,
      workerCode: 0,
      workerSignal: 0,
      reason: "worker-exit",
    }),
  );
  await waitForFreeLock();
  await assert.rejects(acquireWorkspaceLease({ workspace, access: "write", ownerId: "third", leaseDir }), /unresolved/);
  assert.equal(await readFile(metadataPath, "utf8"), original);
});

test("writer release waits for original receipt and can reconcile only restored original evidence", async (t) => {
  const root = await fixture(t);
  const leaseDir = join(root, "leases");
  const workspace = { root, workspaceId: "fixture", gitCommonDir: root };
  const lease = await acquireWorkspaceLease({ workspace, access: "write", ownerId: "owner", leaseDir });
  const result = await runOwnedChild({
    ...request(root, "process.exit(0)"),
    async onOwnership(identity) {
      await lease.attachCapturedWorker(identity);
      assert.equal(await lease.release(), "retained");
      await assert.rejects(
        acquireWorkspaceLease({ workspace, access: "write", ownerId: "premature", leaseDir }),
        /active/,
      );
    },
  });
  assert.equal(result.cleanup.state, "settled");
  if (result.cleanup.state !== "settled") assert.fail("expected real settled receipt");
  const receiptPath = result.cleanup.identity.receiptPath;
  const original = await readFile(receiptPath, "utf8");
  assert.equal(await lease.release(), "released");
  await writeFile(receiptPath, '{"state":"settled"');
  await assert.rejects(
    acquireWorkspaceLease({ workspace, access: "write", ownerId: "partial", leaseDir }),
    /unresolved/,
  );
  await delay(30);
  await writeFile(receiptPath, original);
  const next = await acquireWorkspaceLease({ workspace, access: "write", ownerId: "reconciled", leaseDir });
  assert.equal(await next.release(), "released");
});

test("a deadline reached during synchronous ownership persistence never releases the worker gate", async (t) => {
  const root = await fixture(t);
  const marker = join(root, "ran");
  const result = await runOwnedChild({
    ...request(root, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`),
    hardDeadlineAt: Date.now() + 100,
    onOwnership() {
      const until = Date.now() + 150;
      while (Date.now() < until) {
        /* deliberate blocked controller */
      }
    },
  });
  assert.equal(result.timedOut, true);
  assert.equal(await exists(marker), false);
  assert.equal(result.cleanup.state, "settled");
});

test("deadline expiring during startup filesystem work still resolves after helper settlement", async (t) => {
  const root = await fixture(t);
  const marker = join(root, "ran");
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.mkdir;
  const delayed = t.mock.method(fs, "mkdir", async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (args[0] === join(root, "owner")) await delay(120);
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    delayed.mock.restore();
    syncBuiltinESMExports();
  });
  const result = await Promise.race([
    runOwnedChild({
      ...request(root, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`),
      hardDeadlineAt: Date.now() + 80,
    }),
    delay(1500).then(() => {
      throw new Error("expired startup left runOwnedChild unresolved");
    }),
  ]);
  assert.equal(result.timedOut, true);
  assert.equal(await exists(marker), false);
});

test("unknown captured cleanup lets its controller exit naturally while preserving quarantine", async (t) => {
  const root = await fixture(t);
  const leaseDir = join(root, "leases");
  const workerModule = new URL("../src/executors/owned-worker.ts", import.meta.url).href;
  const leaseModule = new URL("../src/governance/workspace-lease.ts", import.meta.url).href;
  const workspace = { root, workspaceId: "fixture", gitCommonDir: root };
  const code = `import {runOwnedChild} from ${JSON.stringify(workerModule)};
    import {acquireWorkspaceLease} from ${JSON.stringify(leaseModule)};
    const lease=await acquireWorkspaceLease(${JSON.stringify({ workspace, access: "write", ownerId: "controller", leaseDir })});
    const result=await runOwnedChild({...${JSON.stringify(request(root, "process.exit(0)"))},
      async onOwnership(identity){await lease.attachCapturedWorker(identity);process.kill(identity.helperPid,'SIGKILL');}});
    console.log(JSON.stringify({cleanup:result.cleanup.state,release:await lease.release()}));`;
  const controller = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => controller.kill("SIGKILL"));
  let output = "";
  controller.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const closed = await Promise.race([
    once(controller, "close"),
    delay(1500).then(() => {
      throw new Error("retained captured lease wedged controller exit");
    }),
  ]);
  assert.equal(closed[0], 0);
  assert.deepEqual(JSON.parse(output), { cleanup: "unknown", release: "retained" });
  await assert.rejects(acquireWorkspaceLease({ workspace, access: "write", ownerId: "next", leaseDir }), /unresolved/);
});
