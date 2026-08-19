import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { runNamedCheck } from "../src/check-runner.ts";
import { computeGitCandidateIdentity } from "../src/git-identity.ts";
import { acquireWorkspaceLease, validateRegisteredWorkspace } from "../src/workspace.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";

after(cleanupTempDirs);

async function workspace() {
  const root = await tempDir("check-workspace-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "x\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  return validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: root });
}

test("named checks use exact argv with no shell interpolation", async () => {
  const ws = await workspace();
  const marker = join(ws.root, "SHELL_INTERPOLATED");
  const hostile = `; touch ${marker}; $(echo pwned)`;
  const result = await runNamedCheck({
    checkId: "literal-argv",
    registry: {
      version: 1,
      checks: {
        "literal-argv": {
          executable: process.execPath,
          argv: ["-e", "process.stdout.write(process.argv[1])", hostile],
          workspace_access: "read",
        },
      },
    },
    workspace: ws,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, hostile);
  assert.equal(existsSync(marker), false, "metacharacters must remain one literal argv element");
  assert.deepEqual(result.receipt.argv, ["-e", "process.stdout.write(process.argv[1])", hostile]);
  assert.equal(result.receipt.executable, process.execPath);
  assert.match(result.receipt.executable_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.receipt.argv_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.receipt.cwd, ws.root);
  assert.match(result.receipt.cwd_sha256, /^[a-f0-9]{64}$/);
});

test("check environment is allowlisted and sensitive inherited names are stripped", async () => {
  const ws = await workspace();
  const result = await runNamedCheck({
    checkId: "env",
    registry: {
      version: 1,
      checks: {
        env: {
          executable: process.execPath,
          argv: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
          inherit_env: ["LANG", "SECRET_TOKEN", "PI_GRANTS_GRANT"],
          env: { FIXED: "yes" },
          workspace_access: "read",
        },
      },
    },
    workspace: ws,
    inheritedEnv: { LANG: "C", SECRET_TOKEN: "secret", PI_GRANTS_GRANT: "tool:*", UNLISTED: "no" },
  });
  const env = JSON.parse(result.output);
  assert.equal(env.LANG, "C");
  assert.equal(env.FIXED, "yes");
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.equal(env.PI_GRANTS_GRANT, undefined);
  assert.equal(env.UNLISTED, undefined);
});

test("receipt captures exit, signal, timeout, output digest, and exact candidate tree", async () => {
  const ws = await workspace();
  const base = {
    checkId: "fails",
    registry: { version: 1 as const, checks: { fails: {
      executable: process.execPath,
      argv: ["-e", "process.stderr.write('bad'); process.exit(7)"],
      workspace_access: "read" as const,
    } } },
    workspace: ws,
    correlation: { run_id: "run-1", task_id: "task-1" },
  };
  const expected = await computeGitCandidateIdentity(ws);
  const first = await runNamedCheck(base);
  assert.equal(first.receipt.exit_code, 7);
  assert.equal(first.receipt.signal, null);
  assert.equal(first.receipt.timed_out, false);
  assert.equal(first.receipt.head_sha, expected.headSha);
  assert.equal(first.receipt.tree_sha, expected.treeSha);
  assert.match(first.receipt.output_sha256, /^[a-f0-9]{64}$/);
  await writeFile(join(ws.root, "README.md"), "changed\n");
  const changed = await runNamedCheck(base);
  assert.notEqual(changed.receipt.tree_sha, first.receipt.tree_sha, "an uncommitted-tree change must produce a new identity");
});

test("receipt executable digest names the staged bytes that actually ran", async () => {
  const ws = await workspace();
  const bin = await tempDir("check-executable-");
  const executable = join(bin, "owned-check");
  const original = `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(executable)},'replaced');process.stdout.write('ORIGINAL')\n`;
  await writeFile(executable, original);
  await chmod(executable, 0o755);
  const result = await runNamedCheck({
    checkId: "staged",
    registry: { version: 1, checks: { staged: { executable, argv: [] } } },
    workspace: ws,
  });
  assert.equal(result.output, "ORIGINAL");
  assert.equal(result.receipt.executable_sha256, createHash("sha256").update(original).digest("hex"));
  assert.equal(await readFile(executable, "utf8"), "replaced");
});

test("caller-supplied head/tree values cannot override validated Git identity", async () => {
  const ws = await workspace();
  await assert.rejects(
    () => runNamedCheck({
      checkId: "identity",
      registry: { version: 1, checks: { identity: { executable: process.execPath, argv: ["-e", ""] } } },
      workspace: ws,
      correlation: { head_sha: "a".repeat(40), tree_sha: "b".repeat(40) },
    }),
    (error: Error & { code?: string }) => error.code === "CHECK_IDENTITY_MISMATCH",
  );
});

test("named-check lease and receipt events are joinable", async () => {
  const ws = await workspace();
  const ledgerPath = join(await tempDir("check-ledger-"), "ledger.jsonl");
  await runNamedCheck({
    checkId: "join",
    registry: { version: 1, checks: { join: { executable: process.execPath, argv: ["-e", ""] } } },
    workspace: ws,
    ledgerPath,
  });
  const events = (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => `${event.event}:${event.outcome ?? "receipt"}`), [
    "workspace_lease:acquired", "workspace_lease:released", "check_receipt:receipt",
  ]);
  assert.ok(events.every((event) => event.childId === events[0].childId));
});

test("a check that changes candidate content cannot issue a stale receipt", async () => {
  const ws = await workspace();
  await assert.rejects(
    () => runNamedCheck({
      checkId: "mutates",
      registry: { version: 1, checks: { mutates: {
        executable: process.execPath,
        argv: ["-e", "require('fs').writeFileSync('README.md','mutated\\n')"],
      } } },
      workspace: ws,
    }),
    (error: Error & { code?: string }) => error.code === "CHECK_IDENTITY_MISMATCH",
  );
});

test("a check that loses its kernel lease emits no receipt", async () => {
  const ws = await workspace();
  const leaseDir = await tempDir("check-lost-lease-");
  const ledgerPath = join(await tempDir("check-lost-ledger-"), "ledger.jsonl");
  const ready = join(await tempDir("check-lost-ready-"), "READY");
  const running = runNamedCheck({
    checkId: "lost",
    registry: { version: 1, checks: { lost: {
      executable: process.execPath,
      argv: ["-e", `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`],
    } } },
    workspace: ws,
    leaseDir,
    ledgerPath,
  });
  for (let i = 0; i < 100 && !existsSync(ready); i += 1) await new Promise((r) => setTimeout(r, 20));
  const metadataPath = join(leaseDir, (await readdir(leaseDir)).find((name) => name.endsWith(".json"))!);
  process.kill(JSON.parse(await readFile(metadataPath, "utf8")).pid, "SIGKILL");
  await assert.rejects(running, (error: Error & { code?: string }) => error.code === "WORKSPACE_LEASE_STALE");
  const events = (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.some((event) => event.event === "check_receipt"), false);
});

test("parent SIGKILL stops a named check before releasing its workspace lease", async () => {
  const ws = await workspace();
  const leaseDir = await tempDir("check-crash-leases-");
  const ready = join(ws.root, "CHECK_READY");
  const late = join(ws.root, "CHECK_LATE_WRITE");
  const checkUrl = pathToFileURL(join(process.cwd(), "src", "check-runner.ts")).href;
  const workspaceUrl = pathToFileURL(join(process.cwd(), "src", "workspace.ts")).href;
  const childCode = `
    import {runNamedCheck} from ${JSON.stringify(checkUrl)};
    import {validateRegisteredWorkspace} from ${JSON.stringify(workspaceUrl)};
    const workspace=await validateRegisteredWorkspace({workspaceId:"w1",registeredRoot:${JSON.stringify(ws.root)}});
    await runNamedCheck({checkId:"crash",registry:{version:1,checks:{crash:{executable:process.execPath,argv:["-e",${JSON.stringify(`require("fs").writeFileSync(${JSON.stringify(ready)},"ready");setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(late)},"late"),1000);setInterval(()=>{},1000)`)}]}}},workspace,leaseDir:${JSON.stringify(leaseDir)}});
  `;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", childCode], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(ready); i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.equal(existsSync(ready), true);
  parent.kill("SIGKILL");
  await once(parent, "close");
  let next;
  for (let i = 0; i < 100; i += 1) {
    try { next = await acquireWorkspaceLease({ workspace: ws, access: "write", leaseDir, ownerId: "next" }); break; }
    catch { await new Promise((r) => setTimeout(r, 25)); }
  }
  assert.ok(next);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(existsSync(late), false);
  await next.release("test-complete");
});

test("timeout and output cap remain hard bounds, and timeout releases the writer lease", async () => {
  const ws = await workspace();
  const leaseDir = await tempDir("check-leases-");
  const timed = await runNamedCheck({
    checkId: "hang",
    registry: { version: 1, checks: { hang: { executable: process.execPath, argv: ["-e", "setInterval(()=>{},1000)"], timeout_ms: 50 } } },
    workspace: ws,
    leaseDir,
  });
  assert.equal(timed.receipt.timed_out, true);

  // Same root and same lease directory: success proves timeout cleanup, not merely a second lock key.
  const flood = await runNamedCheck({
    checkId: "flood",
    registry: { version: 1, checks: { flood: { executable: process.execPath, argv: ["-e", "process.stdout.write('x'.repeat(10000))"], max_output_bytes: 128 } } },
    workspace: ws,
    leaseDir,
  });
  assert.equal(flood.receipt.truncated, true);
  assert.ok(Buffer.byteLength(flood.output) <= 128);
});
