import { lstat, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { WorkLedgerWriteError } from "./work-ledger-types.ts";

/** Only actual errno-class failures cross the content-free filesystem error boundary. */
export function workFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string" && Object.hasOwn(constants.errno, error.code);
}
export const validWorkPath = (path: string) => path.length > 0 && isAbsolute(path) && !path.includes("\0");
// Node encodes string filesystem paths as UTF-8: lone UTF-16 surrogates become U+FFFD.
// Compare that exact spelling even for absent leaves/ancestors, before mkdir or lock acquisition.
// This preserves valid Unicode verbatim; it is not Unicode normalization or case folding.
const filesystemPath = (path: string) => Buffer.from(resolve(path), "utf8").toString("utf8");
const invalid = (): never => { throw new WorkLedgerWriteError("WORK_DESTINATION_INVALID"); };
const alias = (): never => { throw new WorkLedgerWriteError("WORK_DESTINATION_ALIAS"); };
const same = (a: BigIntStats | null, b: BigIntStats | null) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
function ancestors(path: string): string[] {
  const result: string[] = [];
  for (let p = dirname(path); ; p = dirname(p)) { result.push(p); if (dirname(p) === p) return result; }
}
interface PathFact {
  path: string;
  canonical: string | null;
  entry: BigIntStats | null;
  target: BigIntStats | null;
  invalid: boolean;
  io: boolean;
}
/** Internal descriptor/topology facts, never a public result, ambient grant lookup or authority input. */
export interface WorkDestination {
  readonly requestedPath: string;
  readonly grantLedgerPath: string | null;
  readonly path: string;
  readonly existing: BigIntStats | null;
  readonly protectedInodes: readonly BigIntStats[];
}

/** Read-only, complete preflight. A protected filename reserves its entire directory namespace too.
 * Compare lexical paths, canonical paths and exact dev/ino identities; aliases outrank failed facts,
 * which outrank unsafe topology. This is cooperative misrouting protection, NOT host containment. */
export async function workDestination(requestedPath: string, grantLedgerPath: string | null): Promise<WorkDestination> {
  if (!validWorkPath(requestedPath) || (grantLedgerPath !== null && !validWorkPath(grantLedgerPath))) invalid();
  const path = filesystemPath(requestedPath), leaves = [path, path + ".lock"];
  const protectedPaths = grantLedgerPath === null ? [] : [filesystemPath(grantLedgerPath), filesystemPath(grantLedgerPath) + ".lock"];
  const workPaths = new Set(leaves.flatMap(p => [p, ...ancestors(p)]));
  if (protectedPaths.some(p => workPaths.has(p))) alias(); // Proven lexical collision needs no I/O.
  const facts = new Map<string, Promise<PathFact>>();
  function probe(path: string): Promise<PathFact> {
    const prior = facts.get(path); if (prior) return prior;
    const pending = inspect(path); facts.set(path, pending); return pending;
  }
  async function inspect(path: string): Promise<PathFact> {
    const fact: PathFact = { path, canonical: null, entry: null, target: null, invalid: false, io: false };
    try { fact.entry = await lstat(path, { bigint: true }); }
    catch (error) {
      if (!workFsError(error)) throw error;
      if (error.code !== "ENOENT") { fact.invalid = ["ENOTDIR", "ELOOP"].includes(error.code!); fact.io = !fact.invalid; return fact; }
    }
    if (fact.entry) {
      try {
        fact.canonical = await realpath(path);
        fact.target = fact.entry.isSymbolicLink() ? await stat(path, { bigint: true }) : fact.entry;
      } catch (error) {
        if (!workFsError(error)) throw error;
        fact.invalid = ["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code!); fact.io = !fact.invalid;
      }
    } else {
      const parentPath = dirname(path);
      if (parentPath === path) { fact.invalid = true; return fact; }
      const parent = await probe(parentPath);
      fact.invalid = parent.invalid || (parent.target !== null && !parent.target.isDirectory()); fact.io = parent.io;
      if (parent.canonical) fact.canonical = join(parent.canonical, basename(path));
    }
    return fact;
  }
  const protectedFacts = await Promise.all(protectedPaths.map(probe));
  const initial = await Promise.all([...workPaths].map(probe));
  // A symlink parent can jump INSIDE a reserved directory. Include every canonical ancestor,
  // not just lexical ancestors whose realpath might skip over the protected directory itself.
  for (const fact of initial) if (fact.canonical) for (const p of [fact.canonical, ...ancestors(fact.canonical)]) workPaths.add(p);
  const workFacts = await Promise.all([...workPaths].map(probe));
  for (const w of workFacts) for (const p of protectedFacts) {
    if (w.path === p.path || (w.canonical !== null && w.canonical === p.canonical) || same(w.target, p.target)) alias();
  }
  const all = [...workFacts, ...protectedFacts];
  if (all.some(f => f.io)) throw new WorkLedgerWriteError("WORK_LEDGER_WRITE_FAILED");
  if (all.some(f => f.invalid)) invalid();
  for (const leaf of leaves) {
    const f = await probe(leaf);
    if (f.entry && (!f.entry.isFile() || f.entry.nlink !== 1n)) invalid();
  }
  for (const p of [...ancestors(path), ...ancestors((await probe(path)).canonical!)]) {
    const f = await probe(p);
    if (f.target && !f.target.isDirectory()) invalid();
  }
  const file = await probe(path);
  return { requestedPath, grantLedgerPath, path: file.canonical!, existing: file.target,
    protectedInodes: protectedFacts.flatMap(f => f.target ? [f.target] : []) };
}

/** Repeat classification after mkdir/acquisition/open. Never write through a freshly resolved handle. */
export async function recheckWorkDestination(original: WorkDestination, handle?: FileHandle): Promise<void> {
  const current = await workDestination(original.requestedPath, original.grantLedgerPath);
  if (handle) {
    const actual = await handle.stat({ bigint: true });
    if (current.protectedInodes.some(p => same(actual, p))) alias();
    if (!actual.isFile() || actual.nlink !== 1n || !same(actual, current.existing)) invalid();
  }
  if (original.path !== current.path || (original.existing && !same(original.existing, current.existing))) invalid();
}
