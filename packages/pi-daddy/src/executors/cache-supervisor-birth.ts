/** Private pre-entry bootstrap control. Claims are checked against actual host birth and launcher parent.
 * The supervisor accepts this frame only before GO/import; application stdout never supplies authority.
 */
import { cacheOwnerMatches, isCacheOwner, readCacheOwner, type CacheOwnerIdentity } from "../kernel/cache-owner.ts";
import { readBoundedFile } from "../kernel/bounded-read.ts";
import { observeCacheNamespace } from "./cache-namespace-death.ts";
export const CACHE_SUPERVISOR_GO = '{"piDaddyCacheSupervisor":1,"go":true}\n';
export const CACHE_SUPERVISOR_BIRTH_BYTES = 1024;
export function parseCacheSupervisorBirth(line: Buffer): CacheOwnerIdentity {
  if (line.length > CACHE_SUPERVISOR_BIRTH_BYTES) throw Error("cache bootstrap birth exceeded bound");
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch (cause) {
    throw Error("cache bootstrap birth malformed JSON", { cause });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("cache bootstrap birth malformed");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || row.piDaddyCacheSupervisor !== 1 || !isCacheOwner(row.birth))
    throw Error("cache bootstrap birth malformed");
  return Object.freeze({ ...row.birth });
}
export interface CacheSupervisorBirthPorts<T> {
  matches(owner: CacheOwnerIdentity): Promise<boolean>;
  readOwner(pid: number): Promise<CacheOwnerIdentity>;
  status(pid: number): Promise<string>;
  observe(owner: CacheOwnerIdentity): Promise<T>;
}
export const cacheSupervisorBirthPorts = {
  matches: cacheOwnerMatches,
  readOwner: readCacheOwner,
  status: async (pid: number) => {
    const read = await readBoundedFile(`/proc/${pid}/status`, { maxBytes: 16384, timeoutMs: 1000 });
    if (!read.ok) throw Error(`cache bootstrap status unavailable: ${read.detail}`);
    return read.text;
  },
  observe: observeCacheNamespace,
};
export async function acquireCacheSupervisorNamespace<T>(
  birth: CacheOwnerIdentity,
  root: CacheOwnerIdentity,
  launcher: CacheOwnerIdentity,
  ports: CacheSupervisorBirthPorts<T>,
): Promise<T> {
  if (
    birth.pid === root.pid ||
    birth.pid === launcher.pid ||
    birth.bootId !== root.bootId ||
    !(await ports.matches(root)) ||
    !(await ports.matches(launcher))
  )
    throw Error("cache bootstrap source owner is absent or changed");
  const actual = await ports.readOwner(birth.pid);
  if (actual.pid !== birth.pid || actual.bootId !== birth.bootId || actual.startTicks !== birth.startTicks)
    throw Error("cache bootstrap birth changed");
  const status = await ports.status(birth.pid),
    parent = status.match(/^PPid:\s+(\d+)$/m),
    ids = status
      .match(/^NSpid:\s+([\d \t]+)$/m)?.[1]
      .trim()
      .split(/\s+/);
  if (
    !parent ||
    Number(parent[1]) !== launcher.pid ||
    !ids ||
    ids.length < 2 ||
    Number(ids[0]) !== birth.pid ||
    ids.at(-1) !== "1"
  )
    throw Error("cache bootstrap parent or namespacePID1 mismatch");
  return ports.observe(birth);
}
