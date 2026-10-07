/** UNTESTED (per request). Own exported installed constructors; never reconstruct another tool from metadata.
 * Pins cover the inspected Linux default operations/accumulator ABI, not arbitrary custom implementations.
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CacheProductReaders } from "../src/executors/cache-product-readers.ts";
import type { CacheNativeBashOptions } from "./cache-native-bash.ts";
const files = [
  "index.js",
  "core/tools/bash.js",
  "utils/shell.js",
  "utils/child-process.js",
  "core/tools/output-accumulator.js",
  "core/tools/truncate.js",
  "core/tools/tool-definition-wrapper.js",
];
const pins: Record<string, readonly string[]> = {
  "0.84.1": [
    "de74c5324f2b38317eb3f9ae36ef47b41e130a4501637a0e5fce555a3e1c065b",
    "fda4002e5b82f5a93bc9ffb1a3bcc365362dd07cc6b016a55e1448765e541258",
    "c418c465d20567b64c5695b8c4401213e20afd0d5767c9d93f630c421b888c9d",
    "cfc7b3361e42b61ee75aecc2b436ff7462f7e4431b4b646da7166f3c5706c9b8",
    "4fe5f89ce61446ec50da5ea26e9f66e34ed7d628df8563eda403b804a67af50a",
    "3a627a6407f3726aa56a9580548db230c20e4fee59b212ea3d12e2c45073f75d",
    "b08ccb77cf3664c3b42e5cee858e150925c0eedbaca397474c3af3de22030abd",
  ],
  "1.0.2": [
    "5482298b995db935f7b96f5d6056fa1c36ac6fc80456be594ef65b83c62b0d30",
    "f32e87a42f66276b2eafaaf0848babf52523d37ab0fd448439586376747f03c4",
    "c8378f2b0566e35f90dfbb622a2214acf5cf45d15107c44b260cad897b539f72",
    "cfc7b3361e42b61ee75aecc2b436ff7462f7e4431b4b646da7166f3c5706c9b8",
    "8693404b2493688b901b9bda78b6c799028dd8c64786b5d593eb51c943bfd365",
    "24c5350761b487c154f950acf56a995dc1acdeac0c5d0f096efdaac71c8c231e",
    "02fe785c52294d14216605d40d5592ac2accd1a3125891523e2a6c87feb5810c",
  ],
};
export interface InstalledCacheNative {
  version: string;
  native: CacheNativeBashOptions["native"];
}
export async function loadInstalledCacheNative(
  readers: CacheProductReaders,
  entry?: URL,
): Promise<InstalledCacheNative> {
  const selected = entry ?? new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
  if (selected.protocol !== "file:" || !selected.pathname.endsWith("/dist/index.js"))
    throw Error("cache native exports must come from a supported installed package");
  const root = new URL("./", selected);
  const manifest = JSON.parse((await readers.read(fileURLToPath(new URL("../package.json", root)), 65536)).toString());
  const expected = pins[manifest.version];
  if (manifest.name !== "@earendil-works/pi-coding-agent" || !expected)
    throw Error("cache native installed version unsupported; keep ordinary tools");
  for (let index = 0; index < files.length; index++) {
    const bytes = await readers.read(fileURLToPath(new URL(files[index], root)), 1024 * 1024);
    if (createHash("sha256").update(bytes).digest("hex") !== expected[index])
      throw Error("cache native installed ABI/source differs; keep ordinary tools");
  }
  const sdk = (await import(selected.href)) as typeof import("@earendil-works/pi-coding-agent");
  if (typeof sdk.createBashToolDefinition !== "function" || typeof sdk.createLocalBashOperations !== "function")
    throw Error("cache native exported factories unavailable; keep ordinary tools");
  return Object.freeze({
    version: manifest.version,
    native: Object.freeze({
      createBashToolDefinition: sdk.createBashToolDefinition,
      createLocalBashOperations: sdk.createLocalBashOperations,
    }),
  });
}
