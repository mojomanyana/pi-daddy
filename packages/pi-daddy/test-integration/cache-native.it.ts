/** Native backend qualification, NOT cache eligibility or a claim of complete input observation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { startSupervisedCache } from "../src/executors/cache-supervisor.ts";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
import { cleanupTempDirs, tempDir } from "../test/tmp.ts";

after(cleanupTempDirs);
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
const binary = process.env.PI_DADDY_CACHE_STRACE ?? "strace";
const libraries = resolve(dirname(binary), "../lib/x86_64-linux-gnu");
interface Outcome {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: string;
}

async function traced(directory: string, source: string): Promise<{ outcome: Outcome; trace: string }> {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64", "private loader qualification currently targets Linux x64");
  const program = join(directory, "program.mjs");
  await writeFile(program, source);
  let framing = "",
    completed: Outcome | undefined;
  const handle = await startSupervisedCache({
    owner: await readCacheOwner(process.pid),
    entry: new URL("./cache-native-fixture.ts", import.meta.url),
    args: [binary, libraries, directory, program],
    onData: (stream, bytes) => {
      if (stream !== "stdout") return;
      framing += bytes.toString("utf8");
      let newline: number;
      while ((newline = framing.indexOf("\n")) !== -1) {
        completed = JSON.parse(framing.slice(0, newline)) as Outcome;
        framing = framing.slice(newline + 1);
      }
    },
  });
  try {
    const deadline = performance.now() + 30000;
    while (!completed && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(completed, "native observation did not complete within qualification bound");
    assert.equal(completed.error, undefined, "native backend failed to spawn");
    assert.equal(completed.signal, null);
    assert.equal(completed.code, 0, completed.stderr);
    assert.equal(completed.stderr, "", "tracer/application diagnostic prevents successful qualification");
    const files = (await readdir(directory)).filter((name) => /^trace\.\d+$/.test(name));
    assert.ok(files.length > 0, "observer must create per-process/thread logs");
    const logs = await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")));
    assert.ok(
      logs.every((log) => log.length > 0),
      "empty process log is not complete observation",
    );
    return { outcome: completed, trace: logs.join("\n") };
  } finally {
    await handle.stop();
  }
}

test(
  "strace follows file, negative, directory, symlink and descendant Unix-service access",
  { skip: !enabled },
  async () => {
    const root = await tempDir("cache-native");
    await mkdir(join(root, "inputs"));
    await writeFile(join(root, "inputs", "source.txt"), "input-data");
    await symlink("inputs/source.txt", join(root, "link"));
    const socket = join(root, "service.sock");
    const server = createServer((client) => client.end("fixture-response"));
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const child = `const net=require('node:net'); const socket=net.createConnection(${JSON.stringify(socket)});
      socket.on('data',()=>{});socket.on('error',error=>{console.error(error);process.exitCode=1});`;
      const result = await traced(
        root,
        `import fs from 'node:fs'; import {spawn} from 'node:child_process'; import net from 'node:net';
      fs.readFileSync(${JSON.stringify(join(root, "inputs", "source.txt"))});
      try{fs.readFileSync(${JSON.stringify(join(root, "missing-config.json"))})}catch(error){if(error.code!=='ENOENT')throw error}
      fs.readdirSync(${JSON.stringify(join(root, "inputs"))}); fs.readlinkSync(${JSON.stringify(join(root, "link"))});
      const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'inherit'});
      await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('child failed')))});
      await new Promise((resolve,reject)=>{const socket=net.createConnection(${JSON.stringify(join(root, "missing.sock"))});
        socket.once('error',error=>error.code==='ENOENT'?resolve():reject(error));
        socket.once('connect',()=>{socket.destroy();reject(Error('unexpected missing socket listener'))})});
      console.log('observation-fixture-completed');`,
      );
      assert.match(result.trace, /openat\([^\n]*source\.txt/);
      assert.match(result.trace, /openat\([^\n]*missing-config\.json[^\n]*= -1 ENOENT/);
      assert.match(result.trace, /getdents64\(/);
      assert.match(result.trace, /readlink\([^\n]*\/link/);
      assert.match(
        result.trace,
        /connect\([^\n]*AF_UNIX[^\n]*service\.sock/,
        "a detached child's external dependency must not disappear from parent evidence",
      );
      assert.match(
        result.trace,
        /connect\([^\n]*AF_UNIX[^\n]*missing\.sock[^\n]*= -1 ENOENT/,
        "caught failed external access is still a dependency despite successful application exit",
      );
      assert.match(result.outcome.stdout, /observation-fixture-completed/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "tracer private libraries do not alter subject environment; user-space time/random remain a known gap",
  { skip: !enabled },
  async () => {
    const root = await tempDir("cache-native-gap");
    const result = await traced(
      root,
      `import {createHash} from 'node:crypto';
    const times=Array.from({length:1000},()=>Date.now());const random=Array.from({length:1000},()=>Math.random());
    console.log(JSON.stringify({times:times.length,random:random.length,
      env:createHash('sha256').update(process.env.LD_LIBRARY_PATH??'').digest('hex')}));`,
    );
    const subject = JSON.parse(result.outcome.stdout) as { times: number; random: number; env: string };
    assert.equal(
      subject.env,
      createHash("sha256")
        .update(process.env.LD_LIBRARY_PATH ?? "")
        .digest("hex"),
    );
    assert.equal(subject.times, 1000);
    assert.equal(subject.random, 1000);
    assert.ok(
      (result.trace.match(/clock_gettime\(CLOCK_REALTIME/g) ?? []).length < subject.times,
      "syscall trace cannot account for every vDSO/user-space time access",
    );
    assert.ok(
      (result.trace.match(/getrandom\(/g) ?? []).length < subject.random,
      "PRNG calls are not individual kernel random reads; no semantic determinism inferred",
    );
  },
);
