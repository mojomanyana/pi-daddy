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

/**
 * The check runner's whole refusal surface had zero coverage: `CHECK_NOT_CONFIGURED`,
 * `CHECK_CONFIGURATION_INVALID`, `CHECK_IDENTITY_UNAVAILABLE` and `EXECUTOR_UNAVAILABLE` appeared nowhere
 * in `test/`, and `test/refusals.test.ts` — whose stated job is guarding the stable taxonomy — enumerated
 * eleven of the codes and omitted every `CHECK_*` one. So ADR-0034's "the check runner accepts a named ID
 * only" bullet was asserted and undefended.
 */
test("a check the operator did not configure is refused by name", async () => {
  const ws = await workspace();
  await assert.rejects(
    () => runNamedCheck({ checkId: "nosuch", registry: { version: 1, checks: {} }, workspace: ws }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "CHECK_NOT_CONFIGURED");
      return true;
    },
  );
});

test("a malformed check definition is refused rather than normalised", async () => {
  const ws = await workspace();
  const cases: Record<string, unknown> = {
    "relative-executable": { executable: "node", argv: [] },
    "argv-not-an-array": { executable: process.execPath, argv: "-e 1" },
    "argv-holds-a-non-string": { executable: process.execPath, argv: ["-e", 7] },
    "zero-timeout": { executable: process.execPath, argv: ["-e", "1"], timeout_ms: 0 },
    "negative-output-bound": { executable: process.execPath, argv: ["-e", "1"], max_output_bytes: -1 },
    "SECRET TASK TEXT": { executable: process.execPath, argv: ["-e", "process.exit(0)"] },
  };
  for (const [checkId, definition] of Object.entries(cases)) {
    await assert.rejects(
      () => runNamedCheck({
        checkId,
        registry: { version: 1, checks: { [checkId]: definition } } as never,
        workspace: ws,
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "CHECK_CONFIGURATION_INVALID", checkId);
        return true;
      },
      checkId,
    );
  }

  // The registry envelope itself, not just an entry inside it.
  await assert.rejects(
    () => runNamedCheck({ checkId: "x", registry: { version: 2, checks: {} } as never, workspace: ws }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "CHECK_CONFIGURATION_INVALID");
      return true;
    },
  );
});

test("an evidence check declared `read` still takes the exclusive writer lease", async () => {
  // `src/check-runner.ts` hardcodes `leaseAccess = "write"` with a comment explaining that a check's
  // pre/post candidate identities are worthless if another governed writer can interleave. Changing that
  // line to `leaseAccess = access` left the suite green, so the comment was the only thing enforcing it.
  const ws = await workspace();
  const leaseDir = await tempDir("check-read-lease-");
  const held = await acquireWorkspaceLease({ workspace: ws, access: "write", leaseDir, ownerId: "other-writer" });
  try {
    await assert.rejects(
      () => runNamedCheck({
        checkId: "declared-read",
        registry: {
          version: 1,
          checks: { "declared-read": { executable: process.execPath, argv: ["-e", "1"], workspace_access: "read" } },
        },
        workspace: ws,
        leaseDir,
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "WORKSPACE_WRITE_CONFLICT");
        return true;
      },
      "a read-declared check must still contend for the workspace",
    );
  } finally {
    await held.release("test-complete");
  }
});

test("the staged copy is what executes, not the configured pathname", async () => {
  // SPEC calls this "those exact hashed bytes are executed, eliminating pathname replacement between
  // hashing and spawn". The existing digest test cannot see the difference — all of its assertions hold
  // when the original file is executed in place — so swapping `stagedExecutable` back to `executable` left
  // the suite green and the whole TOCTOU staging step was undefended.
  //
  // `$0` is the discriminator: the staged copy lives in a `pi-daddy-check-exec-*` temp directory, the
  // configured one does not.
  const ws = await workspace();
  const scriptDir = await tempDir("check-staging-src-");
  const script = join(scriptDir, "whoami.sh");
  await writeFile(script, "#!/bin/sh\nprintf '%s' \"$0\"\n", { mode: 0o755 });

  const result = await runNamedCheck({
    checkId: "staged-identity",
    registry: { version: 1, checks: { "staged-identity": { executable: script, argv: [] } } },
    workspace: ws,
    leaseDir: await tempDir("check-staging-lease-"),
  });

  assert.equal(result.exitCode, 0);
  assert.match(
    result.output.trim(),
    /pi-daddy-check-exec-/,
    `the check must run from its private staged copy, not ${script}`,
  );
  assert.equal(
    result.output.trim().startsWith(scriptDir),
    false,
    "running the configured pathname reopens the hash-then-spawn replacement window",
  );
});
