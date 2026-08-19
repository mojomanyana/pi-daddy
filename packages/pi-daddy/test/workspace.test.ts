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

test("a stale lease object cannot overwrite a successor's active metadata", async () => {
  const root = await gitWorkspace();
  const leaseDir = await tempDir("workspace-leases-");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
  const first = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "first" });
  const metadataPath = join(leaseDir, (await readdir(leaseDir)).find((name) => name.endsWith(".json"))!);
  const firstMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
  process.kill(firstMetadata.pid, "SIGKILL");
  let second;
  for (let i = 0; i < 50; i += 1) {
    try { second = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "second" }); break; }
    catch { await new Promise((r) => setTimeout(r, 20)); }
  }
  assert.ok(second);
  await assert.rejects(() => first.release("stale-release"), (error: Error & { code?: string }) =>
    error.code === "WORKSPACE_LEASE_STALE");
  assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).owner_id, "second");
  await second.release("test-complete");
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
