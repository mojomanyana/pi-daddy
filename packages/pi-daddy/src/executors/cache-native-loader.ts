/** UNTESTED (per request). Package manifests identify static OS leaves, never profile or caller authority. */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CacheProductReaders } from "./cache-product-readers.ts";
export interface CacheNativeAssets {
  shell: Buffer;
  broker: Buffer;
  shellSha256: string;
  brokerSha256: string;
}
function staticImage(bytes: Buffer): void {
  if (bytes.length < 64 || bytes.subarray(0, 6).toString("hex") !== "7f454c460201" || bytes.readUInt16LE(18) !== 62)
    throw Error("cache helper is not supported x64 ELF64");
  const offset = Number(bytes.readBigUInt64LE(32)),
    size = bytes.readUInt16LE(54),
    count = bytes.readUInt16LE(56);
  if (size < 56 || !count || !Number.isSafeInteger(offset) || offset + size * count > bytes.length)
    throw Error("cache helper program headers malformed");
  for (let index = 0; index < count; index++)
    if ([2, 3].includes(bytes.readUInt32LE(offset + index * size)))
      throw Error("cache helper contains a dynamic loader/segment");
}
export async function loadCacheNativeAssets(readers: CacheProductReaders): Promise<CacheNativeAssets> {
  if (process.platform !== "linux" || process.arch !== "x64") throw Error("cache product requires Linux x64");
  const images: Buffer[] = [],
    hashes: string[] = [];
  for (const name of ["cache-shell", "cache-broker"]) {
    // Both source extensions and compiled SDK use only assembled package assets, never workspace paths.
    const root = import.meta.url.endsWith(".ts")
      ? new URL("../../dist/executors/native/", import.meta.url)
      : new URL("./native/", import.meta.url);
    const manifest = JSON.parse((await readers.read(fileURLToPath(new URL(`${name}.json`, root)), 8192)).toString());
    if (manifest.available !== true) throw Error(`cache helper unavailable: ${String(manifest.reason)}`);
    if (
      manifest.protocol !== 1 ||
      manifest.platform !== "linux" ||
      manifest.arch !== "x64" ||
      manifest.binary !== `${name}-v1` ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.sourceSha256)
    )
      throw Error("cache helper manifest incompatible");
    const source = await readers.read(fileURLToPath(new URL(`../../../src/executors/native/${name}.c`, root)), 131072);
    if (createHash("sha256").update(source).digest("hex") !== manifest.sourceSha256)
      throw Error("cache helper source manifest mismatch");
    const bytes = await readers.read(fileURLToPath(new URL(manifest.binary, root)), 8 * 1024 * 1024);
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256)
      throw Error("cache helper digest mismatch");
    staticImage(bytes);
    images.push(bytes);
    hashes.push(manifest.sha256);
  }
  return { shell: images[0], broker: images[1], shellSha256: hashes[0], brokerSha256: hashes[1] };
}
