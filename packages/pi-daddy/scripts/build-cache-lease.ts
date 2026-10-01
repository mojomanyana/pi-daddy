/** Publisher build only: install/grant nothing. Recipients use the prebuilt static Linux leaf. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CACHE_LEASE_PROTOCOL } from "../src/kernel/cache-lease-protocol.ts";

const output = fileURLToPath(new URL("../dist/executors/native/", import.meta.url));
await mkdir(output, { recursive: true });
// Only the measured architecture is shipped; C's arm64 branch is not arm64 qualification.
const supported = process.platform === "linux" && process.arch === "x64";
if (!supported) {
  const reason = `cache lease native build unsupported on ${process.platform}/${process.arch}`;
  await writeFile(
    `${output}/cache-lease.json`,
    JSON.stringify({ protocol: CACHE_LEASE_PROTOCOL, available: false, reason }),
  );
  console.warn(reason);
} else {
  const source = fileURLToPath(new URL("../src/executors/native/cache-lease.c", import.meta.url));
  const binary = `${output}/cache-lease-v2`;
  await promisify(execFile)("cc", [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fstack-protector-strong",
    "-D_FORTIFY_SOURCE=2",
    "-Wl,-z,relro,-z,now",
    source,
    "-o",
    binary,
  ]);
  const bytes = await readFile(binary);
  // Reject an accidentally dynamic publisher build. ELF program headers use the build architecture's 64-bit layout.
  if (bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1)
    throw new Error("cache lease publisher output must be little-endian ELF64");
  const offset = Number(bytes.readBigUInt64LE(32)),
    size = bytes.readUInt16LE(54),
    count = bytes.readUInt16LE(56);
  if (size < 56 || !Number.isSafeInteger(offset) || offset + size * count > bytes.length)
    throw new Error("cache lease publisher output has malformed program headers");
  for (let index = 0; index < count; index++)
    if (bytes.readUInt32LE(offset + index * size) === 3)
      throw new Error("cache lease helper must be static, with no ELF interpreter");
  await writeFile(
    `${output}/cache-lease.json`,
    JSON.stringify(
      {
        protocol: CACHE_LEASE_PROTOCOL,
        available: true,
        platform: process.platform,
        arch: process.arch,
        binary: "cache-lease-v2",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("cache lease: built static helper; no installation or capability grant performed");
}
