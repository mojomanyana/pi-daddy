/** UNTESTED (per request). Package assembly only; never installs or activates helpers. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const directory = fileURLToPath(new URL("../dist/executors/native/", import.meta.url));
await mkdir(directory, { recursive: true });
for (const name of ["cache-shell", "cache-broker"]) {
  const source = await readFile(new URL(`../src/executors/native/${name}.c`, import.meta.url));
  if (process.platform !== "linux" || process.arch !== "x64") {
    await writeFile(
      `${directory}/${name}.json`,
      JSON.stringify({
        protocol: 1,
        available: false,
        reason: `unsupported ${process.platform}/${process.arch}`,
      }) + "\n",
    );
    continue;
  }
  const binary = `${name}-v1`;
  await promisify(execFile)("cc", [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fstack-protector-strong",
    "-D_FORTIFY_SOURCE=2",
    "-Wl,-z,relro,-z,now",
    fileURLToPath(new URL(`../src/executors/native/${name}.c`, import.meta.url)),
    "-o",
    `${directory}/${binary}`,
  ]);
  const bytes = await readFile(`${directory}/${binary}`);
  if (bytes.length < 64 || bytes.subarray(0, 6).toString("hex") !== "7f454c460201" || bytes.readUInt16LE(18) !== 62)
    throw Error("cache native publisher requires Linux x64 ELF64");
  const offset = Number(bytes.readBigUInt64LE(32)),
    size = bytes.readUInt16LE(54),
    count = bytes.readUInt16LE(56);
  if (size < 56 || !Number.isSafeInteger(offset) || offset + size * count > bytes.length)
    throw Error("cache native publisher program headers malformed");
  for (let index = 0; index < count; index++)
    if ([2, 3].includes(bytes.readUInt32LE(offset + index * size)))
      throw Error("cache native image must have no dynamic loader or dynamic segment");
  await writeFile(
    `${directory}/${name}.json`,
    JSON.stringify(
      {
        protocol: 1,
        available: true,
        platform: "linux",
        arch: "x64",
        binary,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sourceSha256: createHash("sha256").update(source).digest("hex"),
      },
      null,
      2,
    ) + "\n",
  );
}
