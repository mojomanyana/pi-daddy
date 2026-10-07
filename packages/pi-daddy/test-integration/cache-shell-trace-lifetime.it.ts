/** Real observer/tracee lifetime qualification. Witnesses are trusted fixture data, not production authority. */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { cacheProcessTerminated, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { tempDir, cleanupTempDirs } from "../test/tmp.ts";
import { shellExec, shellSdkRun, shellCliRun } from "./cache-shell-harness.ts";
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
let sdk: string, cli: string, tracer: string;
before(async () => {
  if (!enabled) return;
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.ok(process.env.PI_DADDY_CACHE_STRACE, "PI_DADDY_CACHE_STRACE is required");
  tracer = await realpath(process.env.PI_DADDY_CACHE_STRACE!);
  cli = await realpath((await shellExec("which", ["pi"])).stdout.trim());
  sdk = pathToFileURL(join(dirname(cli), "index.js")).href;
});
after(cleanupTempDirs);
async function fixture(killOnExit = true, loseObserver = false) {
  const root = await tempDir("trace-lifetime-"),
    directory = join(root, "work"),
    traces = join(root, "trace");
  await mkdir(directory);
  await mkdir(traces);
  const prefix = join(traces, "receipt"),
    witness = join(directory, "observer-witness"),
    header = join(root, "config.h"),
    adapter = join(root, "shell");
  await writeFile(
    header,
    [
      `#define TRACE_PROGRAM ${JSON.stringify(tracer)}`,
      `#define TRACE_LIBRARIES ${JSON.stringify(join(dirname(dirname(tracer)), "lib/x86_64-linux-gnu"))}`,
      `#define TRACE_OUTPUT ${JSON.stringify(prefix)}`,
      "#define TRACE_FOLLOW 1",
      "#define TRACE_DAEMON 1",
      `#define TRACE_KILL_ON_EXIT ${Number(killOnExit)}`,
    ].join("\n"),
  );
  await shellExec("cc", [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-DTRACE_CONFIG=${JSON.stringify(header)}`,
    fileURLToPath(new URL("./cache-shell-trace.c", import.meta.url)),
    "-o",
    adapter,
  ]);
  const module = pathToFileURL(fileURLToPath(new URL("../src/kernel/cache-owner.ts", import.meta.url))).href;
  const common =
    `import fs from'node:fs';import{readCacheOwner}from ${JSON.stringify(module)};` +
    `const host='/run/pi-daddy-cache-host-proc';const owner=await readCacheOwner(Number(fs.readlinkSync(host+'/self')),host);`;
  const child = join(directory, "child.mjs"),
    parent = join(directory, "parent.mjs");
  await writeFile(
    child,
    common +
      `fs.writeFileSync(${JSON.stringify(join(directory, "child-owner"))},JSON.stringify(owner));setInterval(()=>{},1000);`,
  );
  await writeFile(
    parent,
    common +
      `fs.writeFileSync(${JSON.stringify(join(directory, "parent-owner"))},JSON.stringify(owner));` +
      `const{spawn}=await import('node:child_process');spawn(process.execPath,[${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();` +
      `const observers=[];for(const pid of fs.readdirSync('/proc').filter(n=>/^\\d+$/.test(n))){` +
      `try{const argv=fs.readFileSync('/proc/'+pid+'/cmdline').toString().split('\\0');` +
      `if(argv.includes(${JSON.stringify(prefix)}))observers.push(await readCacheOwner(Number(pid)));}` +
      `catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}}` +
      `if(!observers.length)throw Error('actual daemonized tracer not found');fs.writeFileSync(${JSON.stringify(witness)},JSON.stringify(observers));` +
      `while(!fs.existsSync(${JSON.stringify(join(directory, "child-owner"))}))await new Promise(ok=>setTimeout(ok,5));console.log('STARTED');` +
      (loseObserver ? `process.kill(observers[0].pid,'SIGKILL');` : ``) +
      `setInterval(()=>{},1000);`,
  );
  return { directory, sdk, adapter, witness, command: `${JSON.stringify(process.execPath)} ${JSON.stringify(parent)}` };
}
async function traceesStopped(directory: string) {
  const owners = await Promise.all(
    ["parent", "child"].map(
      async (name) => JSON.parse(await readFile(join(directory, name + "-owner"), "utf8")) as CacheOwnerIdentity,
    ),
  );
  const deadline = performance.now() + 2000;
  while (!(await Promise.all(owners.map((owner) => cacheProcessTerminated(owner)))).every(Boolean)) {
    assert.ok(performance.now() < deadline, "all owned tracees including detached child must die BEFORE teardown");
    await new Promise((ok) => setTimeout(ok, 10));
  }
}
for (const mode of ["timeout", "abort", "rpc-abort", "observer-loss"])
  test(`OS tracer ${mode}: observer and detached tracees die before fixture teardown`, { skip: !enabled }, async () => {
    const f = await fixture(true, mode === "observer-loss");
    let checked = false;
    const beforeStop = async (reply: import("./cache-shell-harness.ts").ShellReply) => {
      assert.ok(reply.observerWitness!.count > 0, "observer must actually be admitted");
      assert.equal(reply.observerWitness!.terminated, true);
      await traceesStopped(f.directory);
      checked = true;
    };
    if (mode === "rpc-abort") {
      const result = await shellCliRun(cli, f.adapter, {
        cwd: f.directory,
        args: { command: f.command },
        rpc: true,
        beforeStop,
        observerWitness: f.witness,
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text!, /Command aborted/);
    } else {
      const result = await shellSdkRun(
        f,
        f.adapter,
        { command: f.command, ...(mode === "timeout" ? { timeout: 2 } : {}) },
        { cwd: f.directory, ...(mode === "abort" ? { abortMs: 2000 } : {}) },
        beforeStop,
        f.witness,
      );
      assert.equal(result.ok, false);
      assert.match(
        result.error!,
        mode === "timeout" ? /timed out/ : mode === "abort" ? /Command aborted/ : /137|SIGKILL|Killed/,
      );
    }
    assert.equal(checked, true, "no namespace cleanup may substitute for process proof");
  });

test(
  "negative control: no EXITKILL leaves the detached tracee alive after native timeout",
  { skip: !enabled },
  async () => {
    const f = await fixture(false);
    let checked = false;
    const result = await shellSdkRun(
      f,
      f.adapter,
      { command: f.command, timeout: 2 },
      { cwd: f.directory },
      async (reply) => {
        assert.equal(reply.observerWitness!.terminated, true);
        const child = JSON.parse(await readFile(join(f.directory, "child-owner"), "utf8")) as CacheOwnerIdentity;
        assert.equal(
          await cacheProcessTerminated(child),
          false,
          "without tracer EXITKILL the detached child must survive until namespace teardown",
        );
        checked = true;
      },
      f.witness,
    );
    assert.equal(result.ok, false);
    assert.match(result.error!, /timed out/);
    assert.equal(checked, true);
  },
);

test(
  "observer proof refuses an empty witness instead of certifying vacuous termination",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    await writeFile(f.witness, "[]");
    await assert.rejects(
      shellSdkRun(f, "/bin/bash", { command: "printf success" }, { cwd: f.directory }, undefined, f.witness),
      /must name 1\.\.32 actual identities/,
    );
  },
);

test("known live observer identity cannot become a successful cleanup claim", { skip: !enabled }, async () => {
  const f = await fixture();
  const module = pathToFileURL(fileURLToPath(new URL("../src/kernel/cache-owner.ts", import.meta.url))).href;
  const script = join(f.directory, "live-witness.mjs");
  await writeFile(
    script,
    `import{readCacheOwner}from ${JSON.stringify(module)};import{writeFileSync}from'node:fs';` +
      `writeFileSync(${JSON.stringify(f.witness)},JSON.stringify([await readCacheOwner(1)]));console.log('success');`,
  );
  await assert.rejects(
    shellSdkRun(
      f,
      "/bin/bash",
      { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` },
      { cwd: f.directory },
      undefined,
      f.witness,
    ),
    /observer remained alive/,
  );
});
