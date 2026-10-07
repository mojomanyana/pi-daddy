/**
 * Linux execution-cache owner identity, not a PID-file authority.
 *
 * The lifetime owner is the actual Pi process. A host boot ID and /proc start tick distinguish PID reuse;
 * zombies are not owners. These bounded procfs reads are allowed discovery, not an arbitrary command grant.
 * A bootstrap must verify this identity AFTER namespace setup and BEFORE importing work-starting code.
 * Bubblewrap's parent-death signal alone has a measured pre-exec/reparenting startup race.
 */
import { join } from "node:path";
import { BoundedReadCleanupError, readBoundedFile } from "./bounded-read.ts";

export interface CacheOwnerIdentity {
  pid: number;
  bootId: string;
  startTicks: string;
}

export function isCacheOwner(value: unknown): value is CacheOwnerIdentity {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<CacheOwnerIdentity>;
  return (
    Number.isSafeInteger(owner.pid) &&
    owner.pid! > 0 &&
    typeof owner.bootId === "string" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(owner.bootId) &&
    typeof owner.startTicks === "string" &&
    /^\d{1,24}$/.test(owner.startTicks)
  );
}

/** Trusted bounded-reader dependency; never process/requester claims or environment input. */
export type CacheOwnerRead = typeof readBoundedFile;

async function procText(path: string, label: string, reader: CacheOwnerRead): Promise<string> {
  const read = await reader(path, { maxBytes: 8192, timeoutMs: 1000 });
  if (!read.ok) throw new Error(`cache owner ${label}: ${read.why}: ${read.detail}`);
  return read.text;
}

function processStat(pid: number, text: string): { state: string; startTicks: string } {
  const end = text.lastIndexOf(")");
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (end < 0 || !text.startsWith(`${pid} (`) || fields.length < 20 || !/^\d{1,24}$/.test(fields[19]))
    throw new Error("cache owner stat is malformed");
  if (!/^[RSDTtIPWKZXx]$/.test(fields[0])) throw new Error("cache owner stat has an unknown process state");
  return { state: fields[0], startTicks: fields[19] };
}

export async function readCacheOwner(
  pid: number,
  procRoot = "/proc",
  reader: CacheOwnerRead = readBoundedFile,
): Promise<CacheOwnerIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("cache owner PID must be a positive safe integer");
  const info = processStat(pid, await procText(join(procRoot, String(pid), "stat"), "stat", reader));
  if (/^[ZXx]$/.test(info.state)) throw new Error("cache owner is not alive (zombie or dead)");
  const bootId = (await procText(join(procRoot, "sys/kernel/random/boot_id"), "boot identity", reader)).trim();
  const identity = { pid, bootId, startTicks: info.startTicks };
  if (!isCacheOwner(identity)) throw new Error("cache owner boot identity is malformed");
  return identity;
}

/**
 * Affirmative termination evidence is stricter than absence of authority below. Unreadable/malformed
 * procfs MUST throw, not certify cleanup. A dead state, typed absence, or validated identity replacement
 * proves the original process is gone. Validate the proc root's boot identity even for an absent PID.
 */
export async function cacheProcessTerminated(
  owner: CacheOwnerIdentity,
  procRoot = "/proc",
  reader: CacheOwnerRead = readBoundedFile,
): Promise<boolean> {
  if (!isCacheOwner(owner)) throw new Error("cache process termination identity is malformed");
  const bootId = (await procText(join(procRoot, "sys/kernel/random/boot_id"), "boot identity", reader)).trim();
  if (!isCacheOwner({ ...owner, bootId })) throw new Error("cache owner boot identity is malformed");
  if (bootId !== owner.bootId) return true;
  const read = await reader(join(procRoot, String(owner.pid), "stat"), { maxBytes: 8192, timeoutMs: 1000 });
  if (!read.ok) {
    if ((read.why === "unopenable" || read.why === "unreadable") && (read.code === "ENOENT" || read.code === "ESRCH"))
      return true;
    throw new Error(`cache process stat observation failed: ${read.why}: ${read.detail}`);
  }
  const actual = processStat(owner.pid, read.text);
  return /^[ZXx]$/.test(actual.state) || actual.startTicks !== owner.startTicks;
}

/** Any unreadable, dead or incompatible identity means no authority, never permission to adopt a process. */
export async function cacheOwnerMatches(
  owner: CacheOwnerIdentity,
  procRoot = "/proc",
  reader: CacheOwnerRead = readBoundedFile,
): Promise<boolean> {
  if (!isCacheOwner(owner)) return false;
  try {
    const actual = await readCacheOwner(owner.pid, procRoot, reader);
    return actual.bootId === owner.bootId && actual.startTicks === owner.startTicks;
  } catch (error) {
    if (error instanceof BoundedReadCleanupError) throw error;
    if (!(error instanceof Error) || !error.message.startsWith("cache owner")) throw error;
    return false;
  }
}
