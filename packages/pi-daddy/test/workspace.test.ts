import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import {
  acquireWorkspaceLease,
  loadWorkspaceRegistry,
  resolveWorkspace,
  validateRegisteredWorkspace,
} from "../src/workspace.ts";
import { GovernanceRefusal } from "../src/refusals.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

async function gitWorkspace() {
  const root = await tempDir("workspace-root-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "x\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  return root;
}

test("workspace registry resolves IDs to validated Git worktrees and rejects misrouting", async () => {
  const root = await gitWorkspace();
  const other = await tempDir("workspace-other-");
  const registryPath = join(await tempDir("workspace-registry-"), "registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, workspaces: { w1: { path: root } } }));
  const registry = await loadWorkspaceRegistry(registryPath);
  const resolved = await resolveWorkspace(registry, "w1");
  assert.equal(resolved.root, root);
  await assert.rejects(() => validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root, suppliedRoot: other }), (error: unknown) => {
    assert.equal((error as GovernanceRefusal).code, "WORKSPACE_NOT_REGISTERED");
    return true;
  });
  await assert.rejects(() => resolveWorkspace(registry, "missing"), (error: unknown) => {
    assert.equal((error as GovernanceRefusal).code, "WORKSPACE_NOT_REGISTERED");
    return true;
  });
});

test("read/read and read/write may share a workspace", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const readA = await acquireWorkspaceLease({ workspace, access: "read", leaseDir, ownerId: "read-a" });
  const readB = await acquireWorkspaceLease({ workspace, access: "read", leaseDir, ownerId: "read-b" });
  const writer = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "writer" });
  await Promise.all([readA.release("completed"), readB.release("completed"), writer.release("completed")]);
});

test("same-workspace writers conflict before work while distinct workspaces proceed", async () => {
  const rootA = await gitWorkspace();
  const rootB = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const a = await validateRegisteredWorkspace({ workspaceId: "a", registeredRoot: rootA });
  const sameRootDifferentId = await validateRegisteredWorkspace({ workspaceId: "alias", registeredRoot: rootA });
  const b = await validateRegisteredWorkspace({ workspaceId: "b", registeredRoot: rootB });
  const first = await acquireWorkspaceLease({ workspace: a, access: "write", leaseDir, ownerId: "first" });
  await assert.rejects(
    () => acquireWorkspaceLease({ workspace: sameRootDifferentId, access: "write", leaseDir, ownerId: "second" }),
    (error: unknown) => {
      assert.equal((error as GovernanceRefusal).code, "WORKSPACE_WRITE_CONFLICT");
      return true;
    },
  );
  const other = await acquireWorkspaceLease({ workspace: b, access: "write", leaseDir, ownerId: "other" });
  await Promise.all([first.release("completed"), other.release("completed")]);
});

test("an already-cancelled lease request starts no holder", async () => {
  const root = await gitWorkspace();
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const controller = new AbortController();
  const leaseDir = await tempDir("workspace-leases-");
  controller.abort();
  await assert.rejects(
    () => acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "cancelled", signal: controller.signal }),
    (error: unknown) => {
      assert.equal((error as GovernanceRefusal).code, "WORKSPACE_WRITE_CONFLICT");
      return true;
    },
  );
});

test("parent SIGKILL stops the attached writer before releasing the lease", async () => {
  const root = await gitWorkspace();
  const marker = join(root, "LATE_WRITE");
  const leaseDir = await tempDir("workspace-leases-");
  const moduleUrl = pathToFileURL(join(process.cwd(), "src", "workspace.ts")).href;
  const code = `
    import { spawn } from "node:child_process";
    import { validateRegisteredWorkspace, acquireWorkspaceLease } from ${JSON.stringify(moduleUrl)};
    const workspace = await validateRegisteredWorkspace({workspaceId:"w1", registeredRoot:${JSON.stringify(root)}});
    const lease = await acquireWorkspaceLease({workspace, access:"write", leaseDir:${JSON.stringify(leaseDir)}, ownerId:"parent"});
    const child = spawn(process.execPath,["-e",${JSON.stringify(`setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)},"late"),1000);setInterval(()=>{},1000)`)}]);
    lease.attachProcess(child.pid);
    process.stdout.write("READY\\n");
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  parent.stdout.on("data", (chunk) => { output += String(chunk); });
  for (let i = 0; i < 100 && !output.includes("READY"); i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.match(output, /READY/);
  parent.kill("SIGKILL");
  await once(parent, "close");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  let recovered;
  for (let i = 0; i < 100; i += 1) {
    try { recovered = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "next" }); break; }
    catch (error) {
      if ((error as GovernanceRefusal).code !== "WORKSPACE_WRITE_CONFLICT") throw error;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  assert.ok(recovered);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(existsSync(marker), false, "a writer surviving its parent must not overlap the successor");
  await recovered.release("test-complete");
});

/**
 * Pins the token comparison in `release()`, which nothing pinned before: the previous version of this
 * test killed the recorded pid first, so `release()` short-circuited on a dead holder and the guard was
 * never reached — mutating `if (current?.token === token)` to `if (true)` left the suite green. Here the
 * stale owner's helper is deliberately STILL ALIVE, so release runs the whole body.
 */
test("a stale lease object cannot overwrite a successor's active metadata", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const stale = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "stale" });
  const metadataPath = join(leaseDir, (await readdir(leaseDir)).find((name) => name.endsWith(".json"))!);

  const successor = {
    version: 1, state: "active", token: "successor-token", owner_id: "second",
    workspace_id: "w1", root, pid: process.pid, acquired_at: new Date().toISOString(),
  };
  await writeFile(metadataPath, `${JSON.stringify(successor)}\n`);

  const outcome = await stale.release("stale-release");
  assert.equal(outcome, "released-unrecorded", "a stale owner must not claim it recorded a handover");
  const after = JSON.parse(await readFile(metadataPath, "utf8"));
  assert.equal(after.owner_id, "second");
  assert.equal(after.token, "successor-token");
  assert.equal(after.state, "active", "the successor's live record must survive a stale release");
});

test("release reports `lost` instead of throwing when the helper is already gone", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const lease = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "doomed" });
  const metadataPath = join(leaseDir, (await readdir(leaseDir)).find((name) => name.endsWith(".json"))!);
  process.kill(JSON.parse(await readFile(metadataPath, "utf8")).pid, "SIGKILL");
  await lease.lost;
  // Throwing here discarded a COMPLETED child's entire output and masked whatever error was already in
  // flight, because every caller releases from a cleanup path (R-99). The outcome is a value now.
  assert.equal(await lease.release("after-loss"), "lost");
});

test("killing the recorded helper pid really does free the kernel lock", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const first = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "first" });
  const metadataPath = join(leaseDir, (await readdir(leaseDir)).find((name) => name.endsWith(".json"))!);
  // The recorded pid must be the HELPER, which is what actually holds the lock file descriptor: `flock`
  // is not passed `--close`, so killing only the wrapper leaves the lock held by an orphan and every
  // later acquisition reports a conflict that no live writer explains (R-99, probe g35).
  process.kill(JSON.parse(await readFile(metadataPath, "utf8")).pid, "SIGKILL");
  await first.lost;
  let second;
  for (let i = 0; i < 60 && !second; i += 1) {
    try { second = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "second" }); }
    catch (error) {
      assert.equal((error as GovernanceRefusal).code, "WORKSPACE_WRITE_CONFLICT");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  assert.ok(second, "the lock must be free once the recorded helper is dead");
  await second.release("test-complete");
});

test("an unreadable predecessor record yields `unknown` recovery, never a clean handover", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const first = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "first" });
  const metadataPath = join(leaseDir, (await readdir(leaseDir)).find((name) => name.endsWith(".json"))!);
  assert.equal(await first.release("done"), "released");
  // Truncated, hand-edited, or written by a future version. Reading this as `recovered: false` silently
  // downgrades "the previous writer may have died mid-write" to the reassuring answer (R-100).
  await writeFile(metadataPath, "{\"version\":1,\"state\":");
  const next = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "next" });
  assert.equal(next.recovered, "unknown");
  await next.release("test-complete");
});

/**
 * Pins the GROUP kill in teardown, deterministically.
 *
 * `flock` is not passed `--close`, so the helper it execs inherits the lock file descriptor and holds
 * the lock in its own right — measured in `docs/probes/g35-flock-fd-inheritance`. On the readiness
 * -timeout path the helper's pid is usually still unknown, so killing only the wrapper leaves a
 * half-booted helper holding the lock forever, and every later acquisition then reports a conflict that
 * no live writer explains (R-99).
 *
 * Forcing that race through the real `flock` is not reliable — at a 1ms timeout `flock` has usually not
 * forked yet, so the lock is genuinely free and the test passes whether or not the fix is present. This
 * uses a stand-in that behaves like the hazard instead: it never reports readiness and it leaves a child
 * lingering in its process group. Killing the group reaps that child; killing the wrapper does not.
 */
test("teardown kills the whole holder group, not just the wrapper", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const scriptDir = await tempDir("workspace-stub-flock-");
  const pidFile = join(scriptDir, "lingering.pid");
  const stub = join(scriptDir, "stub-flock.sh");
  await writeFile(stub, "#!/bin/sh\nsh -c 'echo $$ > \"$PI_TEST_LINGERING_PID\"; exec sleep 30' &\nwait\n", { mode: 0o755 });

  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  process.env.PI_TEST_LINGERING_PID = pidFile;
  try {
    await assert.rejects(
      () => acquireWorkspaceLease({
        workspace, access: "write", leaseDir, ownerId: "never-ready",
        flockCommand: stub, acquisitionTimeoutMs: 400,
      }),
      (error: unknown) => {
        assert.equal((error as GovernanceRefusal).code, "WORKSPACE_LEASE_STALE");
        return true;
      },
    );
    const lingering = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(Number.isInteger(lingering) && lingering > 0, "the stand-in must have recorded its child");
    let alive = true;
    for (let i = 0; i < 40 && alive; i += 1) {
      try { process.kill(lingering, 0); await new Promise((r) => setTimeout(r, 25)); }
      catch { alive = false; }
    }
    assert.equal(alive, false, "a timed-out acquisition must not leave a descendant holding the lock");
  } finally {
    delete process.env.PI_TEST_LINGERING_PID;
  }
});

test("SIGKILL releases the kernel lease and the next owner records recovery", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const moduleUrl = pathToFileURL(join(process.cwd(), "src", "workspace.ts")).href;
  const code = `
    import { validateRegisteredWorkspace, acquireWorkspaceLease } from ${JSON.stringify(moduleUrl)};
    const workspace = await validateRegisteredWorkspace({workspaceId:"w1", registeredRoot:${JSON.stringify(root)}});
    await acquireWorkspaceLease({workspace, access:"write", leaseDir:${JSON.stringify(leaseDir)}, ownerId:"crashed"});
    process.stdout.write("READY\\n");
    setInterval(() => {}, 1000);
  `;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  holder.stdout.on("data", (chunk) => { output += String(chunk); });
  for (let i = 0; i < 100 && !output.includes("READY"); i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.match(output, /READY/);
  holder.kill("SIGKILL");
  await once(holder, "close");

  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  let recovered;
  for (let i = 0; i < 40; i += 1) {
    try {
      recovered = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "recovery" });
      break;
    } catch (error) {
      if ((error as GovernanceRefusal).code !== "WORKSPACE_WRITE_CONFLICT") throw error;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  assert.ok(recovered, "the helper must release when its parent pipe closes");
  assert.equal(recovered.recovered, true);
  await recovered.release("recovered");
});
