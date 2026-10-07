/** Fixed trusted checksum qualification fixture; witnesses are not client authentication or source proof. */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cacheProcessTerminated, isCacheOwner, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { cleanupTempDirs as removeTempDirs, tempDir } from "../test/tmp.ts";
import { shellCliRun, shellExec, shellSdkRun } from "./cache-shell-harness.ts";
let cli: string, sdk: string, tracer: string;
let unresolved = 0;
const known: CacheOwnerIdentity[] = [];
export async function checksumInit() {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.ok(process.env.PI_DADDY_CACHE_STRACE, "PI_DADDY_CACHE_STRACE is required");
  tracer = await realpath(process.env.PI_DADDY_CACHE_STRACE!);
  cli = await realpath((await shellExec("which", ["pi"])).stdout.trim());
  sdk = pathToFileURL(join(dirname(cli), "index.js")).href;
}
export async function cleanupTempDirs() {
  assert.equal(unresolved, 0, "checksum fixture ownership/protocol unresolved; retain evidence");
  for (const owner of known) assert.equal(await cacheProcessTerminated(owner), true, "retain live checksum evidence");
  await removeTempDirs();
}
after(cleanupTempDirs); // This module owns fixture allocation and its strict teardown hook.
export async function checksumFixture() {
  const root = await tempDir("checksum-profile-"),
    directory = join(root, "work"),
    traces = join(root, "trace");
  await mkdir(directory);
  await mkdir(traces);
  const prefix = join(traces, "receipt"),
    witness = join(directory, "witness"),
    script = join(directory, "witness.mjs");
  const adapter = join(root, "shell"),
    header = join(root, "config.h"),
    preload = join(root, "effect.so");
  await writeFile(
    header,
    [
      `#define TRACE_PROGRAM ${JSON.stringify(tracer)}`,
      `#define TRACE_LIBRARIES ${JSON.stringify(join(dirname(dirname(tracer)), "lib/x86_64-linux-gnu"))}`,
      `#define TRACE_OUTPUT ${JSON.stringify(prefix)}`,
      "#define TRACE_FOLLOW 1",
      "#define TRACE_DAEMON 1",
      "#define TRACE_KILL_ON_EXIT 1",
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
  await shellExec("cc", [
    "-shared",
    "-fPIC",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    fileURLToPath(new URL("./cache-checksum-preload.c", import.meta.url)),
    "-o",
    preload,
  ]);
  const ownerModule = pathToFileURL(fileURLToPath(new URL("../src/kernel/cache-owner.ts", import.meta.url))).href;
  // Each invocation clears old trace files first. No discovered identity grants authority or permits signaling.
  await writeFile(
    script,
    `import fs from 'node:fs';import {readCacheOwner} from ${JSON.stringify(ownerModule)};
const host='/run/pi-daddy-cache-host-proc', prefix=${JSON.stringify(prefix)}, path=${JSON.stringify(witness)};
const self=Number(fs.readlinkSync(host+'/self'));
const stat=fs.readFileSync(host+'/'+self+'/stat','utf8');
const parent=Number(stat.slice(stat.lastIndexOf(')')+2).trim().split(/\\s+/)[1]);
const command=await readCacheOwner(parent,host), observers=[];
for(const local of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))) {
 let argv;try{argv=fs.readFileSync('/proc/'+local+'/cmdline').toString().split('\\0');}
 catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')continue;throw e;}
 const o=argv.indexOf('-o');if(o<0||argv[o+1]!==prefix)continue;
 const localOwner=await readCacheOwner(Number(local));const matches=[];
 for(const pid of fs.readdirSync(host).filter(x=>/^\\d+$/.test(x))) {
  let args;try{args=fs.readFileSync(host+'/'+pid+'/cmdline').toString().split('\\0');}
  catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')continue;throw e;}
  const k=args.indexOf('-o');if(k<0||args[k+1]!==prefix)continue;
  // Namespace-local PIDs collide. Only a matching command is subject to strict admission.
  const status=fs.readFileSync(host+'/'+pid+'/status','utf8');
  const row=status.match(/^NSpid:\\s+(.+)$/m);
  if(!row)throw Error('checksum fixture matching tracer has malformed namespace status');
  const ids=row[1].trim().split(/\\s+/);if(Number(ids.at(-1))!==Number(local))continue;
  const candidate=await readCacheOwner(Number(pid),host);if(candidate.startTicks!==localOwner.startTicks)continue;
  matches.push(candidate);
 }
 if(matches.length!==1)throw Error('checksum fixture tracer host identity is ambiguous or missing');
 observers.push(matches[0]);
}
if(process.argv[2]==='observed'&&observers.length!==1)throw Error('checksum fixture requires one actual observer');
fs.writeFileSync(path,JSON.stringify({command,observers,namespacePid:process.ppid}));
`,
  );
  return { root, directory, prefix, witness, script, adapter, preload, runs: 0 };
}
type Fixture = Awaited<ReturnType<typeof checksumFixture>>;
export async function checksumFreshWitness(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
/** Preserve failed synthetic command diagnostics when witness creation itself failed. Never certifies ownership. */
export async function checksumWitness(
  path: string,
  reply: import("./cache-shell-harness.ts").ShellReply,
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (observation) {
    throw new Error("checksum fixture witness unavailable; instrumented command diagnostics retained", {
      cause: { observation, command: { ...reply } },
    });
  }
}
async function death(owner: CacheOwnerIdentity) {
  const deadline = performance.now() + 2000;
  while (!(await cacheProcessTerminated(owner))) {
    assert.ok(performance.now() < deadline, "checksum subject must die BEFORE namespace teardown");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export async function checksumRun(
  f: Fixture,
  command: string,
  observed: boolean,
  useCli = false,
  checker: "/usr/bin/sha256sum" | "/usr/bin/gnusha256sum" = "/usr/bin/sha256sum",
) {
  const q = (s: string) => JSON.stringify(s);
  // Never treat old trace footers as this invocation's receipts.
  if (f.runs++) {
    for (const owner of known)
      assert.equal(await cacheProcessTerminated(owner), true, "do not move evidence of live subjects");
    await rename(dirname(f.prefix), join(f.root, `trace-history-${f.runs}`));
    await mkdir(dirname(f.prefix));
  }
  assert.equal((await readdir(dirname(f.prefix))).length, 0, "each run requires a fresh trace directory");
  await checksumFreshWitness(f.witness); // A prior run's receipt cannot diagnose or admit this invocation.
  const prepared = `${q(process.execPath)} ${q(f.script)} ${observed ? "observed" : "native"} && ${command}`;
  let trace = "",
    checked = false;
  unresolved++; // Includes startup failures, which may leave ownership unresolved.
  const beforeStop = async (reply: import("./cache-shell-harness.ts").ShellReply) => {
    const value = (await checksumWitness(f.witness, reply)) as {
      command: unknown;
      observers: unknown[];
      namespacePid: number;
    };
    assert.ok(isCacheOwner(value.command));
    assert.ok(Array.isArray(value.observers) && value.observers.every(isCacheOwner));
    assert.equal(value.observers.length, observed ? 1 : 0);
    assert.ok(Number.isSafeInteger(value.namespacePid) && value.namespacePid > 1);
    const owners = [value.command, ...value.observers] as CacheOwnerIdentity[];
    known.push(...owners);
    for (const owner of owners) await death(owner);
    if (observed) {
      const names = await readdir(dirname(f.prefix));
      assert.ok(names.length > 0 && names.length <= 32);
      let total = 0;
      for (const name of names) {
        const text = await readFile(join(dirname(f.prefix), name), "utf8");
        total += Buffer.byteLength(text);
        assert.ok(total <= 16 * 1024 * 1024);
        assert.match(text, /\+\+\+ (?:exited with \d+|killed by [A-Z0-9]+.*?) \+\+\+\s*$/);
        if (name === `receipt.${value.namespacePid}`) {
          const start = text.lastIndexOf(`execve(${JSON.stringify(checker)}`);
          assert.ok(start >= 0, "actual checksum exec must occur on the witnessed Bash PID");
          trace = text.slice(start); // Do not confuse fixture witness/Node traffic with checksum runtime.
        }
      }
      assert.ok(trace);
    }
    checked = true;
  };
  let ok: boolean, text: string;
  if (useCli) {
    const result = await shellCliRun(cli, observed ? f.adapter : "/bin/bash", {
      cwd: f.directory,
      args: { command: prepared },
      beforeStop,
    });
    ok = !result.isError;
    text = result.content.map((c) => c.text || "").join("");
  } else {
    const result = await shellSdkRun(
      { directory: f.directory, sdk },
      observed ? f.adapter : "/bin/bash",
      { command: prepared },
      {},
      beforeStop,
    );
    ok = result.ok;
    text = result.ok ? result.result!.content.map((c) => c.text).join("") : result.error!;
  }
  assert.equal(checked, true);
  unresolved--;
  return { ok, text, trace };
}
