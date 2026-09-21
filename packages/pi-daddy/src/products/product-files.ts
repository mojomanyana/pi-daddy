import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readDailySnapshot } from "./daily-view-input.ts";
import { parseRetentionJson } from "../governance/retention-json.ts";
import { runWithFinalizers } from "../governance/finalization.ts";

export const privateDirectory = (path: string) => directory(path, true);
/** Pi's shared resource directory may be searchable; retained text files/subdirectories remain owner-only. */
export const projectProductDirectory = (path: string) => directory(path, false);
async function directory(path: string, ownerOnly: boolean): Promise<void> {
  if (resolve(path) !== path) throw Error("absolute canonical product directory required");
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const state = await lstat(path);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    state.mode & (ownerOnly ? 0o077 : 0o022) ||
    state.uid !== process.getuid?.() ||
    (await realpath(path)) !== path
  )
    throw Error(
      `owned non-writable${ownerOnly ? " private" : ""} directory required: ${path}; existing permissions were not changed`,
    );
}
export async function readProductJson(path: string, limit = 128 * 1024): Promise<unknown | null> {
  try {
    const state = await lstat(path);
    if (
      !state.isFile() ||
      state.isSymbolicLink() ||
      state.mode & 0o077 ||
      state.uid !== process.getuid?.() ||
      state.nlink !== 1 ||
      (await realpath(path)) !== path
    )
      throw Error(`private regular product file required: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const snapshot = await readDailySnapshot(path, limit);
  if (snapshot.status !== "read") throw Error(`product file unavailable: ${path}`);
  const state = await lstat(path);
  if (state.mode & 0o077 || state.uid !== process.getuid?.() || state.nlink !== 1 || (await realpath(path)) !== path)
    throw Error(`private regular product file required: ${path}`);
  return parseRetentionJson(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes), limit);
}
export async function writeProductJson(path: string, value: unknown, replace = false): Promise<void> {
  await (basename(dirname(path)) === ".pi" ? projectProductDirectory : privateDirectory)(dirname(path));
  const text = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(text) > 128 * 1024) throw Error("product file bound exceeded");
  if (!replace) {
    await writeFile(path, text, { mode: 0o600, flag: "wx" });
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await runWithFinalizers(async () => {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }, [
    {
      label: "product temporary cleanup",
      run: async () => {
        await rm(temporary, { force: true });
      },
    },
  ]);
}
