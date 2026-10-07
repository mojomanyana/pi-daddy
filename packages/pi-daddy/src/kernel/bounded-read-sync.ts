/** Bounded synchronous reads for the synchronous planner/settings seams. */
import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { BoundedReadCleanupError } from "./bounded-read.ts";

export interface SyncReadPorts {
  open: typeof openSync;
  close: typeof closeSync;
  stat: typeof fstatSync;
  read: typeof readSync;
  realpath: (path: string) => string;
}
const ports: SyncReadPorts = {
  open: openSync,
  close: closeSync,
  stat: fstatSync,
  read: readSync,
  realpath: realpathSync,
};
const unresolved = new Set<BoundedReadCleanupError>();
/** Diagnostic owners only: a numeric fd cannot safely be retried after close failed and may have been reused. */
export function unresolvedSyncReadCleanups(): readonly BoundedReadCleanupError[] {
  return [...unresolved];
}
export function readBoundedTextSync(
  path: string,
  options: {
    maxBytes: number;
    timeoutMs?: number;
    prefix?: boolean;
    confinedRoot?: string;
    now?: () => number;
  },
  io: SyncReadPorts = ports,
): { text: string; truncated: boolean; size: number } {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 2_000);
  const fd = io.open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = io.stat(fd);
    if (!stat.isFile()) throw new Error("not a regular file");
    // Linux /proc resolves the held object, including ancestor substitutions between realpath and open.
    // If this proof is unavailable, named context files are refused rather than trusting the earlier path.
    if (options.confinedRoot) {
      const held = io.realpath(`/proc/self/fd/${fd}`);
      const within = relative(options.confinedRoot, held);
      if (!within || within === ".." || within.startsWith("../") || isAbsolute(within))
        throw new Error("held file is outside this session's working directory");
    }
    if (!options.prefix && stat.size > options.maxBytes) throw new Error("file exceeds byte limit");
    const bytes = Buffer.alloc(options.maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      if (now() > deadline) throw new Error("bounded read timed out");
      const count = io.read(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!count) break;
      offset += count;
    }
    const truncated = offset > options.maxBytes;
    if (truncated && !options.prefix) throw new Error("file grew beyond byte limit");
    // stream:true accepts only an incomplete final codepoint at a deliberately truncated boundary.
    // Malformed bytes in the retained prefix still throw; valid replacement characters remain intact.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, Math.min(offset, options.maxBytes)),
        { stream: truncated },
      );
    } catch (cause) {
      throw new Error("invalid UTF-8", { cause });
    }
    return { text, truncated, size: stat.size };
  } finally {
    try {
      io.close(fd);
    } catch (cause) {
      let failure: BoundedReadCleanupError;
      failure = new BoundedReadCleanupError(cause, async () => {
        throw failure;
      });
      failure.message =
        "synchronous reader close failed; descriptor ownership is unresolved; automatic retry is unsafe";
      unresolved.add(failure);
      throw failure;
    }
  }
}
