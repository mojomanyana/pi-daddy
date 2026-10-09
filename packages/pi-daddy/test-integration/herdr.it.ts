/** Actual Herdr transport and cleanup qualification. Owns a uniquely named server; never touches user panes. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import { tempDir, cleanupTempDirs } from "../test/tmp.ts";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHerdrOwned } from "../src/executors/herdr-owned.ts";
import { readCapturedWorkerReceipt } from "../src/governance/captured-worker-record.ts";
import { qualifyHerdr } from "../src/executors/herdr-qualification.ts";
const name = "pd-it-" + randomUUID().slice(0, 12);
const exec = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile("herdr", ["--session", name, ...args], { timeout: 10000 }, (error, stdout, stderr) =>
      resolve({ code: error ? 1 : 0, stdout, stderr }),
    );
  });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let n = 0; n < 160; n++) {
    const value = await read();
    if (value !== undefined) return value;
    await wait(50);
  }
  throw Error("owned Herdr qualification deadline");
}
let server: ChildProcess | undefined,
  serverError: Error | undefined,
  available = false;
after(async () => {
  if (server?.pid && server.exitCode === null && server.signalCode === null) await exec(["server", "stop"]);
});
after(cleanupTempDirs);
const serverBinary = process.env.PI_DADDY_IT_HERDR_SERVER_BINARY;
if (serverBinary !== undefined) assert.ok(isAbsolute(serverBinary), "PI_DADDY_IT_HERDR_SERVER_BINARY must be absolute");
const version = await exec(["--version"]);
if (version.code === 0) {
  server = spawn(serverBinary ?? "herdr", ["--session", name, "server"], { stdio: "ignore" });
  server.once("error", (error) => {
    serverError = error;
  });
  await eventually(async () => {
    if (serverError) throw serverError;
    if (server!.exitCode !== null || server!.signalCode !== null)
      throw Error("owned Herdr server exited during startup");
    return (await exec(["status", "server"])).stdout.includes("status: running") ? true : undefined;
  });
  const workspace = await exec(["workspace", "create", "--label", "qualification-owned", "--no-focus"]);
  assert.equal(workspace.code, 0, workspace.stderr);
  available = true;
}
const skip = !available && "Herdr client unavailable; live qualification was not run";
const launcherPath = fileURLToPath(new URL("../src/executors/herdr-launcher.ts", import.meta.url));
async function fixture() {
  return tempDir("pd-herdr-it-");
}
test("client and isolated live server report compatible transport", { skip }, async () => {
  const result = await qualifyHerdr({ ok: true }, exec);
  assert.equal(result.qualified, true, JSON.stringify(result));
});
test("real pane uses the supplied child environment, exact bytes and native cleanup", { skip }, async () => {
  const cwd = await fixture();
  const result = await runHerdrOwned(
    {
      executionId: "real-pane",
      ownershipDir: join(cwd, "owner"),
      cwd,
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('PUBLIC 🙂 '+process.env.PI_DADDY_GRANT+' '+String(process.env.HERDR_PANE_ID))",
      ],
      env: { PATH: process.env.PATH, PI_DADDY_GRANT: "tool:read" },
      timeoutMs: 5000,
      killGraceMs: 100,
    },
    { exec, launcherPath },
  );
  assert.equal(result.text, "PUBLIC 🙂 tool:read undefined");
  assert.equal(result.code, 0);
  assert.equal(result.cleanup.state, "settled");
});
test("KEEP_PANE retains only its display shell after native work is settled", { skip }, async () => {
  const cwd = await fixture();
  let tabId: string | undefined;
  try {
    const result = await runHerdrOwned(
      {
        executionId: "retained-pane",
        ownershipDir: join(cwd, "owner"),
        cwd,
        command: process.execPath,
        args: ["-e", "process.stdout.write('inspection output')"],
        env: { PATH: process.env.PATH },
        timeoutMs: 5000,
        killGraceMs: 100,
      },
      {
        exec,
        launcherPath,
        keepPane: true,
        onPane: (_pane, tab) => {
          tabId = tab;
        },
      },
    );
    assert.equal(result.text, "inspection output");
    assert.equal(result.cleanup.state, "settled");
    if (result.cleanup.state !== "settled") throw Error("expected settled receipt");
    assert.equal(
      await access("/proc/" + result.cleanup.identity.workerPid)
        .then(() => true)
        .catch(() => false),
      false,
    );
    // Herdr observes command exit asynchronously; the completed launcher's shell must survive it.
    await wait(300);
    assert.ok(tabId);
    const retained = await exec(["tab", "get", tabId]);
    assert.equal(retained.code, 0, retained.stderr);
    assert.equal(JSON.parse(retained.stdout).result?.tab?.tab_id, tabId, retained.stdout);
  } finally {
    if (tabId) await exec(["tab", "close", tabId]);
  }
});
const script =
  "const fs=require('fs'),cp=require('child_process');" +
  "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});" +
  "fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)";
test("direct cancellation settles and reaps the real pane tree", { skip }, async () => {
  const cwd = await fixture();
  const controller = new AbortController();
  const running = runHerdrOwned(
    {
      executionId: "direct-cancel",
      ownershipDir: join(cwd, "owner"),
      cwd,
      command: process.execPath,
      args: ["-e", script, join(cwd, "pids.json")],
      env: process.env,
      signal: controller.signal,
      timeoutMs: 15000,
      killGraceMs: 100,
    },
    { exec, launcherPath },
  );
  try {
    await eventually(() =>
      access(join(cwd, "pids.json"))
        .then(() => true)
        .catch(() => undefined),
    );
    controller.abort();
    const result = await running;
    assert.equal(result.aborted, true, JSON.stringify(result));
    assert.equal(result.cleanup.state, "settled", JSON.stringify(result));
    if (result.cleanup.state !== "settled") throw Error("expected settled receipt");
    assert.equal(result.cleanup.receipt.reapedAll, true);
    for (const pid of JSON.parse(await readFile(join(cwd, "pids.json"), "utf8")))
      assert.equal(
        await access("/proc/" + pid)
          .then(() => true)
          .catch(() => false),
        false,
      );
  } finally {
    controller.abort();
    await running;
  }
});
test("coordinator SIGKILL makes native ownership cancel/reap the real pane tree", { skip }, async () => {
  const cwd = await fixture(),
    program = join(cwd, "coordinator.mjs");
  const ownModule = fileURLToPath(new URL("../src/executors/herdr-owned.ts", import.meta.url));
  await writeFile(
    program,
    `
    import {writeFile} from 'node:fs/promises';import {execFile} from 'node:child_process';
    import {runHerdrOwned} from ${JSON.stringify(ownModule)};
    const exec=args=>new Promise(resolve=>execFile('herdr',['--session',${JSON.stringify(name)},...args],
      {timeout:10000},(error,stdout,stderr)=>resolve({code:error?1:0,stdout,stderr})));
    await runHerdrOwned({executionId:'parent-kill',ownershipDir:${JSON.stringify(join(cwd, "owner"))},
      cwd:${JSON.stringify(cwd)},command:process.execPath,args:['-e',${JSON.stringify(script)},${JSON.stringify(join(cwd, "pids.json"))}],
      env:process.env,timeoutMs:15000,killGraceMs:100,
      onOwnership:identity=>writeFile(${JSON.stringify(join(cwd, "identity.json"))},JSON.stringify(identity))
    },{exec,launcherPath:${JSON.stringify(launcherPath)}});`,
  );
  const parent = spawn(process.execPath, [program], { stdio: "ignore" });
  try {
    await eventually(() =>
      access(join(cwd, "pids.json"))
        .then(() => true)
        .catch(() => undefined),
    );
    const identity = JSON.parse(await readFile(join(cwd, "identity.json"), "utf8"));
    parent.kill("SIGKILL");
    await new Promise((resolve) => parent.once("close", resolve));
    const receipt = await eventually(() => readCapturedWorkerReceipt(identity).then((x) => x ?? undefined));
    assert.equal(receipt.reapedAll, true);
    for (const pid of JSON.parse(await readFile(join(cwd, "pids.json"), "utf8")))
      assert.equal(
        await access("/proc/" + pid)
          .then(() => true)
          .catch(() => false),
        false,
      );
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
  }
});
if (available) {
  const previous = process.env.PI_DADDY_IT_HERDR_SESSION;
  process.env.PI_DADDY_IT_HERDR_SESSION = name;
  await import("./pi-sdk/herdr-final.it.ts");
  if (previous === undefined) delete process.env.PI_DADDY_IT_HERDR_SESSION;
  else process.env.PI_DADDY_IT_HERDR_SESSION = previous;
}
test("stopping only the owned Herdr server still produces independent cleanup proof", { skip }, async () => {
  const cwd = await fixture();
  const running = runHerdrOwned(
    {
      executionId: "daemon-stop",
      ownershipDir: join(cwd, "owner"),
      cwd,
      command: process.execPath,
      args: ["-e", script, join(cwd, "pids.json")],
      env: process.env,
      timeoutMs: 15000,
      killGraceMs: 100,
    },
    { exec, launcherPath },
  );
  await eventually(() =>
    access(join(cwd, "pids.json"))
      .then(() => true)
      .catch(() => undefined),
  );
  assert.equal((await exec(["server", "stop"])).code, 0);
  const result = await running;
  assert.equal(result.cleanup.state, "settled", JSON.stringify(result));
  for (const pid of JSON.parse(await readFile(join(cwd, "pids.json"), "utf8")))
    assert.equal(
      await access("/proc/" + pid)
        .then(() => true)
        .catch(() => false),
      false,
    );
});
