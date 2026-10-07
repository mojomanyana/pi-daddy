/**
 * One bounded reader for the operator-authored files this package reads at SESSION START.
 *
 * **Why this is a module rather than a pattern to copy.** `loadWorkspaceRegistry` worked out the correct
 * shape the expensive way — R-79 hung forever on a FIFO, a `stat`-then-`readFile` rewrite reintroduced the
 * hang through a TOCTOU, and `AbortSignal.timeout` turned out never to interrupt a libuv read. That comment
 * block ends with "One reader is why that cannot happen again", and then a second session-start read
 * (`loadDefinitions`, reading each `SKILL.md`) went on using a bare `readFile`. The guards were not copied
 * because copying them correctly is exactly what the registry's own history says nobody manages.
 *
 * What the shape buys, restated once here so neither caller has to:
 *
 *  - `O_NONBLOCK` on the open. A FIFO blocks inside `open(2)` before any read starts, so a signal or a
 *    deadline checked between chunks can never rescue it; a non-blocking open returns instead.
 *  - every check against the HELD DESCRIPTOR. `stat` by name followed by a read by name is a TOCTOU, and the
 *    attacker is any process at the same uid — swapping a regular file for a FIFO between the two hangs the
 *    reader. `fstat` on a descriptor has no name left to re-resolve.
 *  - a deadline checked BETWEEN chunks, which is all an `AbortSignal` ever managed. Its honest limit: a
 *    stalled open or a single wedged read cannot be interrupted from in-process.
 *  - a size bound checked twice, before the read from `fstat` and again after, because a file can grow
 *    between the two. **The buffer is `maxBytes + 1` regardless of the file's size, and that is deliberate.**
 *    Review proposed sizing it from `fstat` instead; that would be faster and would silently break the second
 *    check, because a file whose reported size understates its content — anything under procfs, and any file
 *    that grows — would fill its small buffer exactly and come back as a successful truncated read. The cost
 *    was measured rather than assumed: 500 allocations of 1 MiB + 1 take 8.1ms for an RSS delta of 2.8 MB,
 *    because `allocUnsafe` never touches the pages.
 *
 * **The clock is injected** so the deadline is forced by a test rather than by a reviewer. Before this
 * module the registry's deadline could be deleted outright and all 876 tests still passed (measured at
 * `7096f78`), which is rule 7's "a test that cannot fail is worse than no test" with the production change
 * named: delete the `now() > deadline` branch below and `bounded-read.test.ts` fails.
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

/** Explicitly trusted per-read I/O ports, never requester/environment input. */
export interface BoundedReadPorts {
  open(path: string, flags: number): Promise<FileHandle>;
  read(
    handle: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(handle: FileHandle): Promise<void>;
}
/** A failed read stays failed even after this explicit recovery capability succeeds. */
export class BoundedReadCleanupError extends Error {
  readonly cleanup: () => Promise<void>;
  /** Latest physical failure, including falsy rejections; cause remains the original failure. */
  lastCause: unknown;
  constructor(cause: unknown, cleanup: () => Promise<void>) {
    super("bounded reader descriptor cleanup unresolved; retain and explicitly retry", { cause });
    this.name = "BoundedReadCleanupError";
    this.lastCause = cause;
    this.cleanup = cleanup;
  }
}

const retained = new Set<BoundedReadCleanup>();
/** Trusted diagnostics/recovery only; not admission, a quota, or a Root-wide shutdown join. */
export function retainedBoundedReadCleanups(): readonly BoundedReadCleanupOwner[] {
  return [...retained];
}
export interface BoundedReadCleanupOwner {
  readonly handle: FileHandle | undefined;
  cleanup(): Promise<void>;
}
class BoundedReadCleanup implements BoundedReadCleanupOwner {
  private held: FileHandle | undefined;
  private active?: Promise<void>;
  private failure?: BoundedReadCleanupError;
  private finish!: () => void;
  private readonly reading = new Promise<void>((resolve) => (this.finish = resolve));
  private readonly close: BoundedReadPorts["close"];
  constructor(close: BoundedReadPorts["close"]) {
    this.close = close;
    retained.add(this);
  }
  acquired(handle: FileHandle) {
    this.held = handle;
  }
  get handle() {
    return this.held;
  }
  readSettled() {
    this.finish();
  }
  cleanup(): Promise<void> {
    if (this.active) return this.active;
    // Publish before calling any trusted port: reentrant/concurrent cleanup shares this operation.
    const operation = this.reading.then(async () => {
      if (!this.held) {
        retained.delete(this);
        return;
      }
      try {
        await this.close(this.held);
      } catch (cause) {
        this.failure ??= new BoundedReadCleanupError(cause, () => this.cleanup());
        this.failure.lastCause = cause;
        throw this.failure;
      }
      this.held = undefined;
      retained.delete(this);
    });
    this.active = operation;
    void operation.then(
      () => {
        this.active = undefined;
      },
      () => {
        this.active = undefined;
      },
    );
    return operation;
  }
}

const boundedReadPorts: BoundedReadPorts = {
  open,
  read: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
  close: (handle) => handle.close(),
};

export interface BoundedReadLimits {
  /** Refuse anything at or over this, before allocating it. */
  maxBytes: number;
  /** How long the chunk loop may run before the read is a refusal rather than a wait. */
  timeoutMs: number;
  /** Injected only by tests; production passes nothing and gets the wall clock. */
  now?: () => number;
}

/**
 * Why a bounded read did not produce text.
 *
 * A discriminated reason rather than a thrown error, because the two callers disagree about what a failure
 * MEANS — an unreadable registry is a governance refusal naming the file, while an unreadable `SKILL.md` is
 * one definition that will not be offered — and a shared reader must not decide that for them.
 */
export type BoundedReadFailure =
  | { why: "unopenable"; detail: string; code?: string }
  | { why: "not-a-regular-file"; detail: string }
  | { why: "too-large"; detail: string; size: number }
  | { why: "grew-while-reading"; detail: string }
  | { why: "timed-out"; detail: string }
  | { why: "unreadable"; detail: string; code?: string };

export type BoundedReadResult = { ok: true; text: string } | ({ ok: false } & BoundedReadFailure);
export type BoundedReadBytes = { ok: true; bytes: Buffer } | ({ ok: false } & BoundedReadFailure);

/**
 * The same read, handing back raw bytes.
 *
 * `skill-packages.ts` needs the bytes rather than a string, because it asserts that a definition survives a
 * UTF-8 round trip unchanged — a latin-1 byte that decodes to U+FFFD changes the file's digest, and that
 * check is only possible against the original buffer. Decoding here and re-encoding there would defeat it.
 */
export async function readBoundedFile(
  path: string,
  limits: BoundedReadLimits,
  ports: BoundedReadPorts = boundedReadPorts,
): Promise<BoundedReadResult> {
  const read = await readBoundedBytes(path, limits, ports);
  return read.ok ? { ok: true, text: read.bytes.toString("utf8") } : read;
}

/** Preserve typed I/O evidence; a caller must not classify absence by searching diagnostic prose. */
function ioCode(error: unknown): { code?: string } {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
    return { code: error.code };
  return {};
}

export function readBoundedBytes(
  path: string,
  limits: BoundedReadLimits,
  ports: BoundedReadPorts = boundedReadPorts,
): Promise<BoundedReadBytes> {
  return readBoundedRange(path, limits, ports, false);
}
/** Bounded tail of a regular file, using the same held descriptor for size, range and serialized close.
 * Large files are permitted; no pathname reopen or whole-file fallback. Concurrent size changes refuse.
 * Like full reads, a wedged individual filesystem operation cannot be interrupted in-process. */
export function readBoundedTailBytes(
  path: string,
  limits: BoundedReadLimits,
  ports: BoundedReadPorts = boundedReadPorts,
): Promise<BoundedReadBytes> {
  return readBoundedRange(path, limits, ports, true);
}
async function readBoundedRange(
  path: string, limits: BoundedReadLimits, ports: BoundedReadPorts, tail: boolean,
): Promise<BoundedReadBytes> {
  const now = limits.now ?? Date.now;
  let handle: FileHandle;
  const cleanup = new BoundedReadCleanup((held) => ports.close(held));
  try {
    handle = await ports.open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    cleanup.acquired(handle);
  } catch (error) {
    cleanup.readSettled();
    await cleanup.cleanup();
    return { ok: false, why: "unopenable", detail: String(error), ...ioCode(error) };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile())
      return {
        ok: false,
        why: "not-a-regular-file",
        detail: `${path} is not a regular file — a FIFO, device or socket here would block rather than fail`,
      };
    if (!tail && info.size > limits.maxBytes)
      return {
        ok: false,
        why: "too-large",
        size: info.size,
        detail: `${path} is ${info.size} bytes, over the ${limits.maxBytes} limit`,
      };

    const deadline = now() + limits.timeoutMs;
    const buffer = Buffer.allocUnsafe(limits.maxBytes + 1);
    const start = tail ? Math.max(0, info.size - limits.maxBytes) : 0;
    const length = tail ? Math.min(info.size, limits.maxBytes) : buffer.length;
    let filled = 0;
    while (filled < length) {
      if (now() > deadline)
        return {
          ok: false,
          why: "timed-out",
          detail: `${path} did not finish reading within ${limits.timeoutMs}ms`,
        };
      const { bytesRead } = await ports.read(handle, buffer, filled, length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > limits.maxBytes)
      return {
        ok: false,
        why: "grew-while-reading",
        detail: `${path} exceeded the ${limits.maxBytes} limit while being read — it grew after its size was checked`,
      };
    if (tail && (filled !== length || (await handle.stat()).size !== info.size))
      return { ok: false, why: "grew-while-reading", detail: `${path} changed size during tail read` };
    return { ok: true, bytes: buffer.subarray(0, filled) };
  } catch (error) {
    return { ok: false, why: "unreadable", detail: String(error), ...ioCode(error) };
  } finally {
    cleanup.readSettled();
    await cleanup.cleanup();
  }
}
