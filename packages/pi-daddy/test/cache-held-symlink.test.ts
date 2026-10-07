import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
import { readHeldSymlink } from "../src/executors/cache-held-symlink.ts";
after(cleanupTempDirs);
async function fake(mode: string) {
  const root = await tempDir("held-link-protocol-"),
    script = join(root, "script.mjs"),
    binary = join(root, "leaf");
  await writeFile(
    script,
    `let input="";process.stdin.setEncoding("utf8");process.stdout.write("S1 READY\\n");process.stdin.on("data",b=>{input+=b;if(input==="P\\n"){process.stdout.write("S1 PINNED\\n");}else if(input==="P\\nR\\n"){${mode}}});`,
  );
  await writeFile(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`);
  await chmod(binary, 0o755);
  return {
    binary,
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
  };
}
const input = { fd: 987654321, dev: 1n, ino: 2n };
test("synthetic native payload preserves arbitrary target bytes; not an OS identity witness", async () => {
  const leaf = await fake('process.stdout.end("S1 LINK 1 2 2efffe\\n");process.stdin.destroy();');
  const target = await readHeldSymlink({ ...leaf, input, maxTargetBytes: 3 });
  assert.equal(target.toString("hex"), "2efffe");
});
test("invalid limits and descriptor identities refuse before helper launch", async () => {
  for (const maxTargetBytes of [0, -1, NaN, 4097])
    await assert.rejects(readHeldSymlink({ binary: "/absent", sha256: "", input, maxTargetBytes }), /maxTargetBytes/);
  for (const fd of [0, 2, NaN, -1])
    await assert.rejects(
      readHeldSymlink({ binary: "/absent", sha256: "", input: { ...input, fd }, maxTargetBytes: 32 }),
      /descriptor identity/,
    );
});
test("identity mismatch, malformed hex, oversized payload, duplicates and trailing data remain failures through close", async () => {
  for (const frame of [
    "S1 LINK 1 3 61\n",
    "S1 LINK 1 2 AA\n",
    "S1 LINK 1 2 0\n",
    "S1 LINK 1 2 61626364\n",
    "S1 LINK 1 2 61\nS1 LINK 1 2 61\n",
    "S1 LINK 1 2 61\ntrailing",
    "S1 LINK 1 2 61\nS1 F READ 5\n",
  ]) {
    const leaf = await fake(`process.stdout.end(${JSON.stringify(frame)});process.stdin.destroy();`);
    await assert.rejects(readHeldSymlink({ ...leaf, input, maxTargetBytes: 3 }), /held symlink/);
  }
});
test("a payload followed by nonzero exit never succeeds", async () => {
  const leaf = await fake('process.stdout.end("S1 LINK 1 2 61\\n");process.stdin.destroy();process.exitCode=78;');
  await assert.rejects(readHeldSymlink({ ...leaf, input, maxTargetBytes: 3 }), /helper stopped/);
});
test("abort stops and verifies the owned synthetic helper, not a successful empty target", async () => {
  const leaf = await fake('process.stdout.write("S1 LINK 1 2 61\\n");setInterval(()=>{},1000);'),
    signal = AbortSignal.timeout(100);
  await assert.rejects(readHeldSymlink({ ...leaf, input, maxTargetBytes: 3, signal }), /aborted/);
});
