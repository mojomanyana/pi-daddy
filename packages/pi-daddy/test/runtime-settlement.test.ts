import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";

import { join } from "node:path";
import { openRuntimeSettlement } from "../src/governance/runtime-settlement.ts";
import { runOwnedChild } from "../src/executors/owned-worker.ts";
test("runtime journal holds actual native ownership and cannot infer settled from a process exit", async () => {
  const root = await tempDir("pd-runtime-state-");
  const journal = await openRuntimeSettlement(root, "session-a", root);
  assert.equal((await journal.snapshot()).state, "idle");
  journal.begin("child-a");
  assert.equal((await journal.snapshot()).state, "busy");
  const result = await runOwnedChild({
    executionId: "child-a",
    ownershipDir: join(root, "owner"),
    cwd: root,
    command: process.execPath,
    args: ["-e", "process.stdout.write('done')"],
    env: process.env,
    onOwnership: (identity) => journal.bind(identity),
    timeoutMs: 1000,
  });
  assert.equal(result.cleanup.state, "settled");
  await journal.finish("child-a", result.cleanup);
  const settled = await journal.snapshot();
  assert.equal(settled.state, "idle");
  assert.deepEqual(settled.settledExecutionIds, ["child-a"]);
  assert.equal((await journal.snapshot()).evidenceDigest, settled.evidenceDigest);
  await assert.rejects(openRuntimeSettlement(root, "session-a", root), /another live runtime/);
  journal.begin("no-proof");
  await journal.finish("no-proof", { state: "unknown", reason: "disconnected" });
  assert.equal((await journal.snapshot()).state, "unknown");
  assert.deepEqual((await journal.snapshot()).outstandingExecutionIds, ["no-proof"]);
  const bytes = await readFile(join(root, "owner", "receipt.json"), "utf8");
  assert.equal(JSON.parse(bytes).reapedAll, true);
});
test("runtime journal preserves control failure despite a valid worker settlement and rejects duplicate execution", async () => {
  const root = await tempDir("pd-runtime-failed-");
  const journal = await openRuntimeSettlement(root, "session-b", root);
  journal.begin("setup");
  await journal.finish("setup", { state: "not-started", reason: "cancelled before launch" });
  assert.equal((await journal.snapshot()).state, "idle");
  assert.throws(() => journal.begin("setup"), /fresh/);
  journal.begin("bad");
  await journal.finish("bad", { state: "not-started", reason: "before launch" }, "workspace release not established");
  assert.equal((await journal.snapshot()).state, "unknown");
});
test("a clean process restart preserves exact settlement evidence; an unbound interrupted launch stays unknown", async () => {
  const root = await tempDir("pd-runtime-restart-");
  const { execFile } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const module = fileURLToPath(new URL("../src/governance/runtime-settlement.ts", import.meta.url));
  const run = (source: string) =>
    new Promise<string>((resolve, reject) =>
      execFile(process.execPath, ["--input-type=module", "-e", source], { timeout: 6000 }, (error, stdout, stderr) =>
        error ? reject(Error(stderr || String(error))) : resolve(stdout),
      ),
    );
  const first = JSON.parse(
    await run(`import {openRuntimeSettlement} from ${JSON.stringify(module)};
    const state=await openRuntimeSettlement(${JSON.stringify(root)},'restart-session',${JSON.stringify(root)});
    state.begin('before-start');await state.finish('before-start',{state:'not-started',reason:'not launched'});
    console.log(JSON.stringify(await state.snapshot()));`),
  );
  const resumed = await openRuntimeSettlement(root, "restart-session", root);
  const second = await resumed.snapshot();
  assert.equal(second.ownerScope, first.ownerScope);
  assert.notEqual(second.ownerId, first.ownerId);
  assert.equal(second.evidenceDigest, first.evidenceDigest);
  assert.equal(second.state, "idle");
  await run(`import {openRuntimeSettlement} from ${JSON.stringify(module)};
    const state=await openRuntimeSettlement(${JSON.stringify(root)},'crashed-session',${JSON.stringify(root)});
    state.begin('unbound-interruption');`);
  const stopped = await openRuntimeSettlement(root, "crashed-session", root);
  assert.equal((await stopped.snapshot()).state, "unknown");
  assert.deepEqual((await stopped.snapshot()).outstandingExecutionIds, ["unbound-interruption"]);
});
test("failed initialization releases its lock so a repaired journal can bind in the same process", async () => {
  const { mkdir, writeFile, unlink } = await import("node:fs/promises");
  const { settlementHash } = await import("../src/governance/runtime-settlement.ts");
  const root = await tempDir("pd-runtime-repair-"),
    directory = join(root, "pi-daddy", "runtime-settlement");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, settlementHash(["repair", root]) + ".json");
  await writeFile(path, "{malformed", { mode: 0o600 });
  await assert.rejects(openRuntimeSettlement(root, "repair", root), /JSON|property|Unexpected/);
  await unlink(path);
  const repaired = await openRuntimeSettlement(root, "repair", root);
  assert.equal((await repaired.snapshot()).state, "idle");
});
test("a size-bound save failure latches unknown even if in-memory finalization looks idle", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const { settlementHash } = await import("../src/governance/runtime-settlement.ts");
  const root = await tempDir("pd-runtime-bound-"),
    directory = join(root, "pi-daddy", "runtime-settlement");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await readFile("/proc/self/stat", "utf8");
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const seed = {
    version: 1,
    sessionId: "bound",
    cwd: root,
    ownerScope: randomUUID(),
    ownerId: [boot, "9".repeat(String(process.pid).length), ticks].join(":"),
    executions: [] as { id: string; state: string }[],
  };
  const target = 4 * 1024 * 1024 - 1;
  const rowBytes = JSON.stringify({ id: "x".repeat(512), state: "not-started" }).length + 1;
  const count = Math.floor((target - JSON.stringify(seed).length - 100) / rowBytes);
  for (let i = 0; i < count; i++) seed.executions.push({ id: String(i).padEnd(512, "x"), state: "not-started" });
  seed.executions.push({ id: "f".repeat(512), state: "not-started" }, { id: "target", state: "pending" });
  let excess = Buffer.byteLength(JSON.stringify(seed)) - target;
  for (let i = seed.executions.length - 2; excess > 0; i--) {
    const n = Math.min(excess, seed.executions[i].id.length - 12);
    seed.executions[i].id = seed.executions[i].id.slice(0, -n);
    excess -= n;
  }
  if (excess < 0) seed.executions[seed.executions.length - 2].id += "f".repeat(-excess);
  assert.equal(Buffer.byteLength(JSON.stringify(seed)), target);
  assert.ok(seed.executions.every((e) => e.id.length <= 512));
  await writeFile(join(directory, settlementHash(["bound", root]) + ".json"), JSON.stringify(seed) + "\n", {
    mode: 0o600,
  });
  const journal = await openRuntimeSettlement(root, "bound", root);
  await assert.rejects(journal.finish("target", { state: "not-started", reason: "prelaunch" }), /exceeds its bound/);
  assert.equal((await journal.snapshot()).state, "unknown");
});
test("runtime snapshot stays non-idle until control finalization is durably recorded", async () => {
  const root = await tempDir("pd-runtime-finalizing-");
  const journal = await openRuntimeSettlement(root, "finalizing", root);
  journal.begin("child");
  const result = await runOwnedChild({
    executionId: "child",
    ownershipDir: join(root, "owner"),
    cwd: root,
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    env: process.env,
    timeoutMs: 1000,
    onOwnership: (i) => journal.bind(i),
  });
  const finishing = journal.finish("child", result.cleanup, "known control failure");
  assert.notEqual((await journal.snapshot()).state, "idle");
  await finishing;
  assert.equal((await journal.snapshot()).state, "unknown");
});
