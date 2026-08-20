#!/usr/bin/env node
/**
 * G35 — does the command `flock` runs inherit the lock file descriptor?
 *
 * The 0.18.0 writer lease spawns `flock <lockfile> node <helper>` and, on two teardown paths, SIGKILLed
 * the `flock` wrapper to release the lock. Two independent reviewers disagreed about whether that works:
 * one reported measuring an orphan that kept the lock, the other reported that `flock` sets `FD_CLOEXEC`
 * so only a stray process leaks. This settles it by measurement rather than by reading the man page.
 *
 * Run from the repository root:
 *   node docs/probes/g35-flock-fd-inheritance/probe.mjs
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tryAcquire(lockPath) {
  try {
    await execFileAsync("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "73", lockPath, "true"]);
    return "free";
  } catch (error) {
    return error?.code === 73 ? "held" : `error:${error?.code ?? String(error)}`;
  }
}

const dir = await mkdtemp(join(tmpdir(), "g35-flock-"));
const findings = {};
try {
  const lockPath = join(dir, "L");
  await writeFile(lockPath, "");
  const childScript = join(dir, "child.js");
  await writeFile(childScript, 'process.stdout.write("CHILD:" + process.pid + "\\n");\nsetInterval(() => {}, 1000);\n');

  const version = (await execFileAsync("flock", ["--version"])).stdout.trim();
  findings.flock_version = version;
  findings.close_flag_documented = (await execFileAsync("flock", ["--help"])).stdout.includes("--close");

  const holder = spawn("flock", [
    "--exclusive", "--nonblock", "--conflict-exit-code", "73", lockPath,
    process.execPath, childScript,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let out = "";
  holder.stdout.on("data", (chunk) => { out += String(chunk); });
  for (let i = 0; i < 100 && !out.includes("CHILD:"); i += 1) await sleep(25);
  const childPid = Number(out.match(/CHILD:(\d+)/)?.[1]);
  findings.child_pid_observed = Number.isInteger(childPid);

  // Does the exec'd command hold an fd on the lock file at all?
  const fds = await execFileAsync("sh", ["-c", `ls -l /proc/${childPid}/fd 2>/dev/null | grep -c ${lockPath} || true`]);
  findings.child_holds_lock_fd = Number(fds.stdout.trim()) > 0;

  findings.held_while_both_alive = await tryAcquire(lockPath);

  // Kill ONLY the wrapper. This is what the buggy teardown path did.
  process.kill(holder.pid, "SIGKILL");
  await sleep(1000);
  let childAlive = true;
  try { process.kill(childPid, 0); } catch { childAlive = false; }
  findings.child_survives_wrapper_kill = childAlive;
  findings.held_after_wrapper_kill_only = await tryAcquire(lockPath);

  // Now kill the command too, which is what killing the process GROUP achieves.
  try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
  await sleep(500);
  findings.held_after_child_kill = await tryAcquire(lockPath);

  findings.conclusion = findings.held_after_wrapper_kill_only === "held" && findings.held_after_child_kill === "free"
    ? "the exec'd command inherits the lock fd; killing only the wrapper LEAVES THE LOCK HELD"
    : "inconclusive on this platform — re-read the findings above before trusting either reading";
} finally {
  await rm(dir, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ node: process.version, platform: process.platform, findings }, null, 2)}\n`);
