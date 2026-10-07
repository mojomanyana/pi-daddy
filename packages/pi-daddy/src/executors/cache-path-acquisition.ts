/** Owned, bounded Linux resolution OBSERVATIONS. Pins and sampled stat metadata do NOT
 * establish a coherent name/access vector, ACL coverage, freshness or command eligibility.
 * Node owns policy/walking; the trusted internal held-target reader performs OS readlinkat.
 * No by-name readlink fallback. Endpoint pins feed existing byte capture; observers can
 * later cover all parents/endpoints. Coverage is not armed by this acquisition operation.
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { HeldSymlinkCleanupError } from "./cache-held-symlink.ts";
export interface PathAcquisitionOptions {
  cwd: string;
  paths: readonly string[];
  /** Opt-in first ENOENT binding observations, never access/freshness certificates. */
  observeMissing?: boolean;
  limits: { maxPaths: number; maxObjects: number; maxComponents: number; maxSymlinks: number; timeoutMs: number };
  /** Trusted internal OS reader only, not an authority or validation callback. */
  readLink(input: { fd: number; dev: bigint; ino: bigint }): Promise<Buffer>;
  signal?: AbortSignal;
}
export interface PathObject {
  readonly fd: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly kind: "file" | "directory" | "symlink";
  readonly mode: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
}
export interface PathAbsence {
  readonly path: string;
  readonly parent: number;
  readonly name: string;
  /** Unwalked suffix after the first missing component (possibly in a symlink target). */
  readonly remaining: readonly string[];
}
export interface OwnedPathObservations {
  readonly objects: readonly PathObject[];
  readonly edges: readonly { readonly parent: number; readonly name: string; readonly child: number }[];
  readonly endpoints: readonly { readonly path: string; readonly object: number }[];
  /** Sampled ENOENT from component open; no object/access claim for an unwalked suffix. */
  readonly absences: readonly PathAbsence[];
  /** Sampled immutable-inode target bytes, copied on every access. NOT current name binding. */
  copyLinkTarget(object: number): Buffer;
  release(): Promise<void>;
}
export class PathAcquisitionCleanupError extends AggregateError {
  readonly cleanup: () => Promise<void>;
  constructor(errors: unknown[], cleanup: () => Promise<void>, cause?: unknown) {
    super(errors, "path acquisition cleanup unresolved; owned retry required", { cause });
    this.cleanup = cleanup;
  }
}
class Refused extends Error {}
class MissingBinding extends Error {}
const O_PATH = 0x200000;
export async function acquireOwnedPaths(
  options: PathAcquisitionOptions,
): Promise<{ kind: "observed"; owner: OwnedPathObservations } | { kind: "bypass"; reason: string }> {
  const limits = { ...options.limits },
    paths = [...options.paths],
    { cwd, signal, readLink, observeMissing } = options;
  if (observeMissing !== undefined && typeof observeMissing !== "boolean")
    return { kind: "bypass", reason: "path acquisition invalid observeMissing" };
  const canonical = (path: string) =>
    path.length <= 4096 &&
    /^[A-Za-z0-9_./-]+$/.test(path) &&
    path !== "/" &&
    path
      .replace(/^\//, "")
      .split("/")
      .every((p) => p && p.length <= 255 && p !== "." && p !== "..");
  for (const field of ["maxPaths", "maxObjects", "maxComponents", "maxSymlinks", "timeoutMs"] as const) {
    if (!Number.isSafeInteger(limits[field]) || limits[field] <= 0)
      return { kind: "bypass", reason: `path acquisition invalid ${field}` };
  }
  if (limits.maxObjects > 4096 || limits.maxPaths > 64 || limits.maxComponents > 8192 || limits.maxSymlinks > 40)
    return { kind: "bypass", reason: "path acquisition limits exceed supported capacity" };
  if (process.platform !== "linux")
    return { kind: "bypass", reason: "path acquisition requires Linux descriptor resolution" };
  if (
    !cwd.startsWith("/") ||
    (cwd !== "/" && !canonical(cwd)) ||
    !paths.length ||
    paths.length > limits.maxPaths ||
    paths.some((p) => !canonical(p))
  )
    return { kind: "bypass", reason: "path acquisition unsupported cwd/path grammar or count" };
  const deadline = performance.now() + limits.timeoutMs;
  const handles: { file?: FileHandle }[] = [],
    objects: PathObject[] = [],
    edges: { parent: number; name: string; child: number }[] = [],
    endpoints: { path: string; object: number }[] = [],
    absences: PathAbsence[] = [];
  const targets = new Map<number, Buffer>(),
    pendingStops: (() => Promise<void>)[] = [];
  let components = 0,
    symlinks = 0,
    retired = false,
    cleaning: Promise<void> | undefined;
  const checkWork = () => {
    if (signal?.aborted) throw new Refused("path acquisition aborted between operations");
    if (performance.now() > deadline) throw new Refused("path acquisition time budget exceeded between operations");
  };
  const cleanup = async (cause?: unknown): Promise<void> => {
    retired = true;
    targets.clear();
    if (cleaning) return cleaning;
    cleaning = (async () => {
      const errors: unknown[] = [];
      for (let index = pendingStops.length - 1; index >= 0; index--) {
        try {
          await pendingStops[index]();
          pendingStops.splice(index, 1);
        } catch (error) {
          errors.push(error);
        }
      }
      // Preserve pins as evidence until a failed OS reader's termination is reconciled.
      if (!errors.length)
        for (const slot of [...handles].reverse()) {
          if (!slot.file) continue;
          try {
            await slot.file.close();
            slot.file = undefined;
          } catch (error) {
            errors.push(error);
          }
        }
      if (errors.length) throw new PathAcquisitionCleanupError(errors, () => cleanup(cause), cause);
    })();
    try {
      await cleaning;
    } finally {
      cleaning = undefined;
    }
  };
  const pin = async (path: string): Promise<number> => {
    checkWork();
    const slot: { file?: FileHandle } = {};
    handles.push(slot);
    try {
      slot.file = await open(path, O_PATH | constants.O_NOFOLLOW);
    } catch (error) {
      // Only this open's ENOENT describes a failed binding, never later stat/reader errors.
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new MissingBinding("path component open returned ENOENT", { cause: error });
      throw error;
    }
    const st = await slot.file.stat({ bigint: true });
    const kind = st.isFile() ? "file" : st.isDirectory() ? "directory" : st.isSymbolicLink() ? "symlink" : undefined;
    if (!kind) throw new Refused("path acquisition unsupported special object");
    // dev/ino equality is NOT traversal-context equality: bind mounts can differ in '..'
    // and access flags. Preserve every lookup pin. Only byte guards may deduplicate inodes.
    if (objects.length === limits.maxObjects) throw new Refused("path acquisition maxObjects exceeded");
    const object = objects.length;
    objects.push(
      Object.freeze({ fd: slot.file.fd, dev: st.dev, ino: st.ino, kind, mode: st.mode, uid: st.uid, gid: st.gid }),
    );
    checkWork();
    return object;
  };
  const walk = async (start: number, names: string[], requestedPath?: string): Promise<number | undefined> => {
    let current = start;
    const queue = [...names];
    while (queue.length) {
      checkWork();
      if (++components > limits.maxComponents) throw new Refused("path acquisition maxComponents exceeded");
      if (objects[current].kind !== "directory") throw new Refused("path acquisition nondirectory resolution ancestor");
      const name = queue.shift()!;
      if (name.length > 255) throw new Refused("path acquisition target component exceeds byte bound");
      let child: number;
      try {
        child = await pin(`/proc/self/fd/${objects[current].fd}/${name}`);
      } catch (error) {
        if (!(error instanceof MissingBinding) || !observeMissing || requestedPath === undefined) throw error;
        checkWork();
        absences.push(
          Object.freeze({ path: requestedPath, parent: current, name, remaining: Object.freeze([...queue]) }),
        );
        return undefined;
      }
      edges.push(Object.freeze({ parent: current, name, child }));
      if (objects[child].kind !== "symlink") {
        current = child;
        continue;
      }
      if (++symlinks > limits.maxSymlinks) throw new Refused("path acquisition maxSymlinks exceeded");
      let target = targets.get(child);
      if (!target) {
        try {
          target = Buffer.from(await readLink(objects[child]));
        } catch (error) {
          if (error instanceof HeldSymlinkCleanupError) pendingStops.push(error.stop);
          throw error;
        }
        if (!target.length || target.length > 4096 || [...target].some((b) => b < 33 || b > 126))
          throw new Refused("path acquisition unsupported target bytes");
        targets.set(child, target);
      }
      const spelling = target.toString("ascii");
      // Preserve dot/dotdot and trailing slash semantics from an owned target; don't normalize.
      const targetNames = spelling.split("/").filter(Boolean);
      if (spelling.endsWith("/")) targetNames.push(".");
      if (spelling.startsWith("/")) current = 0;
      queue.unshift(...targetNames);
      checkWork();
    }
    return current;
  };
  try {
    assertDirectory(await pin("/"));
    const working = cwd === "/" ? 0 : await walk(0, cwd.slice(1).split("/"));
    assertDirectory(working);
    for (const path of paths) {
      const object = await walk(path.startsWith("/") ? 0 : working, path.replace(/^\//, "").split("/"), path);
      if (object === undefined) continue;
      if (objects[object].kind !== "file") throw new Refused("path acquisition endpoint is not a regular file");
      endpoints.push(Object.freeze({ path, object }));
      checkWork();
    }
    const owner: OwnedPathObservations = Object.freeze({
      objects: Object.freeze(objects),
      edges: Object.freeze(edges),
      endpoints: Object.freeze(endpoints),
      absences: Object.freeze(absences),
      copyLinkTarget(object: number) {
        if (retired) throw new Error("path acquisition owner is released or retired");
        const target = targets.get(object);
        if (!target) throw new Error("path acquisition unknown symlink object");
        return Buffer.from(target);
      },
      release: () => cleanup(),
    });
    return { kind: "observed", owner };
  } catch (error) {
    await cleanup(error);
    if (error instanceof Refused) return { kind: "bypass", reason: error.message };
    throw new Error("path acquisition operation failed", { cause: error });
  }
  function assertDirectory(object: number | undefined): asserts object is number {
    if (object === undefined || objects[object].kind !== "directory")
      throw new Refused("path acquisition root/cwd is not a directory");
  }
}
