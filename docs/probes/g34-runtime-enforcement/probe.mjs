#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const workspaceModule = await import(pathToFileURL(join(root, "packages/pi-daddy/src/workspace.ts")));
const checkModule = await import(pathToFileURL(join(root, "packages/pi-daddy/src/check-runner.ts")));
const { acquireWorkspaceLease, validateRegisteredWorkspace } = workspaceModule;
const { runNamedCheck } = checkModule;
const dirs = [];
const temp = async (prefix) => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(path);
  return path;
};
const gitWorkspace = async () => {
  const path = await temp("pi-daddy-g34-workspace-");
  execFileSync("git", ["init", "-q"], { cwd: path });
  execFileSync("git", ["config", "user.email", "probe@example.invalid"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Probe"], { cwd: path });
  await writeFile(join(path, "README.md"), "probe\n");
  execFileSync("git", ["add", "."], { cwd: path });
  execFileSync("git", ["commit", "-qm", "probe"], { cwd: path });
  return path;
};

const findings = {};
try {
  const leaseDir = await temp("pi-daddy-g34-leases-");
  const rootA = await gitWorkspace();
  const rootB = await gitWorkspace();
  const a = await validateRegisteredWorkspace({ workspaceId: "a", registeredRoot: rootA });
  const b = await validateRegisteredWorkspace({ workspaceId: "b", registeredRoot: rootB });

  const first = await acquireWorkspaceLease({ workspace: a, access: "write", leaseDir, ownerId: "first" });
  try {
    await acquireWorkspaceLease({ workspace: a, access: "write", leaseDir, ownerId: "second" });
    findings.same_workspace_conflict = "FAILED: second writer acquired";
  } catch (error) {
    findings.same_workspace_conflict = error.code;
  }
  const other = await acquireWorkspaceLease({ workspace: b, access: "write", leaseDir, ownerId: "other" });
  findings.distinct_workspace_parallel = "acquired";
  await Promise.all([first.release("probe"), other.release("probe")]);

  const workspaceUrl = pathToFileURL(join(root, "packages/pi-daddy/src/workspace.ts")).href;
  const crashRecovery = async (signal, label) => {
    const lateMarker = join(rootA, `LATE_WRITE_${label}`);
    const workerCode = `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(lateMarker)},"late"),1000);setInterval(()=>{},1000)`;
    const holderCode = `
      import {spawn} from "node:child_process";
      import {validateRegisteredWorkspace,acquireWorkspaceLease} from ${JSON.stringify(workspaceUrl)};
      const w=await validateRegisteredWorkspace({workspaceId:"a",registeredRoot:${JSON.stringify(rootA)}});
      const lease=await acquireWorkspaceLease({workspace:w,access:"write",leaseDir:${JSON.stringify(leaseDir)},ownerId:${JSON.stringify(label)}});
      const child=spawn(process.execPath,["-e",${JSON.stringify(workerCode)}]);
      lease.attachProcess(child.pid);
      process.stdout.write("READY\\n");setInterval(()=>{},1000);
    `;
    const holder = spawn(process.execPath, ["--input-type=module", "-e", holderCode], { stdio: ["ignore", "pipe", "pipe"] });
    let holderOut = "";
    holder.stdout.on("data", (chunk) => { holderOut += String(chunk); });
    for (let i = 0; i < 100 && !holderOut.includes("READY"); i += 1) await new Promise((r) => setTimeout(r, 20));
    if (!holderOut.includes("READY")) throw new Error(`${label} holder never acquired`);
    holder.kill(signal);
    await once(holder, "close");
    let recovered;
    for (let i = 0; i < 50; i += 1) {
      try {
        recovered = await acquireWorkspaceLease({ workspace: a, access: "write", leaseDir, ownerId: `recovered-${label}` });
        break;
      } catch (error) {
        if (error.code !== "WORKSPACE_WRITE_CONFLICT") throw error;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    await new Promise((r) => setTimeout(r, 1100));
    const result = recovered?.recovered === true && !existsSync(lateMarker) ? "recovered-after-child-stop" : "FAILED";
    await recovered?.release("probe");
    return result;
  };
  findings.sigterm_recovery = await crashRecovery("SIGTERM", "sigterm");
  findings.sigkill_recovery = await crashRecovery("SIGKILL", "sigkill");

  const marker = join(rootA, "SHELL_INTERPOLATED");
  const hostile = `; touch ${marker}; $(echo pwned)`;
  const checked = await runNamedCheck({
    checkId: "literal",
    registry: { version: 1, checks: { literal: {
      executable: process.execPath,
      argv: ["-e", "process.stdout.write(process.cwd()+'\\n'+process.argv[1])", hostile],
      workspace_access: "read",
    } } },
    workspace: a,
  });
  findings.check_exit = checked.exitCode;
  findings.check_cwd = checked.output.split("\n")[0];
  findings.argv_literal = checked.output.endsWith(hostile);
  findings.shell_marker_absent = !existsSync(marker);
  findings.receipt_id = checked.receipt.receipt_id;

  console.log(JSON.stringify({ node: process.version, platform: process.platform, findings }, null, 2));
} finally {
  for (const path of dirs.reverse()) await rm(path, { recursive: true, force: true });
}
