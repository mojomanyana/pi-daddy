/** Exercise the packaged native protocol, including refusal before any worker is forked. */
import assert from "node:assert/strict";
import { spawn, type StdioOptions } from "node:child_process";
import { once } from "node:events";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";
import type { Duplex, Readable } from "node:stream";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
import { WORKER_SHA256 } from "../src/executors/worker-artifact.ts";
after(cleanupTempDirs);
const helper = fileURLToPath(new URL("../native/linux-x64/worker", import.meta.url));
async function raw(
  t: import("node:test").TestContext,
  code: string,
  grace = "500",
  stdio: StdioOptions = ["ignore", "pipe", "pipe", "pipe", "pipe", "ignore"],
) {
  const root = await tempDir("pi-native-protocol-");
  const owner = join(root, "owner");
  await mkdir(owner);
  const binary = openSync(helper, "r");
  assert.ok(Array.isArray(stdio));
  stdio[5] = binary;
  const child = spawn(
    helper,
    ["fixture", "nonce", root, WORKER_SHA256, owner, grace, "3000", "--", process.execPath, "-e", code],
    { stdio },
  );
  closeSync(binary);
  const closed = once(child, "close");
  const control = child.stdio[3] as Duplex | undefined;
  control?.on("error", () => undefined);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      control?.end("K");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3500);
      await closed;
      clearTimeout(timer);
    }
  });
  return { root, owner, child, control, closed };
}
function line(stream: Readable, expected: string) {
  return new Promise<void>((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => {
      stream.off("data", onData);
      reject(new Error(`missing ${expected}`));
    }, 5000);
    function onData(bytes: Buffer) {
      data += bytes.toString();
      if (data.includes(expected)) {
        clearTimeout(timer);
        stream.off("data", onData);
        resolve();
      }
    }
    stream.on("data", onData);
  });
}
for (const descriptor of [3, 4])
  test(`native worker refuses invalid descriptor ${descriptor} before creating ownership`, async (t) => {
    const stdio: StdioOptions = ["ignore", "pipe", "pipe", "pipe", "pipe", "ignore"];
    stdio[descriptor] = "ignore";
    const run = await raw(t, "process.exit(99)", "500", stdio);
    assert.equal((await run.closed)[0], 65);
    await assert.rejects(access(join(run.owner, "ownership.json")));
  });
for (const value of ["", "1junk", "-1", "+1", " 1", "999999999999999999999999999"])
  test(`native worker refuses malformed grace ${JSON.stringify(value)}`, async (t) => {
    const run = await raw(t, "process.exit(99)", value);
    assert.equal((await run.closed)[0], 64);
    await assert.rejects(access(join(run.owner, "ownership.json")));
  });
test("native worker sends TERM only once during grace, then escalates", async (t) => {
  const run = await raw(
    t,
    "process.on('SIGTERM',()=>process.stdout.write('term\\n'));process.stdout.write('ready\\n');setInterval(()=>{},1000)",
    "1000",
  );
  let output = "";
  run.child.stdout!.on("data", (bytes) => {
    output += bytes;
  });
  await line(run.child.stdio[4] as Readable, "\n");
  const ready = line(run.child.stdout!, "ready");
  run.control!.write("S");
  await ready;
  const terminated = line(run.child.stdout!, "term");
  run.control!.write("C");
  await terminated;
  await delay(150);
  assert.equal(output.match(/term/g)?.length, 1);
  run.control!.write("K");
  assert.equal((await run.closed)[0], 0);
  const receipt = JSON.parse(await readFile(join(run.owner, "receipt.json"), "utf8"));
  assert.equal(receipt.reason, "cancelled");
  assert.equal(receipt.workerSignal, 9);
  assert.equal(receipt.reapedAll, true);
});
test("late hard stop preserves worker-exit as the settlement reason", async (t) => {
  const descendant =
    "process.on('SIGTERM',()=>process.stdout.write('term\\n'));process.send('ready');process.disconnect();setInterval(()=>{},1000)";
  const command = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','inherit','inherit','ipc']});child.once('message',()=>process.exit(0));`;
  const run = await raw(t, command, "1500");
  await line(run.child.stdio[4] as Readable, "\n");
  const terminated = line(run.child.stdout!, "term");
  run.control!.write("S");
  await terminated;
  run.control!.write("K");
  assert.equal((await run.closed)[0], 0);
  const receipt = JSON.parse(await readFile(join(run.owner, "receipt.json"), "utf8"));
  assert.equal(receipt.workerCode, 0);
  assert.equal(receipt.reason, "worker-exit");
  assert.equal(receipt.reapedAll, true);
});
