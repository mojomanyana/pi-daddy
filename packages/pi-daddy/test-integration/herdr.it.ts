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
interface AgentObservation {
  name?: string;
  pane_id: string;
  tab_id: string;
  cwd?: string;
  agent?: string;
  agent_status: string;
  title?: string;
  display_agent?: string;
}
async function listedAgent(paneId: string): Promise<AgentObservation | undefined> {
  const reply = await exec(["agent", "list"]);
  assert.equal(reply.code, 0, reply.stderr);
  return JSON.parse(reply.stdout).result.agents.find((agent: AgentObservation) => agent.pane_id === paneId);
}
async function assertWorkingAgent(paneId: string, tabId: string, cwd: string, role: string) {
  const agent = await eventually(async () => {
    const current = await listedAgent(paneId);
    return current?.agent_status === "working" && current.title === role && current.display_agent === "Pi / " + role
      ? current
      : undefined;
  });
  const got = await exec(["agent", "get", agent.name ?? paneId]);
  assert.equal(got.code, 0, got.stderr);
  for (const observed of [agent, JSON.parse(got.stdout).result.agent]) {
    assert.equal(observed.pane_id, paneId);
    assert.equal(observed.tab_id, tabId);
    assert.equal(observed.cwd, cwd);
    assert.equal(observed.agent, "pi");
    assert.equal(observed.agent_status, "working");
    assert.equal(observed.title, role);
    assert.equal(observed.display_agent, "Pi / " + role);
  }
  const tab = JSON.parse((await exec(["tab", "get", tabId])).stdout).result.tab;
  assert.ok(tab.label.includes(role), tab.label);
}
async function assertReleasedAgent(paneId: string, tabId: string) {
  await eventually(async () => ((await listedAgent(paneId)) === undefined ? true : undefined));
  const retained = await exec(["tab", "get", tabId]);
  assert.equal(retained.code, 0, retained.stderr);
  assert.equal(JSON.parse(retained.stdout).result?.tab?.tab_id, tabId, retained.stdout);
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
test("KEEP_PANE shows the working Pi agent and retains only its shell after settlement", { skip }, async () => {
  const cwd = await fixture();
  const controller = new AbortController();
  let paneId: string | undefined, tabId: string | undefined;
  const running = runHerdrOwned(
    {
      executionId: "retained-pane",
      ownershipDir: join(cwd, "owner"),
      cwd,
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('fs');fs.writeFileSync('ready','');const timer=setInterval(()=>{if(fs.existsSync('release')){process.stdout.write('inspection output');clearInterval(timer)}},20)",
      ],
      env: { PATH: process.env.PATH },
      signal: controller.signal,
      timeoutMs: 15000,
      killGraceMs: 100,
    },
    {
      exec,
      launcherPath,
      keepPane: true,
      displayName: "review",
      onPane: (pane, tab) => {
        paneId = pane;
        tabId = tab;
      },
    },
  );
  try {
    await eventually(() =>
      access(join(cwd, "ready"))
        .then(() => true)
        .catch(() => undefined),
    );
    assert.ok(paneId && tabId);
    await assertWorkingAgent(paneId, tabId, cwd, "review");
    await writeFile(join(cwd, "release"), "");
    const result = await running;
    assert.equal(result.text, "inspection output");
    assert.equal(result.code, 0);
    assert.equal(result.cleanup.state, "settled");
    if (result.cleanup.state !== "settled") throw Error("expected settled receipt");
    assert.equal(result.cleanup.receipt.reapedAll, true);
    assert.equal(
      await access("/proc/" + result.cleanup.identity.workerPid)
        .then(() => true)
        .catch(() => false),
      false,
    );
    await assertReleasedAgent(paneId, tabId);
  } finally {
    controller.abort();
    await running;
    if (tabId) await exec(["tab", "close", tabId]);
  }
});
const script =
  "const fs=require('fs'),cp=require('child_process');" +
  "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});" +
  "fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)";
for (const mode of ["direct cancellation", "launcher SIGKILL"] as const)
  test(`${mode} settles the real tree and removes its retained-pane agent`, { skip }, async () => {
    const cwd = await fixture();
    const controller = new AbortController();
    let paneId: string | undefined, tabId: string | undefined, helperPid: number | undefined;
    const running = runHerdrOwned(
      {
        executionId: "direct-cancel",
        ownershipDir: join(cwd, "owner"),
        cwd,
        command: process.execPath,
        args: ["-e", script, join(cwd, "pids.json")],
        env: process.env,
        signal: controller.signal,
        onOwnership: (identity) => {
          helperPid = identity.helperPid;
        },
        timeoutMs: 15000,
        killGraceMs: 100,
      },
      {
        exec,
        launcherPath,
        keepPane: true,
        displayName: "build",
        onPane: (pane, tab) => {
          paneId = pane;
          tabId = tab;
        },
      },
    );
    try {
      await eventually(() =>
        access(join(cwd, "pids.json"))
          .then(() => true)
          .catch(() => undefined),
      );
      assert.ok(paneId && tabId);
      await assertWorkingAgent(paneId, tabId, cwd, "build");
      if (mode === "direct cancellation") controller.abort();
      else {
        assert.ok(helperPid);
        const status = await readFile(`/proc/${helperPid}/status`, "utf8");
        const parentPid = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]);
        assert.ok(Number.isSafeInteger(parentPid) && parentPid > 1);
        const command = (await readFile(`/proc/${parentPid}/cmdline`, "utf8")).split("\0");
        assert.ok(command.includes(launcherPath), "native helper parent must be this fixture's launcher");
        process.kill(parentPid, "SIGKILL");
      }
      const result = await running;
      assert.equal(result.aborted, mode === "direct cancellation", JSON.stringify(result));
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
      await assertReleasedAgent(paneId, tabId);
    } finally {
      controller.abort();
      await running;
      if (tabId) await exec(["tab", "close", tabId]);
    }
  });
test("coordinator SIGKILL makes native ownership cancel/reap the real pane tree", { skip }, async () => {
  const cwd = await fixture(),
    program = join(cwd, "coordinator.mjs");
  const ownModule = fileURLToPath(new URL("../src/executors/herdr-owned.ts", import.meta.url));
  await writeFile(
    program,
    `
    import {writeFile} from 'node:fs/promises';import {writeFileSync} from 'node:fs';import {execFile} from 'node:child_process';
    import {runHerdrOwned} from ${JSON.stringify(ownModule)};
    const exec=args=>new Promise(resolve=>execFile('herdr',['--session',${JSON.stringify(name)},...args],
      {timeout:10000},(error,stdout,stderr)=>resolve({code:error?1:0,stdout,stderr})));
    await runHerdrOwned({executionId:'parent-kill',ownershipDir:${JSON.stringify(join(cwd, "owner"))},
      cwd:${JSON.stringify(cwd)},command:process.execPath,args:['-e',${JSON.stringify(script)},${JSON.stringify(join(cwd, "pids.json"))}],
      env:process.env,timeoutMs:15000,killGraceMs:100,
      onOwnership:identity=>writeFile(${JSON.stringify(join(cwd, "identity.json"))},JSON.stringify(identity))
    },{exec,launcherPath:${JSON.stringify(launcherPath)},keepPane:true,displayName:'debug',
      onPane:(paneId,tabId)=>writeFileSync(${JSON.stringify(join(cwd, "pane.json"))},JSON.stringify({paneId,tabId}))});`,
  );
  const parent = spawn(process.execPath, [program], { stdio: "ignore" });
  let pane: { paneId: string; tabId: string } | undefined;
  try {
    await eventually(() =>
      access(join(cwd, "pids.json"))
        .then(() => true)
        .catch(() => undefined),
    );
    const identity = JSON.parse(await readFile(join(cwd, "identity.json"), "utf8"));
    pane = JSON.parse(await readFile(join(cwd, "pane.json"), "utf8"));
    assert.ok(pane);
    await assertWorkingAgent(pane.paneId, pane.tabId, cwd, "debug");
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
    await assertReleasedAgent(pane.paneId, pane.tabId);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    if (pane) await exec(["tab", "close", pane.tabId]);
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
