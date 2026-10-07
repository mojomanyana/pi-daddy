/** Explicit opt-in for the operator-installed, reviewed leaf. NEVER installs or modifies capabilities. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { open, readFile, lstat, realpath, writeFile, chmod } from "node:fs/promises";
import type { CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { readCacheOwner, cacheProcessTerminated } from "../src/kernel/cache-owner.ts";
import { startCacheLeaseBridge } from "../src/executors/cache-lease-bridge.ts";
import { tempDir, cleanupTempDirs as removeTempDirs } from "../test/tmp.ts";

const enabled = process.env.PI_DADDY_IT_CACHE_PRIVILEGED === "1";
let binary: string, binarySha256: string;
before(async () => {
  if (!enabled) return;
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(process.getuid!(), 1000, "exact reviewed account required");
  binary = process.env.PI_DADDY_IT_CACHE_LEASE_BINARY || "";
  assert.ok(binary, "PI_DADDY_IT_CACHE_LEASE_BINARY must name the installed reviewed leaf");
  assert.equal(await realpath(binary), binary);
  const manifest = JSON.parse(
    await readFile(new URL("../dist/executors/native/cache-lease.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.available, true);
  assert.equal(manifest.protocol, 2);
  binarySha256 = manifest.sha256;
  const info = await lstat(binary);
  assert.equal(info.isFile(), true);
  assert.equal(info.uid, 0);
  assert.equal(info.gid, 1000);
  assert.equal(info.mode & 0o7777, 0o750);
  assert.equal(info.nlink, 1);
  const caps = (await promisify(execFile)("/usr/sbin/getcap", [binary])).stdout.trim();
  assert.equal(caps, `${binary} cap_lease=ep`);
});
const known: CacheOwnerIdentity[] = [];
async function cleanupTempDirs() {
  for (const owner of known)
    assert.equal(await cacheProcessTerminated(owner), true, `unresolved owned identity: ${JSON.stringify(owner)}`);
  await removeTempDirs(); // Retain fixtures if strict death verification fails.
}
after(cleanupTempDirs);

async function bridge(onLoss: (id: string | undefined, why: string) => void = () => {}) {
  const owner = await readCacheOwner(process.pid);
  const handle = await startCacheLeaseBridge({
    binary,
    binarySha256,
    owner,
    peer: owner,
    requirePrivilege: true,
    onLoss,
  });
  const identity = await readCacheOwner(handle.pid);
  known.push(identity);
  return { handle, identity };
}
async function stopped(owned: Awaited<ReturnType<typeof bridge>>) {
  await owned.handle.stop();
  assert.equal(await cacheProcessTerminated(owned.identity), true, "helper identity must be dead, not just signaled");
  const leases = (await readFile("/proc/locks", "utf8"))
    .split("\n")
    .filter((line) => line.trim().split(/\s+/)[4] === String(owned.identity.pid));
  assert.deepEqual(leases, [], "actual helper must no longer hold any lease");
}

for (const [name, target] of [
  ["operator-created root-owned installed fixture", () => binary],
  ["actual root-owned typecheck runtime library", () => "/usr/lib/x86_64-linux-gnu/libtinfo.so.6.6"],
] as const) {
  test(`installed CAP_LEASE acquisition/check/release on ${name}`, { skip: !enabled }, async (t) => {
    const input = await open(target(), "r"),
      losses: string[] = [];
    let owned: Awaited<ReturnType<typeof bridge>> | undefined;
    try {
      const info = await input.stat({ bigint: true });
      assert.equal(info.uid, 0n);
      const beforeBytes = await readFile(target());
      owned = await bridge((_, why) => losses.push(why));
      assert.equal(owned.handle.privileged, true);
      const status = await readFile(`/proc/${owned.handle.pid}/status`, "utf8");
      for (const key of ["CapEff", "CapPrm"]) assert.match(status, new RegExp(`^${key}:\\s+0000000010000000$`, "m"));
      for (const key of ["CapInh", "CapAmb"]) assert.match(status, new RegExp(`^${key}:\\s+0000000000000000$`, "m"));
      assert.match(status, /^Uid:\s+1000\s+1000\s+1000\s+1000$/m);
      assert.match(status, /^NoNewPrivs:\s+1$/m);
      assert.match(status, /^Seccomp:\s+2$/m);
      const acquired = await owned.handle.acquire(input.fd, info);
      if (!acquired.ok) assert.fail(acquired.reason);
      assert.equal(await acquired.lease.check(), true);
      assert.deepEqual(await input.readFile(), beforeBytes, "readonly acquisition must not change bytes");
      await acquired.lease.release();
      assert.equal(await acquired.lease.check(), false);
      assert.deepEqual(losses, []);
      t.diagnostic(
        JSON.stringify({
          target: target(),
          dev: String(info.dev),
          ino: String(info.ino),
          uid: String(info.uid),
          privileged: true,
          identity: owned.identity,
        }),
      );
    } finally {
      if (owned) await stopped(owned);
      await input.close();
    }
  });
}

test("installed privilege still refuses preexisting writable descriptors", { skip: !enabled }, async () => {
  const path = join(await tempDir("lease-installed-writer-"), "input");
  await writeFile(path, "initial");
  const writable = await open(path, "r+"),
    input = await open(path, "r"),
    owned = await bridge();
  try {
    const rejected = await owned.handle.acquire(input.fd, await input.stat({ bigint: true }));
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.match(rejected.reason, /^LEASE: 11$/);
    await writable.close();
    const admitted = await owned.handle.acquire(input.fd, await input.stat({ bigint: true }));
    if (!admitted.ok) assert.fail(admitted.reason);
    assert.equal(await admitted.lease.check(), true);
    await admitted.lease.release();
  } finally {
    await stopped(owned);
    await input.close();
    await writable.close();
  }
});

test(
  "installed holder loses writer-broken evidence irreversibly and automatically releases",
  { skip: !enabled },
  async (t) => {
    const path = join(await tempDir("lease-installed-break-"), "input");
    await writeFile(path, "initial");
    const input = await open(path, "r"),
      reasons: string[] = [],
      owned = await bridge((_, why) => reasons.push(why));
    try {
      const acquired = await owned.handle.acquire(input.fd, await input.stat({ bigint: true }));
      if (!acquired.ok) assert.fail(acquired.reason);
      const started = performance.now();
      await promisify(execFile)(
        process.execPath,
        ["-e", `require('node:fs').writeFileSync(${JSON.stringify(path)},'changed')`],
        { timeout: 3000 },
      );
      assert.ok(reasons.includes("content lease breaking"));
      assert.ok(reasons.includes("TIMEOUT: 0"));
      assert.equal(await acquired.lease.check(), false);
      await writeFile(path, "initial");
      assert.equal(await acquired.lease.check(), false, "restored bytes must not restore lease validity");
      await acquired.lease.release();
      t.diagnostic(
        JSON.stringify({ writerCompletionMs: performance.now() - started, reasons, hardRealtimeBound: false }),
      );
    } finally {
      await stopped(owned);
      await input.close();
    }
  },
);

test(
  "installed stopped holder faults its bridge, dies and releases a root-runtime lease",
  { skip: !enabled },
  async () => {
    const input = await open("/usr/lib/x86_64-linux-gnu/libtinfo.so.6.6", "r"),
      owned = await bridge();
    try {
      const acquired = await owned.handle.acquire(input.fd, await input.stat({ bigint: true }));
      if (!acquired.ok) assert.fail(acquired.reason);
      process.kill(owned.handle.pid, "SIGSTOP");
      await assert.rejects(acquired.lease.check(), /response exceeded 2000ms/);
      const fault = await owned.handle.faulted;
      assert.match(fault.message, /proof lost/);
      assert.equal(await cacheProcessTerminated(owned.identity), true, "fault cleanup must finish BEFORE finally stop");
      assert.equal(await acquired.lease.check(), false);
    } finally {
      await stopped(owned);
      await input.close();
    }
  },
);

test(
  "installed coordinator peer death stops the privileged leaf without caller cleanup",
  { skip: !enabled },
  async () => {
    const peerProcess = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const exited = new Promise<void>((resolve) => peerProcess.once("exit", () => resolve()));
    const owner = await readCacheOwner(process.pid),
      peer = await readCacheOwner(peerProcess.pid!);
    known.push(peer);
    const input = await open("/usr/lib/x86_64-linux-gnu/libtinfo.so.6.6", "r");
    let owned: Awaited<ReturnType<typeof bridge>> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const handle = await startCacheLeaseBridge({
        binary,
        binarySha256,
        owner,
        peer,
        requirePrivilege: true,
        onLoss: () => {},
      });
      owned = { handle, identity: await readCacheOwner(handle.pid) };
      known.push(owned.identity);
      const acquired = await handle.acquire(input.fd, await input.stat({ bigint: true }));
      if (!acquired.ok) assert.fail(acquired.reason);
      assert.equal(await acquired.lease.check(), true);
      peerProcess.kill("SIGKILL");
      await exited;
      await Promise.race([
        handle.stopped,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("installed peer death failed to stop holder")), 2000);
        }),
      ]);
      assert.equal(await cacheProcessTerminated(owned.identity), true);
      assert.equal((await readCacheOwner(process.pid)).startTicks, owner.startTicks);
    } finally {
      clearTimeout(timer);
      peerProcess.kill("SIGKILL");
      await exited;
      if (owned) await stopped(owned);
      await input.close();
    }
  },
);

async function ownedProcess(executable: string, args: string[]) {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const identity = await readCacheOwner(child.pid!);
  known.push(identity);
  return { child, identity, exited };
}
async function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "",
      diagnostics = "";
    const timer = setTimeout(() => finish(new Error(`owned fixture readiness timeout: ${diagnostics}`)), 2000);
    const stderr = (bytes: Buffer) => {
      diagnostics = (diagnostics + bytes.toString()).slice(-8192);
    };
    const data = (bytes: Buffer) => {
      text += bytes.toString();
      if (Buffer.byteLength(text) > 4096) finish(new Error("owned fixture readiness exceeded 4096 bytes"));
      else if (text.includes("\n")) finish(undefined, text.slice(0, text.indexOf("\n")));
    };
    const ended = () => finish(new Error(`owned fixture exited before readiness: ${diagnostics}`));
    const error = (err: Error) => finish(err);
    const finish = (err?: Error, line = "") => {
      clearTimeout(timer);
      child.stdout!.off("data", data);
      child.stderr!.off("data", stderr);
      child.off("exit", ended);
      child.off("error", error);
      if (err) reject(err);
      else resolve(line);
    };
    child.stdout!.on("data", data);
    child.stderr!.on("data", stderr);
    child.once("exit", ended);
    child.once("error", error);
  });
}
async function terminate(owned: Awaited<ReturnType<typeof ownedProcess>>) {
  if (!(await cacheProcessTerminated(owned.identity))) owned.child.kill("SIGKILL");
  await owned.exited;
  assert.equal(await cacheProcessTerminated(owned.identity), true);
}
async function waitDead(identity: CacheOwnerIdentity) {
  const deadline = performance.now() + 2000;
  while (!(await cacheProcessTerminated(identity))) {
    assert.ok(performance.now() < deadline, `owned identity stayed alive: ${JSON.stringify(identity)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test(
  "installed privilege refuses writable shared mappings even after their source FD closes",
  { skip: !enabled },
  async () => {
    const path = join(await tempDir("lease-installed-mapping-"), "input");
    await writeFile(path, "mapped input");
    const script = `import ctypes,os,sys\nlibc=ctypes.CDLL(None,use_errno=True)\nlibc.mmap.restype=ctypes.c_void_p\nfd=os.open(sys.argv[1],os.O_RDWR)\np=libc.mmap(None,4096,3,1,fd,0)\nassert p != ctypes.c_void_p(-1).value\nos.close(fd)\nprint('MAPPED_WITH_FD_CLOSED',flush=True)\nsys.stdin.readline()\nassert libc.munmap(ctypes.c_void_p(p),4096)==0\n`;
    const mapping = await ownedProcess("python3", ["-c", script, path]);
    const input = await open(path, "r");
    let owned: Awaited<ReturnType<typeof bridge>> | undefined;
    try {
      assert.equal(await firstLine(mapping.child), "MAPPED_WITH_FD_CLOSED");
      owned = await bridge();
      const rejected = await owned.handle.acquire(input.fd, await input.stat({ bigint: true }));
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.match(rejected.reason, /^LEASE: 11$/);
      mapping.child.stdin!.end("release\n");
      await waitDead(mapping.identity);
      const admitted = await owned.handle.acquire(input.fd, await input.stat({ bigint: true }));
      if (!admitted.ok) assert.fail(admitted.reason);
      assert.equal(await admitted.lease.check(), true);
      await admitted.lease.release();
    } finally {
      await terminate(mapping);
      if (owned) await stopped(owned);
      await input.close();
    }
  },
);

test(
  "installed capability adds no DAC read access even when the parent already has a readable FD",
  { skip: !enabled },
  async () => {
    const path = join(await tempDir("lease-installed-dac-"), "input");
    await writeFile(path, "private input");
    const input = await open(path, "r"),
      owned = await bridge();
    try {
      await chmod(path, 0);
      assert.equal(await input.readFile("utf8"), "private input");
      const rejected = await owned.handle.acquire(input.fd, await input.stat({ bigint: true }));
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.match(rejected.reason, /^READ: 13$/);
    } finally {
      await chmod(path, 0o600);
      await stopped(owned);
      await input.close();
    }
  },
);

test(
  "installed holder dies after actual root SIGKILL while its coordinator peer remains alive",
  { skip: !enabled },
  async (t) => {
    const peer = await readCacheOwner(process.pid);
    const ownerModule = new URL("../src/kernel/cache-owner.ts", import.meta.url).href;
    const bridgeModule = new URL("../src/executors/cache-lease-bridge.ts", import.meta.url).href;
    const code =
      `import{open}from'node:fs/promises';import{readCacheOwner}from ${JSON.stringify(ownerModule)};import{startCacheLeaseBridge}from ${JSON.stringify(bridgeModule)};` +
      `const owner=await readCacheOwner(process.pid),fd=await open('/usr/lib/x86_64-linux-gnu/libtinfo.so.6.6','r');` +
      `const b=await startCacheLeaseBridge({binary:process.argv[1],binarySha256:process.argv[2],owner,peer:JSON.parse(process.argv[3]),requirePrivilege:true,onLoss:()=>{}});` +
      `const got=await b.acquire(fd.fd,await fd.stat({bigint:true}));if(!got.ok)throw Error(got.reason);` +
      `console.log(JSON.stringify({owner,helper:await readCacheOwner(b.pid)}));setInterval(()=>{},1000);`;
    const root = await ownedProcess(process.execPath, [
      "--input-type=module",
      "-e",
      code,
      binary,
      binarySha256,
      JSON.stringify(peer),
    ]);
    let helper: CacheOwnerIdentity | undefined;
    try {
      const reported = JSON.parse(await firstLine(root.child));
      assert.deepEqual(reported.owner, root.identity);
      helper = reported.helper;
      assert.ok(helper && helper.pid > 0 && helper.bootId === peer.bootId);
      known.push(helper);
      const leases = await readFile("/proc/locks", "utf8");
      assert.ok(
        leases
          .split("\n")
          .some((line) => line.includes("LEASE") && line.trim().split(/\s+/)[4] === String(helper!.pid)),
        "root fixture must actually hold a runtime lease before death",
      );
      root.child.kill("SIGKILL");
      await root.exited;
      await waitDead(helper); // No helper signal or caller cleanup before proof.
      assert.equal((await readCacheOwner(process.pid)).startTicks, peer.startTicks);
      assert.ok(
        !(await readFile("/proc/locks", "utf8"))
          .split("\n")
          .some((line) => line.trim().split(/\s+/)[4] === String(helper!.pid)),
      );
      t.diagnostic(JSON.stringify({ root: root.identity, helper, peerSurvived: true }));
    } finally {
      await terminate(root);
      if (helper && !(await cacheProcessTerminated(helper))) {
        process.kill(helper.pid, "SIGKILL");
        await waitDead(helper);
      }
    }
  },
);

test(
  "descheduled installed holder can delay a waiting writer beyond the configured 250ms",
  { skip: !enabled },
  async (t) => {
    const path = join(await tempDir("lease-installed-delay-"), "input");
    await writeFile(path, "initial");
    const input = await open(path, "r"),
      reasons: string[] = [],
      owned = await bridge((_, why) => reasons.push(why));
    let writer: Awaited<ReturnType<typeof ownedProcess>> | undefined;
    try {
      const acquired = await owned.handle.acquire(input.fd, await input.stat({ bigint: true }));
      if (!acquired.ok) assert.fail(acquired.reason);
      process.kill(owned.handle.pid, "SIGSTOP");
      const deadline = performance.now() + 2000;
      while (!(await readFile(`/proc/${owned.handle.pid}/stat`, "utf8")).match(/\) T /)) {
        assert.ok(performance.now() < deadline, "holder must actually reach stopped state");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      writer = await ownedProcess(process.execPath, [
        "-e",
        `process.stdout.write('WRITER_READY\\n',()=>require('node:fs').writeFileSync(${JSON.stringify(path)},'changed'))`,
      ]);
      assert.equal(await firstLine(writer.child), "WRITER_READY");
      const waiting = performance.now() + 2000;
      while (
        !(await readFile("/proc/locks", "utf8"))
          .split("\n")
          .some(
            (line) =>
              line.includes("LEASE") &&
              line.includes("BREAKER") &&
              line.trim().split(/\s+/).includes(String(writer!.identity.pid)),
          )
      ) {
        assert.ok(performance.now() < waiting, "writer must actually enter kernel lease-break waiting");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const start = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(await cacheProcessTerminated(writer.identity), false);
      assert.equal(await readFile(path, "utf8"), "initial");
      assert.equal(reasons.length, 0, "stopped observer has not delivered loss yet");
      const observedDelayMs = performance.now() - start;
      assert.ok(observedDelayMs >= 350);
      process.kill(owned.handle.pid, "SIGCONT");
      await waitDead(writer.identity);
      await writer.exited;
      assert.ok(reasons.includes("content lease breaking"));
      assert.ok(reasons.includes("TIMEOUT: 0"));
      assert.equal(await acquired.lease.check(), false);
      assert.equal(await readFile(path, "utf8"), "changed");
      await acquired.lease.release();
      t.diagnostic(JSON.stringify({ observedDelayMs, hardRealtimeBound: false }));
    } finally {
      if (!(await cacheProcessTerminated(owned.identity))) process.kill(owned.handle.pid, "SIGCONT");
      if (writer) await terminate(writer);
      await stopped(owned);
      await input.close();
    }
  },
);

test("installed identity rejects a wrong digest before acquiring privilege", { skip: !enabled }, async () => {
  const owner = await readCacheOwner(process.pid);
  await assert.rejects(
    startCacheLeaseBridge({
      binary,
      binarySha256: "0".repeat(64),
      owner,
      peer: owner,
      requirePrivilege: true,
      onLoss: () => {},
    }),
    /identity changed or mismatched/,
  );
});
