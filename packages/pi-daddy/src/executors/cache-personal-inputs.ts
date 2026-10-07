/**
 * Bounded Node observations for the operator-approved personal-best-effort-v1 contract.
 * Watchman catch-up + byte/path/metadata/membership fingerprints are NOT atomic freshness or
 * determinism/complete dependency discovery. Undetected mutation/undo, aliases, ACLs, mounts and
 * context changes can escape this profile. Trusted coordinator profiles supply inputs; this is
 * neither a client read endpoint nor authority. Unknown observation returns an explicit bypass.
 * No leases, BPF, new service, by-name immutable claim or persistent reusable state is involved.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readlink } from "node:fs/promises";
import type { BigIntStats, Dir } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { WatchmanBarrier } from "./cache-watchman.ts";

export interface PersonalCacheInput {
  path: string;
  kind: "file" | "directory" | "existence";
}
export interface PersonalInputOptions {
  inputs: readonly PersonalCacheInput[];
  limits: { paths: number; bytes: number; entries: number; ms: number };
  barrier(): Promise<WatchmanBarrier>;
  signal?: AbortSignal;
}
export type PersonalInputSnapshot =
  | { kind: "observed"; contract: "personal-best-effort-v1"; fingerprint: string; epoch: number }
  | { kind: "bypass"; reason: string; cleanup: Promise<void> };

/** Failed closes retain ownership. FileHandles can retry; a failed Dir close has no release proof. */
export class PersonalInputCleanupError extends Error {
  readonly handles: Set<FileHandle>;
  readonly directories: Set<Dir>;
  constructor(handles: Set<FileHandle>, directories: Set<Dir>) {
    super("personal input cleanup unresolved; retain owners");
    this.handles = handles;
    this.directories = directories;
  }
  async retry(): Promise<void> {
    for (const handle of [...this.handles]) {
      await handle.close();
      this.handles.delete(handle);
    }
    // Node may mark Dir closed before reporting an OS error; ERR_DIR_CLOSED is not release proof.
    if (this.directories.size) throw this;
  }
}

function metadata(s: BigIntStats): string[] {
  return [s.dev, s.ino, s.mode, s.uid, s.gid].map(String);
}
function stable(s: BigIntStats): string {
  return JSON.stringify([...metadata(s), String(s.size), String(s.mtimeNs), String(s.ctimeNs)]);
}

export async function snapshotPersonalInputs(options: PersonalInputOptions): Promise<PersonalInputSnapshot> {
  const limits = { ...options.limits },
    inputs = options.inputs.map((value) => ({ ...value }));
  const deadline = performance.now() + limits.ms;
  const observations = new Map<string, string>();
  const handles = new Set<FileHandle>(),
    directories = new Set<Dir>(),
    stopped = new AbortController();
  let bytes = 0,
    entries = 0,
    components = 0;
  function check() {
    if (stopped.signal.aborted || options.signal?.aborted) throw Error("personal input capture cancelled");
    if (performance.now() > deadline) throw Error("personal input capture deadline exceeded");
  }
  function record(kind: string, path: string, value: unknown) {
    const key = JSON.stringify([kind, path]),
      encoded = JSON.stringify(value),
      prior = observations.get(key);
    if (prior !== undefined && prior !== encoded) throw Error("personal input changed during capture");
    observations.set(key, encoded);
  }
  async function synchronized() {
    check();
    const value = await options.barrier();
    check();
    if (!value.fresh || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || !Array.isArray(value.changed))
      throw Error("Watchman observation uncertain or incompatible");
    return { epoch: value.epoch, changed: [...value.changed] };
  }
  async function walk(path: string): Promise<{ path: string; stat: BigIntStats } | undefined> {
    let cursor = "/",
      queue = path.split("/").filter(Boolean),
      links = 0;
    record("metadata", "/", metadata(await lstat("/", { bigint: true })));
    while (queue.length) {
      check();
      if (++components > 4096) throw Error("personal input component limit exceeded");
      const part = queue.shift()!,
        next = cursor === "/" ? "/" + part : cursor + "/" + part;
      let stat: BigIntStats;
      try {
        stat = await lstat(next, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        record("absence", next, true);
        return undefined;
      }
      check();
      record("metadata", next, metadata(stat));
      if (stat.isSymbolicLink()) {
        if (++links > 40) throw Error("personal input symlink limit exceeded");
        const raw = await readlink(next, { encoding: "buffer" });
        const target = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
        if (target.includes("\0") || Buffer.byteLength(target) > 4096)
          throw Error("personal input unsupported symlink");
        if (stable(await lstat(next, { bigint: true })) !== stable(stat))
          throw Error("personal symlink changed during capture");
        record("symlink", next, target);
        if (target.startsWith("/")) cursor = "/";
        queue = [
          ...target.split("/").filter(Boolean),
          ...(target.endsWith("/") && !queue.length ? ["."] : []),
          ...queue,
        ];
        continue;
      }
      if (queue.length && !stat.isDirectory()) throw Error("personal input ancestor is not a directory");
      cursor = next;
    }
    const stat = await lstat(cursor, { bigint: true });
    record("metadata", cursor, metadata(stat));
    if (path.endsWith("/") && !stat.isDirectory()) throw Error("personal trailing slash requires directory");
    return { path: cursor, stat };
  }
  async function file(path: string, observed: BigIntStats) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    handles.add(handle);
    try {
      const before = await handle.stat({ bigint: true });
      check();
      if (!before.isFile() || stable(before) !== stable(observed))
        throw Error("personal input binding changed or unsupported file");
      if (before.size > BigInt(limits.bytes - bytes)) throw Error("personal input byte limit exceeded");
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(65536);
      let size = 0;
      for (;;) {
        check();
        const read = await handle.read(buffer, 0, buffer.length, size);
        check();
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
        size += read.bytesRead;
        if (bytes > limits.bytes) throw Error("personal input byte limit exceeded");
        hash.update(buffer.subarray(0, read.bytesRead));
      }
      if (BigInt(size) !== before.size || stable(await handle.stat({ bigint: true })) !== stable(before))
        throw Error("personal file changed during capture");
      if (stable(await lstat(path, { bigint: true })) !== stable(before))
        throw Error("personal input binding changed during capture");
      record("bytes", path, hash.digest("hex"));
      check();
    } finally {
      await handle.close();
      handles.delete(handle);
    }
  }
  async function directory(path: string, observed: BigIntStats) {
    if (!observed.isDirectory()) throw Error("personal input is not a directory");
    const names: string[][] = [],
      // Node's runtime supports raw Dirent names; the installed DirOptions type omits "buffer".
      // Refuse if a runtime supplies decoded strings instead of raw bytes.
      stream = await opendir(path, { encoding: "buffer" as BufferEncoding });
    directories.add(stream);
    try {
      for (;;) {
        const entry = await stream.read();
        check();
        if (!entry) break;
        if (++entries > limits.entries) throw Error("personal input directory-entry limit exceeded");
        const raw: unknown = entry.name;
        if (!Buffer.isBuffer(raw)) throw Error("personal directory raw-name observation unavailable");
        const name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
        names.push([
          name,
          entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other",
        ]);
      }
    } finally {
      await stream.close();
      directories.delete(stream);
    }
    if (stable(await lstat(path, { bigint: true })) !== stable(observed))
      throw Error("personal directory changed during capture");
    names.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
    record("membership", path, names);
  }
  const task = (async (): Promise<PersonalInputSnapshot> => {
    try {
      if (
        Object.values(limits).some((n) => !Number.isSafeInteger(n) || n <= 0) ||
        limits.paths > 4096 ||
        limits.bytes > 32 * 1024 * 1024 ||
        limits.entries > 100000 ||
        limits.ms > 30000
      )
        throw Error("personal input invalid limits");
      if (!inputs.length || inputs.length > limits.paths) throw Error("personal input path limit exceeded");
      const initial = await synchronized();
      for (const input of inputs) {
        check();
        if (
          typeof input.path !== "string" ||
          !input.path.startsWith("/") ||
          input.path.includes("\0") ||
          Buffer.byteLength(input.path) > 4096 ||
          !["file", "directory", "existence"].includes(input.kind)
        )
          throw Error("personal input unsupported declaration");
        record("declaration", input.path, input.kind);
        const found = await walk(input.path);
        if (!found) continue;
        if (input.kind === "file") await file(found.path, found.stat);
        if (input.kind === "directory") await directory(found.path, found.stat);
      }
      const final = await synchronized();
      if (final.epoch !== initial.epoch || final.changed.length)
        throw Error("Watchman observed change during personal input capture");
      const encoded = JSON.stringify([...observations].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      const fingerprint = createHash("sha256").update(encoded).digest("hex");
      check();
      return { kind: "observed", contract: "personal-best-effort-v1", fingerprint, epoch: final.epoch };
    } catch (error) {
      return { kind: "bypass", reason: `personal-best-effort-v1: ${String(error)}`, cleanup: Promise.resolve() };
    }
  })();
  // Deadline/cancellation returns control without abandoning late opens/reads/iterator cleanup.
  // Coordinator must retain and join cleanup, and close its owned watcher to settle pending barriers.
  const cleanup = task.then(() => {
    if (handles.size || directories.size) throw new PersonalInputCleanupError(handles, directories);
  });
  let timer: ReturnType<typeof setTimeout> | undefined, abort!: () => void;
  const interrupted = new Promise<PersonalInputSnapshot>((resolve) => {
    abort = () => {
      stopped.abort();
      resolve({ kind: "bypass", reason: "personal-best-effort-v1: capture cancelled or deadline exceeded", cleanup });
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    timer = setTimeout(abort, Math.max(0, Math.ceil(deadline - performance.now())));
  });
  try {
    const result = await Promise.race([task, interrupted]);
    if (result.kind === "bypass") return { ...result, cleanup };
    await cleanup;
    return result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
