/** Publisher only. Static Linux x64 unprivileged OS leaf; no host install or authority changes. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const output = fileURLToPath(new URL("../dist/executors/native/", import.meta.url));
await mkdir(output, { recursive: true });
if (process.platform !== "linux" || process.arch !== "x64") {
  const reason = `cache held symlink unsupported on ${process.platform}/${process.arch}`;
  await writeFile(`${output}/cache-held-symlink.json`, JSON.stringify({ protocol: 1, available: false, reason }));
  console.warn(reason);
} else {
  const binary = `${output}/cache-held-symlink-v1`;
  await promisify(execFile)("cc", [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fstack-protector-strong",
    "-D_FORTIFY_SOURCE=2",
    "-Wl,-z,relro,-z,now",
    fileURLToPath(new URL("../src/executors/native/cache-held-symlink.c", import.meta.url)),
    "-o",
    binary,
  ]);
  const bytes = await readFile(binary);
  if (bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1)
    throw new Error("held symlink publisher output must be little-endian ELF64");
  const offset = Number(bytes.readBigUInt64LE(32)),
    size = bytes.readUInt16LE(54),
    count = bytes.readUInt16LE(56);
  if (size < 56 || !Number.isSafeInteger(offset) || offset + size * count > bytes.length)
    throw new Error("held symlink publisher output has malformed program headers");
  for (let index = 0; index < count; index++)
    if (bytes.readUInt32LE(offset + index * size) === 3)
      throw new Error("held symlink helper must be static, with no ELF interpreter");
  await writeFile(
    `${output}/cache-held-symlink.json`,
    JSON.stringify(
      {
        protocol: 1,
        available: true,
        platform: process.platform,
        arch: process.arch,
        binary: "cache-held-symlink-v1",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("cache held symlink: static unprivileged leaf; no install or capability grant");
}
