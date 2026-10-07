/** Hold the worker's actual proc mount and verify every visible descendant after PID1 death.
 * A zombie PID1/exited bwrap proxy can precede descendant death. The held directory keeps the original
 * proc mount/PID namespace alive, including descendants in nested PID namespaces; no host-wide scan,
 * UID filtering, namespace-inode reuse assumption, or extra privilege is needed.
 * Failed close retains the descriptor. Process-tree death is not kernel-reference/RCU teardown.
 */
import { open, readlink, readdir, type FileHandle } from "node:fs/promises";
import {
  cacheOwnerMatches,
  cacheProcessTerminated,
  readCacheOwner,
  type CacheOwnerIdentity,
} from "../kernel/cache-owner.ts";
import { readBoundedFile } from "../kernel/bounded-read.ts";
export class CacheNamespaceCleanupError extends AggregateError {
  readonly handle: FileHandle;
  constructor(errors: unknown[], handle: FileHandle) {
    super(errors, "namespace descriptor cleanup unresolved; retain");
    this.handle = handle;
  }
  async cleanup() {
    await this.handle.close();
  }
}
export async function observeCacheNamespace(owner: CacheOwnerIdentity) {
  if (!(await cacheOwnerMatches(owner))) throw Error("namespace owner changed before observation");
  const id = await readlink(`/proc/${owner.pid}/ns/pid`);
  if (id === (await readlink("/proc/self/ns/pid"))) throw Error("owned namespace is not private");
  const handle = await open(`/proc/${owner.pid}/root/proc`, "r"),
    procRoot = `/proc/self/fd/${handle.fd}`;
  try {
    if (!(await handle.stat()).isDirectory()) throw Error("owned proc view is not a directory");
    const actual = await readCacheOwner(1, procRoot);
    if (actual.startTicks !== owner.startTicks || actual.bootId !== owner.bootId || !(await cacheOwnerMatches(owner)))
      throw Error("owned proc view does not identify its namespacePID1");
    return { owner, handle, procRoot, closed: false };
  } catch (error) {
    try {
      await handle.close();
    } catch (cleanup) {
      throw new CacheNamespaceCleanupError([error, cleanup], handle);
    }
    throw error;
  }
}
export async function cacheNamespaceTerminated(namespace: {
  owner: CacheOwnerIdentity;
  procRoot: string;
}): Promise<boolean> {
  if (!(await cacheProcessTerminated(namespace.owner))) return false;
  const rows = await readdir(namespace.procRoot);
  if (rows.length > 4096) throw Error("namespace death process inventory exceeded bound");
  const deadline = Date.now() + 250;
  let inventory = 0;
  for (const pid of rows) {
    if (!/^\d+$/.test(pid)) continue;
    if (Date.now() > deadline) throw Error("namespace task scan exceeded deadline");
    let tasks: string[];
    try {
      tasks = await readdir(`${namespace.procRoot}/${pid}/task`);
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    inventory += tasks.length;
    if (inventory > 8192) throw Error("namespace task inventory exceeded bound");
    for (const tid of tasks) {
      if (!/^\d+$/.test(tid)) continue;
      if (Date.now() > deadline) throw Error("namespace task scan exceeded deadline");
      const status = await readBoundedFile(`${namespace.procRoot}/${pid}/task/${tid}/status`, {
        maxBytes: 16384,
        timeoutMs: 100,
      });
      if (!status.ok) {
        if ("code" in status && ["ENOENT", "ESRCH"].includes(status.code ?? "")) continue;
        throw Error(`namespace task observation unavailable: ${status.detail}`);
      }
      const state = status.text.match(/^State:\s+([A-Z])/m);
      if (!state) throw Error("namespace task status malformed");
      if (!["Z", "X"].includes(state[1])) return false;
    }
  }
  return true;
}
