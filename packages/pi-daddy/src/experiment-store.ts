import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "./file-lock.ts";
import { runWithFinalizers } from "./finalization.ts";
import { parseWorkJson, freezeWork } from "./work-ledger-json.ts";
import { resourceBindingDigest, type ExperimentBudgetBinding } from "./resource-budget.ts";
import { byteHash, cloneExperiment, closed, experimentCharter, experimentHash, type ExperimentCharter } from "./experiment-contract.ts";
export interface ExperimentBinding { version: "experiment-binding-v1"; directory: string; device: string; inode: string; journalDevice: string; journalInode: string; budget: ExperimentBudgetBinding; charter: ExperimentCharter }
export const experimentBindingDigest = (b: ExperimentBinding) => experimentHash(b);
export async function ownedDirectory(path: string) {
  const s = await lstat(path, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== BigInt(process.getuid!()) || (s.mode & 0o077n) !== 0n || await realpath(path) !== path) throw new Error("canonical private experiment directory required");
  return s;
}
export async function readExperimentFile(path: string, max: number, options: { appendOnly?: true } = {}): Promise<Buffer> {
  if (Object.keys(options).some(key => key !== "appendOnly") || options.appendOnly !== undefined && options.appendOnly !== true) throw new TypeError("invalid experiment read mode");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  return runWithFinalizers(async () => {
    const s = await file.stat({ bigint: true });
    if (!s.isFile() || s.nlink !== 1n || s.uid !== BigInt(process.getuid!()) || (s.mode & 0o077n) !== 0n || s.size > BigInt(max)) throw new Error("unsafe experiment file");
    const data = Buffer.alloc(Number(s.size)); let offset = 0;
    while (offset < data.length) { const n = (await file.read(data, offset, data.length - offset, offset)).bytesRead; if (!n) throw new Error("short experiment read"); offset += n; }
    const end = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    const identityChanged = current.dev !== s.dev || current.ino !== s.ino || current.nlink !== 1n;
    if (!options.appendOnly && (end.size !== s.size || end.mtimeNs !== s.mtimeNs || identityChanged)) throw new Error("experiment source changed");
    if (options.appendOnly) {
      if (end.size < s.size || identityChanged) throw new Error("experiment source changed");
      const verify = Buffer.alloc(data.length); let checked = 0;
      while (checked < verify.length) { const n = (await file.read(verify, checked, verify.length - checked, checked)).bytesRead; if (!n) throw new Error("short experiment read"); checked += n; }
      if (!verify.equals(data)) throw new Error("experiment source changed");
    }
    return data;
  }, [{ label: "experiment read close failed", run: () => file.close() }]);
}
export async function writeExperimentFile(path: string, bytes: Uint8Array) {
  const f = await open(path, "wx", 0o600);
  await runWithFinalizers(async () => { await f.writeFile(bytes); await f.sync(); await f.chmod(0o400); }, [{ label: "experiment artifact close failed", run: () => f.close() }]);
  const dir = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  await runWithFinalizers(() => dir.sync(), [{ label: "experiment artifact directory close failed", run: () => dir.close() }]);
}
export function validateExperimentBinding(value: ExperimentBinding): ExperimentBinding {
  const b = cloneExperiment(value); closed(b, ["version", "directory", "device", "inode", "journalDevice", "journalInode", "budget", "charter"]);
  if (b.version !== "experiment-binding-v1" || typeof b.directory !== "string" || b.directory !== resolve(b.directory) || b.directory.length > 1024 || b.directory.split("/").includes(".pi") || [b.device, b.inode, b.journalDevice, b.journalInode].some(v => typeof v !== "string" || !/^\d+$/.test(v)) || b.budget.version !== "4.0") throw new TypeError("independent experiment binding required");
  b.charter = experimentCharter(b.charter);
  if (resourceBindingDigest(b.budget) !== b.charter.budgetDigest) throw new TypeError("experiment budget mismatch");
  return freezeWork(b) as ExperimentBinding;
}
export async function createExperimentStore(directory: string, budget: ExperimentBudgetBinding, charter: ExperimentCharter, bytes: Uint8Array): Promise<ExperimentBinding> {
  if (directory !== resolve(directory) || directory.split("/").includes(".pi")) throw new Error("explicit unprotected absolute destination required");
  await ownedDirectory(dirname(directory)); await mkdir(directory, { mode: 0o700 }); const s = await ownedDirectory(directory);
  await writeExperimentFile(join(directory, "common.bin"), bytes);
  for (const v of charter.variants) await mkdir(join(directory, "variant-" + byteHash(v.executionId)), { mode: 0o700 });
  const journal = await open(join(directory, "experiment.jsonl"), "wx", 0o600);
  const b = await runWithFinalizers(async () => {
    const st = await journal.stat({ bigint: true });
    const value = validateExperimentBinding({ version: "experiment-binding-v1", directory, device: String(s.dev), inode: String(s.ino), journalDevice: String(st.dev), journalInode: String(st.ino), budget, charter });
    await journal.writeFile(JSON.stringify(value) + "\n"); await journal.sync(); return value;
  }, [{ label: "experiment creation close failed", run: () => journal.close() }]);
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  await runWithFinalizers(() => dir.sync(), [{ label: "experiment creation directory close failed", run: () => dir.close() }]); return b;
}
export function experimentStore(value: ExperimentBinding) {
  const b = validateExperimentBinding(value), path = join(b.directory, "experiment.jsonl");
  const check = async () => {
    const root = await ownedDirectory(b.directory), file = await lstat(path, { bigint: true });
    if (String(root.dev) !== b.device || String(root.ino) !== b.inode || String(file.dev) !== b.journalDevice || String(file.ino) !== b.journalInode) throw new Error("experiment identity replaced");
  };
  const read = async () => {
    await check(); const bytes = await readExperimentFile(path, 256 * 1024, { appendOnly: true }); await check();
    const text = new TextDecoder("utf8", { fatal: true }).decode(bytes); if (!text.endsWith("\n")) throw new Error("torn experiment journal");
    const lines = text.slice(0, -1).split("\n"); if (lines.length > 260 || experimentHash(parseWorkJson(lines[0])) !== experimentHash(b)) throw new Error("experiment header/bound mismatch");
    let previous = experimentHash(b); const events: Record<string, unknown>[] = [];
    for (const line of lines.slice(1)) {
      const record = parseWorkJson(line) as Record<string, unknown>; closed(record, ["seq", "previous", "event"]);
      if (record.seq !== events.length || record.previous !== previous || !record.event || typeof record.event !== "object" || Array.isArray(record.event)) throw new Error("invalid experiment sequence");
      previous = experimentHash(record); events.push(record.event as Record<string, unknown>);
    }
    return { events, previous, bytes: bytes.length };
  };
  return { binding: b, read, async transaction<T>(fn: (events: Record<string, unknown>[], append: (event: unknown) => Promise<void>) => Promise<T>) {
    await check(); return withFileLock(path, "experiment", async () => {
      const state = await read(); let size = state.bytes;
      return fn(state.events, async event => {
        if (state.events.length >= 258) throw new Error("experiment record bound reached");
        const record = { seq: state.events.length, previous: state.previous, event }, data = Buffer.from(JSON.stringify(record) + "\n");
        if (size + data.length > 256 * 1024) throw new Error("experiment journal byte bound reached");
        await check(); const f = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        await runWithFinalizers(async () => {
          const s = await f.stat({ bigint: true });
          if (!s.isFile() || s.nlink !== 1n || String(s.dev) !== b.journalDevice || String(s.ino) !== b.journalInode || s.size !== BigInt(size) || (s.mode & 0o077n) !== 0n) throw new Error("journal changed under lock");
          await f.writeFile(data); await f.sync();
        }, [{ label: "experiment append close failed", run: () => f.close() }]);
        size += data.length; await check(); state.previous = experimentHash(record); state.events.push(cloneExperiment(event) as Record<string, unknown>);
      });
    }, { staleRecovery: "disabled" });
  } };
}
