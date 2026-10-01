/** Fault injection changes private compiled copies only; no production mutation/control API. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { readCacheOwner, cacheProcessTerminated } from "../src/kernel/cache-owner.ts";
import { startCacheLeaseBridge } from "../src/executors/cache-lease-bridge.ts";
import { tempDir, cleanupTempDirs } from "../test/tmp.ts";
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
after(cleanupTempDirs);

async function fixture(
  injection = "",
  onLoss: (id: string | undefined, why: string) => void = () => {},
  start = startCacheLeaseBridge,
) {
  const dir = await tempDir("cache-lease-fault"),
    binary = join(dir, "helper");
  const text = await readFile(new URL("../src/executors/native/cache-lease.c", import.meta.url), "utf8");
  const needle = '    if ((!check && !release) || count!=4) return fatal("PROTOCOL");';
  assert.ok(text.includes(needle));
  const source = join(dir, "helper.c");
  await writeFile(source, text.replace(needle, injection + "\n" + needle));
  await promisify(execFile)("cc", ["-static", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", binary]);
  const path = join(dir, "source");
  await writeFile(path, "stable");
  const fd = await open(path, "r");
  const owner = await readCacheOwner(process.pid);
  const bridge = await start({
    binary,
    binarySha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    owner,
    peer: owner,
    onLoss,
  });
  const acquired = await bridge.acquire(fd.fd, await fd.stat({ bigint: true }));
  if (!acquired.ok) assert.fail(acquired.reason);
  return { bridge, fd, lease: acquired.lease, identity: await readCacheOwner(bridge.pid) };
}
async function privateAdapter(change: (text: string) => string) {
  const dir = await tempDir("cache-lease-adapter");
  for (const layer of ["kernel", "executors"]) await mkdir(join(dir, layer));
  for (const name of [
    "kernel/cache-owner",
    "kernel/bounded-read",
    "kernel/cache-lease-protocol",
    "executors/cache-lease-process",
    "executors/cache-lease-bridge",
  ]) {
    const text = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
    await writeFile(join(dir, `${name}.ts`), name.endsWith("cache-lease-process") ? change(text) : text);
  }
  return (await import(pathToFileURL(join(dir, "executors/cache-lease-bridge.ts")).href))
    .startCacheLeaseBridge as typeof startCacheLeaseBridge;
}
async function verifiedExit(handle: Awaited<ReturnType<typeof fixture>>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      handle.bridge.stopped,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("terminal fault left helper alive")), 1700);
      }),
    ]);
    assert.equal(await cacheProcessTerminated(handle.identity), true);
    const leases = (await readFile("/proc/locks", "utf8"))
      .split("\n")
      .filter((line) => line.trim().split(/\s+/)[4] === String(handle.identity.pid));
    assert.deepEqual(leases, []);
  } finally {
    clearTimeout(timer);
  }
}

for (const [name, injection] of [
  ["malformed reply", '    if (check) return emit("MALFORMED\\n");'],
  ["ended evidence transport", "    if (check) { (void)close(1); for (;;) pause(); }"],
])
  test(`post-ready ${name} stops the lease-holder without caller cleanup`, { skip: !enabled }, async () => {
    const handle = await fixture(injection);
    try {
      await assert.rejects(handle.lease.check());
      await verifiedExit(handle);
    } finally {
      await handle.bridge.stop();
      await handle.fd.close();
    }
  });

test("post-ready timeout kills even a stopped leaf and releases its descriptors", { skip: !enabled }, async () => {
  const handle = await fixture();
  try {
    process.kill(handle.bridge.pid, "SIGSTOP");
    await assert.rejects(handle.lease.check(), /exceeded/);
    await verifiedExit(handle);
  } finally {
    await handle.bridge.stop();
    await handle.fd.close();
  }
});

test("saturated release cannot forget native ownership; mismatch is a terminal fault", { skip: !enabled }, async () => {
  for (const injection of [
    "",
    '    if (release) return emit("R %llu VALID %llu\\n",(unsigned long long)seq,(unsigned long long)id);',
    '    if (release) return emit("R %llu INVALID %llu BREAKING\\n",(unsigned long long)seq,(unsigned long long)id);',
    '    if (release) return emit("R %llu INVALID %llu FUTURE_REASON\\n",(unsigned long long)seq,(unsigned long long)id);',
  ]) {
    const handle = await fixture(injection);
    try {
      if (!injection) {
        const checks = Array.from({ length: 64 }, () => handle.lease.check());
        // Attach handlers before triggering synchronous admission failure.
        const settled = Promise.allSettled(checks);
        await assert.rejects(handle.lease.release());
        await settled;
      } else await assert.rejects(handle.lease.release(), /mismatched/);
      await verifiedExit(handle);
    } finally {
      await handle.bridge.stop();
      await handle.fd.close();
    }
  }
});

test(
  "callback failures on individual break and terminal loss are surfaced without host escape",
  { skip: !enabled },
  async () => {
    for (const injection of [
      '    if (check) return emit("MALFORMED\\n");',
      '    if (check) return emit("E BREAK %llu\\n",(unsigned long long)id);',
    ]) {
      let invoked = 0;
      const handle = await fixture(injection, () => {
        invoked++;
        throw new Error("callback exploded");
      });
      try {
        await assert.rejects(handle.lease.check(), /callback exploded/);
        await verifiedExit(handle);
        assert.match((await handle.bridge.faulted).message, /callback exploded/);
        assert.equal(invoked, 1, "failing callback is not recursively invoked");
      } finally {
        await handle.bridge.stop();
        await handle.fd.close();
      }
    }
  },
);

test(
  "post-ready output/diagnostic control errors become owned faults, not uncaught exceptions",
  { skip: !enabled },
  async () => {
    for (const stream of ["stdout", "stderr"]) {
      const start = await privateAdapter((text) => {
        const needle = "    return { child, stopped, stop };";
        assert.ok(text.includes(needle));
        const injected =
          `    let fired=false; child.stdout!.on("data", (bytes:Buffer)=>{\n` +
          `      if(!fired && bytes.toString().includes("ACQUIRED")){fired=true;setTimeout(()=>child.${stream}!.emit("error",new Error("injected ${stream} control error")),20);}\n    });\n`;
        return text.replace(needle, injected + needle);
      });
      const handle = await fixture("", () => {}, start);
      try {
        assert.match((await handle.bridge.faulted).message, /control failed/);
        await verifiedExit(handle);
      } finally {
        await handle.bridge.stop();
        await handle.fd.close();
      }
    }
  },
);

test("unresolved termination is exposed by faulted, never reported as stopped", { skip: !enabled }, async () => {
  const start = await privateAdapter((text) => {
    const needle = "if (!child.kill(signal)) controlFault ||= `${signal} not delivered`;";
    assert.ok(text.includes(needle));
    return text.replace(needle, "controlFault = `${signal} deliberately not delivered`;");
  });
  const handle = await fixture("", () => {}, start);
  try {
    process.kill(handle.bridge.pid, "SIGSTOP");
    await assert.rejects(handle.lease.check(), /exceeded/);
    assert.match((await handle.bridge.faulted).message, /termination unresolved/);
    assert.equal(await cacheProcessTerminated(handle.identity), false);
    await assert.rejects(handle.bridge.stop(), /termination unresolved/);
  } finally {
    process.kill(handle.bridge.pid, "SIGKILL");
    await handle.bridge.stopped;
    await handle.fd.close();
  }
});

test("native seccomp actually kills direct and io_uring network entry points", { skip: !enabled }, async () => {
  const original = await readFile(new URL("../src/executors/native/cache-lease.c", import.meta.url), "utf8");
  const owner = await readCacheOwner(process.pid),
    needle = "    if (!restrict_effects()) goto out;";
  assert.ok(original.includes(needle));
  for (const nr of ["SYS_socket", "SYS_io_uring_setup", "SYS_io_uring_enter", "SYS_io_uring_register"]) {
    const dir = await tempDir("cache-lease-seccomp"),
      source = join(dir, "probe.c"),
      binary = join(dir, "probe");
    await writeFile(source, original.replace(needle, needle + `\n    (void)syscall(${nr},0,0,0,0,0,0);`));
    await promisify(execFile)("cc", ["-static", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", binary]);
    await assert.rejects(
      promisify(execFile)(binary, [String(process.pid), String(process.pid), owner.startTicks, owner.bootId]),
      (error: unknown) => (error as { signal?: string }).signal === "SIGSYS",
      nr,
    );
  }
});
