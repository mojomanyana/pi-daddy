/** Trusted test fixture, not production authentication. Leave leaf waiting on P until caller kills owner. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { startLeaseProcess } from "../src/executors/cache-lease-process.ts";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
const [binary, sha256, path] = process.argv.slice(2);
const file = await open(path, 0x200000 | constants.O_NOFOLLOW), info = await file.stat({ bigint: true });
const leaf = await startLeaseProcess(binary, sha256, [String(process.pid), String(file.fd), String(info.dev), String(info.ino), "4096"], false);
await new Promise((resolve, reject) => {
  let data = "";
  leaf.child.stdout.on("data", (bytes) => {
    data += bytes.toString();
    if (data === "S1 READY\n") resolve();
    else if (data.length > 32 || data.includes("\n")) reject(new Error("owner fixture incompatible admission"));
  });
  leaf.child.on("exit", () => reject(new Error("owner fixture leaf stopped before admission")));
});
process.stdout.write(JSON.stringify({ owner: await readCacheOwner(process.pid), leaf: await readCacheOwner(leaf.child.pid) }) + "\n");
process.stdin.resume();
