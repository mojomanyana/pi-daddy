/** Qualification counterexample: synchronized event streams are not proof of stable source bytes. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { startSupervisedCache } from "../src/executors/cache-supervisor.ts";
import { readCacheOwner, cacheProcessTerminated } from "../src/kernel/cache-owner.ts";
import { cleanupTempDirs, tempDir } from "../test/tmp.ts";

after(cleanupTempDirs);
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
interface Evidence {
  error?: string;
  before: string;
  during: string;
  after: string;
  mtimeUnchanged: boolean;
  ctimeUnchanged: boolean;
  losses: string[];
  warm: { fresh: boolean };
  changed: { fresh: boolean; changed: string[] };
  restored: { fresh: boolean; changed: string[] };
}

async function qualify(binary: string): Promise<Evidence> {
  const dir = await tempDir("cache-input-consistency"),
    root = join(dir, "workspace");
  await mkdir(root);
  await writeFile(join(root, ".watchmanconfig"), "{}");
  await writeFile(join(root, "input"), "initial!");
  let framing = "",
    result: Evidence | undefined;
  const handle = await startSupervisedCache({
    owner: await readCacheOwner(process.pid),
    entry: new URL("./cache-input-consistency-fixture.ts", import.meta.url),
    args: [dir, binary],
    onData: (stream, bytes) => {
      if (stream !== "stdout") return;
      framing += bytes.toString("utf8");
      const newline = framing.indexOf("\n");
      if (newline !== -1) {
        result = JSON.parse(framing.slice(0, newline)) as Evidence;
        framing = framing.slice(newline + 1);
      }
    },
  });
  try {
    const deadline = performance.now() + 6000;
    while (!result && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(result, "input qualification did not report within bound");
    return result;
  } finally {
    await handle.stop();
  }
}

test(
  "existing mmap change-and-undo can evade Watchman and unchanged metadata; no eligibility inferred",
  { skip: !enabled },
  async () => {
    const evidence = await qualify(process.env.PI_DADDY_CACHE_WATCHMAN ?? "watchman");
    assert.equal(evidence.error, undefined);
    assert.equal(evidence.before, evidence.after, "before/after equality alone must not justify reuse");
    assert.notEqual(evidence.during, evidence.before, "the command can consume different bytes during this interval");
    assert.equal(evidence.mtimeUnchanged, true);
    assert.equal(evidence.ctimeUnchanged, true);
    assert.equal(evidence.warm.fresh, true);
    assert.equal(evidence.changed.fresh, true);
    assert.equal(evidence.restored.fresh, true);
    assert.deepEqual(evidence.changed.changed, []);
    assert.deepEqual(evidence.restored.changed, []);
    assert.deepEqual(evidence.losses, []);
  },
);

test("unavailable TERM-ignoring Watchman cannot hang qualification teardown", { skip: !enabled }, async () => {
  const dir = await tempDir("cache-stalled-watchman"),
    shim = join(dir, "watchman");
  const identity = join(dir, "host-stat");
  await writeFile(
    shim,
    `#!${process.execPath}\nconst fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(identity)},fs.readFileSync('/run/pi-daddy-cache-host-proc/self/stat'));
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`,
    { mode: 0o700 },
  );
  const began = performance.now(),
    evidence = await qualify(shim);
  assert.ok(evidence.error, "startup timeout must not become successful qualification");
  assert.ok(performance.now() - began < 8000, "bounded supervisor teardown must end every owned descendant");
  const original = await readFile(identity, "utf8"),
    pid = Number(original.split(" ")[0]);
  const startTicks = original
    .slice(original.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/)[19];
  assert.ok(Number.isSafeInteger(pid) && pid > 1, "fixture must prove it started before testing termination");
  const owner = { pid, startTicks, bootId: (await readCacheOwner(process.pid)).bootId };
  const deadline = performance.now() + 1500;
  let alive = true;
  while (alive && performance.now() < deadline) {
    alive = !(await cacheProcessTerminated(owner));
    if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(alive, false, "the TERM-ignoring owned service must actually be dead, not merely signalled");
});
