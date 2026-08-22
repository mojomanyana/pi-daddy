import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import {
  acquireWorkspaceLease,
  leaseAcquisitionOutcome,
  leaseReleaseLedgerOutcome,
  loadWorkspaceRegistry,
  resolveWorkspace,
  validateRegisteredWorkspace,
} from "../src/workspace.ts";
import { GovernanceRefusal } from "../src/refusals.ts";
import { leasePaths } from "../src/lease-record.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

/**
 * Reap lease holders even when a test FAILS.
 *
 * Measured: with a guard mutated, this file printed `not ok` and then hung past 900 seconds — the failing
 * test never reached its `release()`, so the live `flock` plus helper kept node's event loop alive. On CI
 * that turns a one-line assertion failure into a job timeout with no summary, and it is how an auditor
 * gets a false "untested" reading from a suite that actually caught the defect.
 */
const acquired: { release: (reason?: string) => Promise<unknown> }[] = [];
async function reapLeases() {
  for (const lease of acquired.splice(0)) await lease.release("test-teardown").catch(() => undefined);
}
after(reapLeases);
after(cleanupTempDirs);

/**
 * A stub `herdr` on `PATH`, so a test's outcome never depends on whether a real one is installed.
 *
 * `exec`, not a bare command: `execFile`'s timeout signals only the direct child, so an `sh` wrapper dies and
 * leaves its `sleep` orphaned and reparented — three runs of this file left three of them owned by init, and a
 * mutation sweep that runs the suite once per entry accumulates dozens. `exec` replaces the shell, so the
 * signal lands on the thing that is actually sleeping. (The same shape holds in production: the helper's
 * SIGKILL does not reach a hung `herdr`'s descendants.)
 */
async function stubHerdr(body: string) {
  const dir = await tempDir("fake-herdr-");
  await writeFile(join(dir, "herdr"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

/** Acquire a lease that is released no matter how the test ends. */
async function trackedLease(input: Parameters<typeof acquireWorkspaceLease>[0]) {
  const lease = await acquireWorkspaceLease(input);
  acquired.push(lease);
  return lease;
}

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
  const readA = await trackedLease({ workspace, access: "read", leaseDir, ownerId: "read-a" });
  const readB = await trackedLease({ workspace, access: "read", leaseDir, ownerId: "read-b" });
  const writer = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "writer" });
  await Promise.all([readA.release("completed"), readB.release("completed"), writer.release("completed")]);
});

test("same-workspace writers conflict before work while distinct workspaces proceed", async () => {
  const rootA = await gitWorkspace();
  const rootB = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const a = await validateRegisteredWorkspace({ workspaceId: "a", registeredRoot: rootA });
  const sameRootDifferentId = await validateRegisteredWorkspace({ workspaceId: "alias", registeredRoot: rootA });
  const b = await validateRegisteredWorkspace({ workspaceId: "b", registeredRoot: rootB });
  const first = await trackedLease({ workspace: a, access: "write", leaseDir, ownerId: "first" });
  await assert.rejects(
    () => acquireWorkspaceLease({ workspace: sameRootDifferentId, access: "write", leaseDir, ownerId: "second" }),
    (error: unknown) => {
      assert.equal((error as GovernanceRefusal).code, "WORKSPACE_WRITE_CONFLICT");
      return true;
    },
  );
  const other = await trackedLease({ workspace: b, access: "write", leaseDir, ownerId: "other" });
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
    try { recovered = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "next" }); break; }
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
  const stale = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "stale" });
  const metadataPath = join(leaseDir, (await readdir(leaseDir)).find((name) => name.endsWith(".json"))!);

  const successor = {
    version: 1, state: "active", token: "successor-token", owner_id: "second",
    workspace_id: "w1", root, pid: process.pid, acquired_at: new Date().toISOString(),
  };
  await writeFile(metadataPath, `${JSON.stringify(successor)}\n`);

  const outcome = await stale.release("stale-release");
  // `released-superseded`, not `released-unrecorded`: declining to overwrite a LIVE successor's record is
  // the token guard working, not a fault. Conflating the two made the one value that means "somebody must
  // be told" indistinguishable from the healthy case.
  assert.equal(outcome, "released-superseded", "a stale owner must not claim it recorded a handover");
  const after = JSON.parse(await readFile(metadataPath, "utf8"));
  assert.equal(after.owner_id, "second");
  assert.equal(after.token, "successor-token");
  assert.equal(after.state, "active", "the successor's live record must survive a stale release");
});

test("release reports `lost` instead of throwing when the helper is already gone", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const lease = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "doomed" });
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
  const first = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "first" });
  const metadataPath = join(leaseDir, (await readdir(leaseDir)).find((name) => name.endsWith(".json"))!);
  // The recorded pid must be the HELPER, which is what actually holds the lock file descriptor: `flock`
  // is not passed `--close`, so killing only the wrapper leaves the lock held by an orphan and every
  // later acquisition reports a conflict that no live writer explains (R-99, probe g35).
  process.kill(JSON.parse(await readFile(metadataPath, "utf8")).pid, "SIGKILL");
  await first.lost;
  let second;
  for (let i = 0; i < 60 && !second; i += 1) {
    try { second = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "second" }); }
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
  const first = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "first" });
  const metadataPath = join(leaseDir, (await readdir(leaseDir)).find((name) => name.endsWith(".json"))!);
  assert.equal(await first.release("done"), "released");
  // Truncated, hand-edited, or written by a future version. Reading this as `recovered: false` silently
  // downgrades "the previous writer may have died mid-write" to the reassuring answer (R-100).
  await writeFile(metadataPath, "{\"version\":1,\"state\":");
  const next = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "next" });
  assert.equal(next.recovered, "unknown");
  await next.release("test-complete");
});

/**
 * Pins the GROUP kill in teardown.
 *
 * NOT deterministic, despite an earlier version of this line saying so: the group kill enumerates members
 * at call time, so a stand-in child forked in the same instant as the deadline can survive. Observed
 * failing once under heavy concurrent load, passing 7/7 otherwise. It fails SAFE — a false failure, never
 * a false pass.
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
      recovered = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "recovery" });
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

/**
 * ADR-0034's stated negative: "Unsupported or ambiguous state refuses rather than silently falling back to
 * an in-memory lock." `acquireWorkspaceLease` declares `flockCommand` and `acquisitionTimeoutMs` — seams
 * that exist ONLY for testing — and no test used either, so the fail-closed half of the writer-lease design
 * was unverified. Silently falling back here would mean two governed writers believing they were alone.
 */
test("no working flock means no lease, never an unlocked one", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  await assert.rejects(
    () => acquireWorkspaceLease({
      workspace, access: "write", leaseDir, ownerId: "no-flock",
      flockCommand: join(root, "definitely-not-a-real-flock"),
    }),
    (error: unknown) => {
      assert.equal((error as GovernanceRefusal).code, "WORKSPACE_LEASE_STALE");
      return true;
    },
  );
});

/**
 * ADR-0034: "The registered root is realpathed, verified as a Git-registered worktree." Deleting the
 * `git worktree list` membership check left the suite green, because every fixture in this file `git init`s
 * first — so the worktree list always contained the root and the check could never fire. An operator-owned
 * config file whose path validator is untested is the same shape as R-77/R-78.
 */
test("a registered root that is not a Git worktree is refused", async () => {
  const plain = await tempDir("workspace-not-git-");
  await assert.rejects(
    () => validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: plain }),
    (error: unknown) => {
      assert.equal((error as GovernanceRefusal).code, "WORKSPACE_NOT_REGISTERED");
      return true;
    },
  );

  // A path INSIDE a worktree is not its root either: it would silently move the child's initial cwd.
  const root = await gitWorkspace();
  const inside = join(root, "nested");
  await mkdir(inside, { recursive: true });
  await assert.rejects(
    () => validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: inside }),
    (error: unknown) => {
      assert.equal((error as GovernanceRefusal).code, "WORKSPACE_NOT_REGISTERED");
      return true;
    },
  );
});

test("a malformed workspace registry grants nothing, loudly", async () => {
  const root = await gitWorkspace();
  const dir = await tempDir("workspace-bad-registry-");
  const cases: Record<string, unknown> = {
    "wrong-version.json": { version: 2, workspaces: { w1: { path: root } } },
    "workspaces-is-an-array.json": { version: 1, workspaces: [{ path: root }] },
    "no-workspaces.json": { version: 1 },
    "relative-path.json": { version: 1, workspaces: { w1: { path: "relative/dir" } } },
    "empty-id.json": { version: 1, workspaces: { "": { path: root } } },
    "path-is-not-a-string.json": { version: 1, workspaces: { w1: { path: 7 } } },
  };
  for (const [name, body] of Object.entries(cases)) {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(body));
    await assert.rejects(
      () => loadWorkspaceRegistry(path),
      (error: unknown) => {
        assert.equal((error as GovernanceRefusal).code, "WORKSPACE_NOT_REGISTERED", name);
        return true;
      },
      name,
    );
  }

  // Unreadable is also refused, rather than read as "no workspaces are registered".
  await assert.rejects(
    () => loadWorkspaceRegistry(join(dir, "does-not-exist.json")),
    (error: unknown) => {
      assert.equal((error as GovernanceRefusal).code, "WORKSPACE_NOT_REGISTERED");
      return true;
    },
  );
});

/**
 * `leaseAcquisitionOutcome` had no test at all, while its docstring asserted two R-numbered properties.
 * Both branches were deletable with the whole suite green: `read → "acquired"` drops R-105, and
 * `recovered === true → "acquired"` drops R-100.
 */
test("an acquisition outcome never claims an exclusion the kernel did not perform", () => {
  // A read lease takes no lock, so it cannot be an acquisition (R-105).
  assert.equal(leaseAcquisitionOutcome("read", false), "uncontended");
  assert.equal(leaseAcquisitionOutcome("read", true), "uncontended", "access decides first");
  assert.equal(leaseAcquisitionOutcome("read", "unknown"), "uncontended");
  // Only a CONFIRMED dead predecessor is a recovery. "unknown" is less evidence than a crash, not more,
  // so it must not be reported as one (R-100) — but it must not silently read as clean either.
  assert.equal(leaseAcquisitionOutcome("write", true), "recovered");
  assert.equal(leaseAcquisitionOutcome("write", false), "acquired");
  assert.equal(leaseAcquisitionOutcome("write", "unknown"), "acquired");
});

/**
 * The release vocabulary is the observability half of R-99/R-100/R-104 — the entire reason `release()`
 * returns a value instead of throwing. Misrouting `released-unrecorded`, `lost` and `retained` all to
 * `released` left the suite green, because the only assertion on the new counters was that they were zero.
 */
test("a release outcome maps to the ledger word that means it", () => {
  assert.equal(leaseReleaseLedgerOutcome("released", "completed"), "released");
  assert.equal(leaseReleaseLedgerOutcome("released", "timeout"), "timeout");
  // The alarm: the lock went back but the record does not say so, so the NEXT owner would report a
  // recovery that never happened unless this is ledgered distinctly.
  assert.equal(leaseReleaseLedgerOutcome("released-unrecorded", "completed"), "released-unrecorded");
  assert.equal(leaseReleaseLedgerOutcome("released-unrecorded", "timeout"), "released-unrecorded");
  // Healthy: a successor already owns the record. Previously indistinguishable from the alarm.
  assert.equal(leaseReleaseLedgerOutcome("released-superseded", "completed"), "released");
  // The lock evaporated under a live writer — NOT the same fact as an operator pressing stop.
  assert.equal(leaseReleaseLedgerOutcome("lost", "cancelled"), "lost");
  // Kept deliberately because a herdr writer tab would not close; the pane may still be live.
  assert.equal(leaseReleaseLedgerOutcome("retained", "failed"), "retained");
  // A read lease never locked, so it never handed anything back.
  assert.equal(leaseReleaseLedgerOutcome("not-held", "completed"), "uncontended");
});

test("attaching a child to a dead lease is refused, not ignored", () => {
  // Deleting this guard left the suite green. Attaching to a lease whose helper is gone means the child
  // runs with no crash-cleanup owner, which is R-93's failure mode one layer down.
  return (async () => {
    const root = await gitWorkspace();
    const leaseDir = await tempDir("workspace-leases-");
    const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
    const lease = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "doomed" });
    const metadataPath = join(leaseDir, (await readdir(leaseDir)).find((name) => name.endsWith(".json"))!);
    process.kill(JSON.parse(await readFile(metadataPath, "utf8")).pid, "SIGKILL");
    await lease.lost;
    assert.throws(
      () => lease.attachProcess(process.pid),
      (error: unknown) => {
        assert.equal((error as GovernanceRefusal).code, "WORKSPACE_LEASE_STALE");
        return true;
      },
    );
  })();
});

/**
 * A CLEAN release must not look like a crash to the helper.
 *
 * The `{release:true}` line is the only thing distinguishing "the owner handed the lease back" from "the
 * owner died" — on stdin close the helper signals the attached process unless it was told the release was
 * deliberate. Deleting that write left all 586 tests green, so the distinction was carried by one unpinned
 * line: after a normal handover the helper would SIGTERM whatever holds the attached pid, which under pid
 * reuse (R-101, accepted) is an unrelated process.
 *
 * The production change that breaks this: removing the `{release:true}` write from `release()`.
 */
test("a clean release leaves the attached process alone", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const lease = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "clean" });

  // A process the helper is told to clean up if its owner dies. It must survive a deliberate release.
  const attached = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await once(attached, "spawn");
    lease.attachProcess(attached.pid!);
    assert.equal(await lease.release("completed"), "released");

    // The helper exits on stdin close either way; what differs is whether it signals first. Give it longer
    // than its own SIGTERM→SIGKILL escalation (500ms) plus its exit timer (750ms).
    await new Promise((resolve) => setTimeout(resolve, 1400));
    assert.equal(
      attached.killed || attached.exitCode !== null || attached.signalCode !== null,
      false,
      "a deliberate handover must not be treated as a crash",
    );
  } finally {
    attached.kill("SIGKILL");
  }
});

/**
 * **R-146.** A retained lease must not stop its own process from exiting.
 *
 * `markRetained` deliberately leaves the kernel lock and the pane alone — the pane may still be live. It
 * left the *pipes* alone too, and the holder was spawned with three of them and never `unref`ed, so the
 * helper kept node's event loop alive and the parent could never exit. Measured before the fix: `exit=124`
 * (timed out) against `exit=0` for the same sequence ending in `release()`.
 *
 * It is reached in production from the herdr executor when `tab close` fails. **Which hosts it wedged:** only
 * those that let the event loop drain — pi's print mode (`dist/main.js` sets `process.exitCode` and returns)
 * and library consumers, i.e. ADR-0034's external controllers. Interactive and rpc mode call `process.exit()`,
 * which ignores pending handles *and* runs `exit` handlers, so there the process still left and the pane sweep
 * still ran. An earlier version of this docstring said the sweep was lost generally and cited `src/cli.ts`,
 * which has one subcommand (`init`) and can neither hold a lease nor open a pane — corrected in the source and
 * the register and left standing here, which is the failure this project keeps recording.
 *
 * **The production change that breaks this test** (rule 7): removing the `unref` block from
 * `markRetained`. The child then never exits and the first assertion fails on the deadline — bounded here,
 * rather than wedging the runner the way R-119's lease test did.
 *
 * The second assertion is the reason letting the parent go is safe rather than a leak: on parent exit the
 * helper sees EOF, makes its BOUNDED `herdr tab close` attempts, then releases anyway (R-102 — an
 * unreleasable lock strands a worktree with no in-product recovery, which is strictly worse than a
 * recorded failure to close). So a successor can still acquire.
 */
test("a retained lease releases its process, and the lock is recoverable afterwards", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  // Hermetic: `herdr` is stubbed and the per-attempt bound is passed, so this cannot depend on whether a real
  // herdr is installed — it is, on the machine this was written on, and inheriting the 15s default while the
  // successor loop waits 5s made the outcome ambient state in a suite advertised as fast and pure.
  const fakeBin = await stubHerdr("exit 1");
  const moduleUrl = pathToFileURL(join(process.cwd(), "src", "workspace.ts")).href;
  const code = `
    import { validateRegisteredWorkspace, acquireWorkspaceLease } from ${JSON.stringify(moduleUrl)};
    const workspace = await validateRegisteredWorkspace({workspaceId:"w1", registeredRoot:${JSON.stringify(root)}});
    const lease = await acquireWorkspaceLease({
      workspace, access:"write", leaseDir:${JSON.stringify(leaseDir)}, ownerId:"retainer",
      herdrCloseAttempts:1, herdrCloseTimeoutMs:800,
    });
    lease.attachHerdrTab("tab-that-will-not-close");
    await lease.markRetained("herdr-close-failed");
    process.stdout.write("RETAINED\\n");
  `;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
  });
  try {
    let output = "";
    holder.stdout.on("data", (chunk) => { output += String(chunk); });
    // The timer is CLEARED. Left dangling it kept the file alive for the whole deadline on every green run
    // — +10s on a suite advertised as fast — which is the same "a bound is not free" lesson as R-146 itself.
    let deadline: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      once(holder, "close").then(() => "exited" as const),
      new Promise<"hung">((resolve) => { deadline = setTimeout(() => resolve("hung"), 10_000); }),
    ]).finally(() => clearTimeout(deadline));
    assert.match(output, /RETAINED/, "the child never reached markRetained");
    assert.equal(
      exited,
      "exited",
      "a retained lease left the holding process unable to exit — the pipes to the lock helper are still " +
        "referenced, so any host that waits for the loop to drain (pi's print mode, a library consumer) " +
        "never leaves (R-146)",
    );
    assert.equal(holder.exitCode, 0);
  } finally {
    holder.kill("SIGKILL");
  }

  // The lock goes back on its own, so retention is recoverable rather than a stranded worktree (R-102).
  //
  // **What this configuration does not cover:** `herdrCloseAttempts: 1` above. At the production default of
  // ten attempts a second apart the lock is held for ~10s after the parent dies, which is longer than the
  // loop below waits — so this asserts that release HAPPENS, not that it happens promptly.
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  let successor;
  for (let i = 0; i < 200 && !successor; i += 1) {
    try { successor = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "successor" }); }
    catch (error) {
      if ((error as GovernanceRefusal).code !== "WORKSPACE_WRITE_CONFLICT") throw error;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  assert.ok(successor, "the retained lock was never released, so the worktree is stranded (R-102)");
  await successor.release("test-complete");
});

/**
 * **R-146, second half: a bound on retries is not a bound on time.**
 *
 * The helper's `herdr tab close` had no `timeout`, so a herdr that ACCEPTS the close and never answers
 * never called back — the retry counter never decremented, `giveUp()` never ran, no marker was written, and
 * the kernel lock was held forever. That is R-102's explicitly rejected outcome, and it was masked only by
 * the defect above: while the parent could not exit, EOF never arrived and an operator saw a hung `pi`
 * instead of a silent strand. Measured before the fix, with the `herdr` below: parent `exit=0` in 82ms,
 * `LOCK=HELD` with no marker, indefinitely.
 *
 * **The production change that breaks this test** (rule 7): removing the `{timeout, killSignal}` options
 * from the helper's `execFile`. The successor loop then exhausts and the assertion names the strand.
 */
test("a herdr that hangs on close does not strand the lock forever", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  // A herdr that accepts the close and never answers — the case a retry count cannot bound.
  const fakeBin = await stubHerdr("exec sleep 5");
  const moduleUrl = pathToFileURL(join(process.cwd(), "src", "workspace.ts")).href;
  const code = `
    import { validateRegisteredWorkspace, acquireWorkspaceLease } from ${JSON.stringify(moduleUrl)};
    const workspace = await validateRegisteredWorkspace({workspaceId:"w1", registeredRoot:${JSON.stringify(root)}});
    const lease = await acquireWorkspaceLease({
      workspace, access:"write", leaseDir:${JSON.stringify(leaseDir)}, ownerId:"retainer",
      herdrCloseAttempts:1, herdrCloseTimeoutMs:800,
    });
    lease.attachHerdrTab("tab-that-hangs");
    await lease.markRetained("herdr-close-failed");
    process.stdout.write("RETAINED\\n");
  `;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
  });
  try {
    // Bounded, like its sibling above. Unbounded, the mutation that reverts the retain-path `unref` made THIS
    // test wedge the runner forever instead of failing — R-119's shape, in the file whose other test exists to
    // stop it. `node:test` has no default per-test timeout, so the deadline has to be here.
    let deadline: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      once(holder, "close").then(() => "exited" as const),
      new Promise<"hung">((resolve) => { deadline = setTimeout(() => resolve("hung"), 20_000); }),
    ]).finally(() => clearTimeout(deadline));
    assert.equal(exited, "exited", "the holder never exited, so the retained lock cannot have been released");
    assert.equal(holder.exitCode, 0);
  } finally {
    holder.kill("SIGKILL");
  }

  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  let successor;
  for (let i = 0; i < 200 && !successor; i += 1) {
    try { successor = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "successor" }); }
    catch (error) {
      if ((error as GovernanceRefusal).code !== "WORKSPACE_WRITE_CONFLICT") throw error;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  assert.ok(
    successor,
    "a hung `herdr tab close` held the writer lock with no bound and no marker — every later acquisition " +
      "reports an active governed writer for a workspace nothing is running in (R-146, R-102)",
  );
  await successor.release("test-complete");
});

/**
 * **R-146: retention is terminal.** `markRetained` did not settle the lease, so a later `release()` ran the
 * whole clean handshake. Measured before the fix: it returned `released`, overwrote the record's
 * `retained:herdr-close-failed` with `completed`, and sent `{release:true}` so the helper exited `clean` and
 * never attempted the close — the pane retention exists to protect was abandoned, and the ledger asserted a
 * clean handover for a lease kept *because* a pane would not close.
 *
 * No in-tree caller does this. `WorkspaceLease` is a public export and `try { … } finally { release() }` is the
 * obvious shape for the ADR-0034 external controllers this fix is for, which is the whole reason it matters.
 *
 * **The production change that breaks this test** (rule 7): removing `releasing = true` / `settled =
 * "retained"` from `markRetained`.
 */
test("release() after markRetained answers `retained` and leaves the record alone", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const fakeBin = await stubHerdr("exit 1");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
  try {
    const lease = await trackedLease({
      workspace, access: "write", leaseDir, ownerId: "retainer",
      herdrCloseAttempts: 1, herdrCloseTimeoutMs: 500,
    });
    lease.attachHerdrTab("tab-that-will-not-close");
    await lease.markRetained("herdr-close-failed");

    const record = () => readFile(leasePaths(leaseDir, root).metadata, "utf8").then((raw) => JSON.parse(raw));
    assert.equal((await record()).release_reason, "retained:herdr-close-failed");

    assert.equal(await lease.release("completed"), "retained", "a retained lease is already settled");
    assert.equal(
      (await record()).release_reason,
      "retained:herdr-close-failed",
      "release() after retention rewrote the record, so the ledger claims a clean handover for a lease kept " +
        "because a pane would not close (R-146)",
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

/**
 * **R-152: `markRetained` must report what actually happened, because its caller ledgers whatever it says.**
 *
 * `releaseDelegationWorkspace` used to hardcode the word: `(await lease.markRetained(reason), "retained")`. So
 * the ledger asserted *"kept deliberately because a herdr writer tab would not close, so the pane may still be
 * live"* in three situations where that is false — a helper already dead (the lock is gone: the fact is `lost`,
 * which is the distinction R-103 added the outcome union for), a lease already cleanly released, and a
 * retention whose record could not be written.
 *
 * Making retention terminal (R-146) turned the first two from misleading into unfixable, since `release()`
 * afterwards answers from `settled` and never touches the record again.
 *
 * **The production change that breaks these tests** (rule 7): dropping `markRetained`'s liveness check, its
 * `settled` guard, or its return value.
 */
test("markRetained on a dead helper reports `lost`, not a retention", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const lease = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "o" });

  // Kill the holder the way a crash would, and wait for the lease to notice.
  const record = JSON.parse(await readFile(leasePaths(leaseDir, root).metadata, "utf8"));
  process.kill(record.pid, "SIGKILL");
  await Promise.race([lease.lost, new Promise((r) => setTimeout(r, 5_000))]);

  assert.equal(
    await lease.markRetained("herdr-close-failed"),
    "lost",
    "the helper is gone and the kernel lock with it — calling that a retention tells the operator a pane may " +
      "still be live and tells the next owner nothing crashed (R-103)",
  );
  const after = JSON.parse(await readFile(leasePaths(leaseDir, root).metadata, "utf8"));
  assert.notEqual(after.release_reason, "retained:herdr-close-failed", "a dead lease must not record retention");
});

test("markRetained after a clean release leaves the record and answers what really happened", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const lease = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "o" });

  assert.equal(await lease.release("completed"), "released");
  assert.equal(
    await lease.markRetained("herdr-close-failed"),
    "released",
    "terminality was one-directional: `release()` checked `settled` and `markRetained` did not, so a " +
      "completed handover could be rewritten into a retention — the mirror of the defect R-146 fixed",
  );
  const after = JSON.parse(await readFile(leasePaths(leaseDir, root).metadata, "utf8"));
  assert.equal(after.release_reason, "completed", "a settled lease's record must not be rewritten");
  assert.equal(await lease.release("completed"), "released", "and the memoized answer must not have flipped");
});

/**
 * **R-152, the bounds.** A caller bug is not a governance outcome, so an impossible bound throws rather than
 * refusing: a `GovernanceRefusal` carrying `WORKSPACE_LEASE_STALE` — which everywhere else in this package
 * means *the lease went stale* — invites an ADR-0034 controller to retry a call that can never succeed.
 *
 * The upper bound matters as much as the floor and was missed the first time: `setTimeout` truncates to 32
 * bits, so `Number.MAX_SAFE_INTEGER` becomes **1ms** and every `herdr tab close` is SIGKILLed before herdr can
 * act — the opposite extreme from the unbounded hang, equally silent. Measured: a 3s sleep called back in 3ms.
 *
 * **The production change that breaks this test** (rule 7): deleting a clause from the bound validation, or
 * moving it back below the read-lease early return, where it validated nothing.
 */
test("an impossible close bound throws, on read leases as well as write", async () => {
  // Replaces "a zero or negative close bound is refused, naming the parameter", which asserted a
  // `GovernanceRefusal` on the write path only and had no upper bound. Superseded, not weakened: this covers
  // both access modes, both ends of the range, fractions, and the exception TYPE that keeps a caller bug off
  // the governance channel.
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });

  const cases = [
    { field: "herdrCloseTimeoutMs", value: 0 },
    { field: "herdrCloseTimeoutMs", value: -1 },
    { field: "herdrCloseTimeoutMs", value: Number.NaN },
    { field: "herdrCloseTimeoutMs", value: Number.MAX_SAFE_INTEGER },
    { field: "herdrCloseTimeoutMs", value: 2_147_483_648 },
    { field: "herdrCloseAttempts", value: 0 },
    { field: "herdrCloseAttempts", value: 1.5 },
  ] as const;

  for (const access of ["write", "read"] as const) {
    for (const { field, value } of cases) {
      await assert.rejects(
        () => trackedLease({ workspace, access, leaseDir, ownerId: "o", [field]: value }),
        (error: unknown) => {
          assert.ok(error instanceof RangeError, `expected a RangeError for ${field}=${value}, got ${error}`);
          assert.ok(!(error instanceof GovernanceRefusal), "a caller bug must not travel as a governance refusal");
          assert.match((error as RangeError).message, new RegExp(field));
          return true;
        },
        `${access} lease accepted ${field}: ${String(value)}`,
      );
    }
  }
});

/**
 * **R-152: a retention whose record could not be written stays repairable.**
 *
 * Making retention terminal (R-146) settled the lease before knowing whether the record landed. When the write
 * failed — an unwritable lease directory, ENOSPC, a read-only mount — the record stayed `state: "active"`
 * while the ledger said `retained`, so the NEXT owner reported a phantom `recovered: true`; and the later
 * `release()` that would still have written the handover now answered from `settled` and never touched it.
 *
 * The residue, stated rather than implied: nothing here can write a record into a directory that refuses
 * writes. What this restores is the *repair* — an unsettled lease can still record a handover once the
 * condition clears, which is strictly more than the terminal version offered.
 *
 * **The production change that breaks this test** (rule 7): settling unconditionally rather than only when the
 * record was written.
 */
test("a retention whose record could not be written leaves the lease releasable", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const lease = await trackedLease({ workspace, access: "write", leaseDir, ownerId: "o" });

  await chmod(leaseDir, 0o500);
  try {
    assert.equal(await lease.markRetained("herdr-close-failed"), "retained", "the lock IS retained");
  } finally {
    await chmod(leaseDir, 0o700);
  }

  assert.equal(
    await lease.release("completed"),
    "released",
    "the retention was never recorded, so the lease must still be releasable — settled terminally, the " +
      "record stays `active` for ever and the next owner reports a crash that never happened (R-152)",
  );
  const after = JSON.parse(await readFile(leasePaths(leaseDir, root).metadata, "utf8"));
  assert.equal(after.release_reason, "completed", "the repair must actually write the handover");
});
