/** Synthetic discovery rows exercise the actual generated fixture loop, never process authority/freshness. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
import { runInNewContext } from "node:vm";
import { after, test } from "node:test";
import { checksumWitness, checksumFreshWitness } from "../test-integration/cache-checksum-profile-fixture.ts";
after(cleanupTempDirs);
const source = await readFile(
  new URL("../test-integration/cache-checksum-profile-fixture.ts", import.meta.url),
  "utf8",
);
const begin = source.indexOf(" for(const pid of fs.readdirSync(host)");
const end = source.indexOf(" observers.push(matches[0]);", begin);
assert.ok(begin >= 0 && end > begin, "the tested loop must be the generated witness program's actual discovery path");
const loop = source.slice(begin, end + " observers.push(matches[0]);".length).replaceAll("\\\\", "\\");
interface Row {
  args: string[];
  status?: string;
  error?: string;
}
async function discover(rows: Record<string, Row>) {
  const observers: unknown[] = [],
    calls: string[] = [];
  const context = {
    host: "/synthetic-proc",
    prefix: "/synthetic-receipt",
    local: "28",
    localOwner: { startTicks: "100" },
    matches: [],
    observers,
    fs: {
      readdirSync: () => Object.keys(rows),
      readFileSync(path: string) {
        const [, pid, field] = path.match(/synthetic-proc\/(\d+)\/(\w+)$/)!;
        const row = rows[pid];
        if (field === "cmdline") return Buffer.from(row.args.join("\0"));
        if (row.status === undefined) throw Object.assign(new Error("missing status"), { code: "ENOENT" });
        return row.status;
      },
    },
    async readCacheOwner(pid: number) {
      calls.push(String(pid));
      if (rows[pid].error) throw new Error(rows[pid].error);
      return { pid, bootId: "synthetic", startTicks: "100" };
    },
  };
  await runInNewContext(`(async()=>{${loop}})()`, context);
  return { observers, calls };
}
test("missing witness retains the instrumented command diagnostic, not only secondary ENOENT (REV-DIAGNOSTIC)", async () => {
  const reply = {
    code: 0,
    signal: null,
    running: false,
    stdout: '{"ok":false,"error":"synthetic zombie admission failure"}',
    stderr: "",
    overflow: false,
    controlError: "",
    aborted: false,
  };
  await assert.rejects(checksumWitness("/proc/pi-daddy-checksum-witness-absent", reply), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /witness unavailable/);
    const cause = error.cause as { observation: NodeJS.ErrnoException; command: typeof reply };
    assert.equal(cause.observation.code, "ENOENT");
    assert.equal(cause.command.stdout, reply.stdout);
    return true;
  });
});

test("prior successful witness cannot mask the next failed discovery (REV-STALE)", async () => {
  assert.match(
    source,
    /await checksumFreshWitness\(f\.witness\);[\s\S]*const prepared =/,
    "reset must be wired before invocation, not only available as a helper",
  );
  const path = join(await tempDir("checksum-stale-witness-"), "witness");
  await writeFile(path, JSON.stringify({ prior: "synthetic successful receipt; never a real process witness" }));
  await checksumFreshWitness(path);
  const reply = {
    code: 0,
    signal: null,
    running: false,
    stdout: '{"ok":false,"error":"synthetic next-run discovery failed"}',
    stderr: "",
    overflow: false,
    controlError: "",
    aborted: false,
  };
  await assert.rejects(checksumWitness(path, reply), (error: unknown) => {
    assert.ok(error instanceof Error);
    const cause = error.cause as { observation: NodeJS.ErrnoException; command: typeof reply };
    assert.equal(cause.observation.code, "ENOENT");
    assert.equal(cause.command.stdout, reply.stdout);
    return true;
  });
  await checksumFreshWitness(path); // Only genuine absence is an acceptable reset outcome.
  await writeFile(path, "not a directory");
  await assert.rejects(checksumFreshWitness(join(path, "child")), /ENOTDIR/); // Non-absence errors must stay loud.
});

const target = { args: ["strace", "-o", "/synthetic-receipt"], status: "NSpid:\t1 28\n" };
test("unrelated namespace PID collision is filtered before strict owner admission (REV-DISCOVERY)", async () => {
  const result = await discover({
    "1": target,
    "2": { args: [], status: "NSpid:\t2 28\n", error: "cache owner is not alive (zombie or dead)" },
  });
  assert.deepEqual(result.calls, ["1"]);
  assert.equal(result.observers.length, 1);
});
test("matching zombie/malformed identity or missing status cannot be silently ignored", async () => {
  for (const error of ["zombie or dead", "stat is malformed"])
    await assert.rejects(discover({ "1": { ...target, error } }), new RegExp(error));
  await assert.rejects(discover({ "1": { args: target.args } }), /missing status/);
});
test("duplicate or missing matching tracer identities cannot certify discovery", async () => {
  await assert.rejects(discover({ "1": target, "2": target }), /ambiguous or missing/);
  await assert.rejects(discover({ "1": { args: [], status: target.status } }), /ambiguous or missing/);
});
